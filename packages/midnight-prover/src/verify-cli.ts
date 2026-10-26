import { isAbsolute } from "node:path";
import { RealMidnightProver, NativeVerifierConfigurationError } from "./real-prover.js";

const MAX_INPUT_BYTES = 4 * 1024 * 1024;

async function main(): Promise<void> {
  const artifactsDir = process.env["MIDNIGHT_ARTIFACT_REGISTRY"];
  const nativeFlag = process.argv.indexOf("--native-verifier");
  const nativeVerifierPath = nativeFlag >= 0 ? process.argv[nativeFlag + 1] : process.env["MIDNIGHT_NATIVE_VERIFIER"];
  if (!artifactsDir || !nativeVerifierPath || !isAbsolute(artifactsDir) || !isAbsolute(nativeVerifierPath)) throw new NativeVerifierConfigurationError("configuration");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Buffer);
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) throw new Error("Oversized verification request");
    chunks.push(bytes);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { proof?: unknown; expected?: { contextDigest?: unknown; commitment?: unknown } };
  if (typeof input.proof !== "string" || !input.expected || typeof input.expected.contextDigest !== "string" || typeof input.expected.commitment !== "string") throw new Error("Malformed verification request");
  const proofBytes = Buffer.from(input.proof, "base64");
  if (proofBytes.toString("base64") !== input.proof) throw new Error("Malformed proof encoding");
  const proof = JSON.parse(proofBytes.toString("utf8")) as { proofType?: unknown; publicInputs?: { contextDigest?: unknown; commitment?: unknown } };
  if (proof.proofType !== "lease-capability-v1" || proof.publicInputs?.contextDigest !== input.expected.contextDigest || proof.publicInputs.commitment !== input.expected.commitment) throw new Error("Capability context mismatch");
  const prover = new RealMidnightProver({ artifactsDir, nativeVerifierPath, paramsDir: artifactsDir });
  const valid = await prover.verify(proof);
  process.stdout.write(JSON.stringify(valid ? { valid: true, contextDigest: input.expected.contextDigest, commitment: input.expected.commitment } : { valid: false }) + "\n");
  if (!valid) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const configuration = error instanceof NativeVerifierConfigurationError;
  process.stdout.write(JSON.stringify(configuration ? { valid: false, code: "configuration-error" } : { valid: false }) + "\n");
  process.exitCode = configuration ? 2 : 1;
  process.stderr.write(configuration ? "Native Midnight verifier configuration error\n" : "Malformed or invalid verification request\n");
});
