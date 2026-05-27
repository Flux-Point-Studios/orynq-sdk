/**
 * Cross-language byte-pinning harness for ai_capability_observation_v1.
 *
 * Reads a JSON record from stdin, prints to stdout (one line each):
 *   PRE_IMAGE_HEX <hex>
 *   CONTENT_HASH <hex>
 *   SCHEMA_HASH <hex>
 *
 * The Python test in `test_ai_capability_observation_v1_cross_lang.py`
 * invokes this script via tsx and asserts byte-equality against the
 * Python encoder's output. The TS encoder is the single source of truth
 * for the wire format; this harness exposes it as a stdin/stdout filter
 * so pytest can call it without npm-resolving the package.
 *
 * NOT shipped as a runtime artefact — strictly a tests harness invoked by
 * pytest. No network I/O, no side effects beyond stdout.
 */

import { createHash } from "node:crypto";
import {
  SCHEMA_HASH_HEX,
  canonicalCborPreImage,
} from "../../packages/anchors-materios/src/schemas/ai_capability_observation_v1.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const record = JSON.parse(raw);
  const pre = canonicalCborPreImage(record);
  const contentHash = createHash("sha256").update(pre).digest("hex");
  process.stdout.write(`PRE_IMAGE_HEX ${Buffer.from(pre).toString("hex")}\n`);
  process.stdout.write(`CONTENT_HASH ${contentHash}\n`);
  process.stdout.write(`SCHEMA_HASH ${SCHEMA_HASH_HEX}\n`);
}

main().catch((e) => {
  process.stderr.write(
    `harness error: ${e instanceof Error ? e.stack : String(e)}\n`,
  );
  process.exit(1);
});
