import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RealMidnightProver, NativeVerifierConfigurationError, type CapabilityProof } from "../src/real-prover.js";
import { withTtl } from "./tampering.js";

// A genuine proveCapability envelope over synthetic inputs. The ledger WASM decodes it but cannot check
// its proof, so these cases fix the clock inside or outside its window and stand in for the native verifier.
const envelope = JSON.parse(await readFile(resolve(import.meta.dirname, "fixtures/capability-envelope.json"), "utf8")) as CapabilityProof;
const { notAfter } = envelope.publicInputs;
const artifactsDir = resolve(import.meta.dirname, "../managed");
let directory: string;

async function proverWithNativeVerdict(verdict: { valid: boolean; code: string }): Promise<RealMidnightProver> {
  const path = join(directory, `${verdict.code}.mjs`);
  await writeFile(path, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => console.log(${JSON.stringify(JSON.stringify(verdict))}));\n`);
  await chmod(path, 0o755);
  return new RealMidnightProver({ artifactsDir, nativeVerifierPath: path, paramsDir: artifactsDir });
}

async function proverWithProgram(name: string, source: string, trustedArtifacts = artifactsDir): Promise<RealMidnightProver> {
  const path = join(directory, `${name}.mjs`);
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`);
  await chmod(path, 0o755);
  return new RealMidnightProver({ artifactsDir: trustedArtifacts, nativeVerifierPath: path, paramsDir: trustedArtifacts });
}

const verified = { valid: true, code: "verified" };
const atSeconds = (seconds: number) => vi.setSystemTime(seconds * 1000);

describe("native verification gate", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "orynq-native-gate-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts the recorded envelope inside its window when native verification accepts it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    atSeconds(notAfter - 600);
    expect(await (await proverWithNativeVerdict(verified)).verify(envelope)).toBe(true);
  });

  it("rejects an envelope that decodes cleanly when native verification finds the proof invalid", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    atSeconds(notAfter - 600);
    expect(await (await proverWithNativeVerdict({ valid: false, code: "invalid-proof" })).verify(envelope)).toBe(false);
  });

  it("surfaces a missing executable as configuration failure instead of an invalid proof", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); atSeconds(notAfter - 600);
    const prover = new RealMidnightProver({ artifactsDir, nativeVerifierPath: join(directory, "missing-verifier"), paramsDir: artifactsDir });
    await expect(prover.verify(envelope)).rejects.toMatchObject({ name: "NativeVerifierConfigurationError", reason: "spawn" });
  });

  it("surfaces missing trusted decoding artifacts after a completed native acceptance", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); atSeconds(notAfter - 600);
    const prover = await proverWithProgram("missing-decoder", 'process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({valid:true,code:"verified"})));', join(directory, "missing-artifacts"));
    await expect(prover.verify(envelope)).rejects.toBeInstanceOf(NativeVerifierConfigurationError);
  });

  it.each([
    ["configuration-exit", 'process.stdin.resume(); process.stdin.on("end", () => { console.log(JSON.stringify({valid:false,code:"configuration-error"})); process.exit(2); });'],
    ["early-configuration-exit", 'process.exit(2);'],
    ["unexpected-exit", 'process.stdin.resume(); process.stdin.on("end", () => process.exit(1));'],
    ["malformed-protocol", 'process.stdin.resume(); process.stdin.on("end", () => console.log("not a verdict"));'],
    ["truncated-protocol", 'process.stdin.resume(); process.stdin.on("end", () => {});'],
    ["configuration-verdict", 'process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({valid:false,code:"configuration-error"})));'],
    ["oversized-protocol", 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("x".repeat(5000)));'],
  ])("separates operational %s from completed invalid-proof verdicts", async (name, source) => {
    vi.useFakeTimers({ toFake: ["Date"] }); atSeconds(notAfter - 600);
    const prover = await proverWithProgram(name, source);
    await expect(prover.verify(envelope)).rejects.toBeInstanceOf(NativeVerifierConfigurationError);
  });

  it("sends only the three native statement fields, ignoring old informational envelope clocks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); atSeconds(notAfter - 600);
    const prover = await proverWithProgram("request-shape", 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { const keys=Object.keys(JSON.parse(data)).sort(); if(JSON.stringify(keys)!==JSON.stringify(["circuitId","referenceStateBase64","transactionBase64"])) process.exit(2); console.log(JSON.stringify({valid:true,code:"verified"})); });');
    expect(await prover.verify({ ...envelope, verificationTimeUnixSeconds: 0 })).toBe(true);
  });

  it("reports CLI verifier outages with exit 2 and a bounded credential-free diagnostic", async () => {
    const secretPath = join(directory, "synthetic-private-verifier-name");
    const requestProof = { ...envelope, publicInputs: { ...envelope.publicInputs, notAfter: Math.floor(Date.now() / 1000) + 600 } };
    const input = JSON.stringify({ proof: Buffer.from(JSON.stringify(requestProof)).toString("base64"), expected: { contextDigest: envelope.publicInputs.contextDigest, commitment: envelope.publicInputs.commitment } });
    const result = await new Promise<{ code: number | string | undefined; stdout: string; stderr: string }>(resolveResult => {
      const child = execFile(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "../src/verify-cli.ts"), "--native-verifier", secretPath], { env: { ...process.env, MIDNIGHT_ARTIFACT_REGISTRY: artifactsDir } }, (error, stdout, stderr) => resolveResult({ code: error?.code, stdout, stderr }));
      child.stdin!.end(input);
    });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ valid: false, code: "configuration-error" });
    expect(result.stderr).toBe("Native Midnight verifier configuration error\n");
    expect(result.stderr).not.toContain(secretPath);
  });

  it("rejects a refreshed TTL after the proved deadline even though native verification accepts it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    atSeconds(notAfter + 1);
    expect(await (await proverWithNativeVerdict(verified)).verify(withTtl(envelope, notAfter + 1800))).toBe(false);
  });

  it("rejects a deadline more than an hour away even when the TTL is within the ledger's bound", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    atSeconds(notAfter - 3601);
    expect(await (await proverWithNativeVerdict(verified)).verify(withTtl(envelope, notAfter - 3000))).toBe(false);
  });

  it("rejects a claimed deadline that differs from the proved one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    atSeconds(notAfter - 600);
    const prover = await proverWithNativeVerdict(verified);
    expect(await prover.verify({ ...envelope, publicInputs: { ...envelope.publicInputs, notAfter: notAfter - 1 } })).toBe(false);
  });
});
