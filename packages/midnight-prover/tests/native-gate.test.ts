import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RealMidnightProver, type CapabilityProof } from "../src/real-prover.js";
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
