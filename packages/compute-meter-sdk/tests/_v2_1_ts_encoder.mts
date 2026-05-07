/**
 * Cross-language byte-pinning harness for compute_metering_v2.1.
 *
 * Reads JSON `{record, evidence}` from stdin, prints (one line each):
 *   WORKER_PRE_HEX <hex>      — canonical-CBOR bytes of the worker pre-image
 *   CONTENT_HASH <hex>        — sha256 of WORKER_PRE_HEX
 *   EV_HASH <hex>             — sha256 of canonical-CBOR(evidence array)
 *   SCHEMA_HASH_V2_1 <hex>    — pinned constant
 *
 * The Python tests in `test_v2_1_cross_lang.py` invoke this script via tsx
 * and assert byte-equality vs the Python encoder. Same harness shape as
 * `_v2_ts_encoder.mts`, extended to take an `evidence` array.
 */

import {
  canonicalCborForWorkerSig,
  attestationEvidenceHash,
  SCHEMA_HASH_V2_1_HEX,
  type AttestationEvidenceEntry,
} from "../../../services/blob-gateway/src/schemas/compute_metering_v2.ts";
import { createHash } from "crypto";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

interface Input {
  record: {
    schema_version: string;
    worker_id: string;
    tenant_id: string;
    period_start_ms: number;
    period_end_ms: number;
    metrics: Record<string, number>;
    hardware_spec: Record<string, unknown>;
    worker_pubkey: string;
  };
  evidence?: AttestationEvidenceEntry[];
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as Input;
  const recForSig = {
    schema_version: "compute_metering_v2" as const,
    worker_id: input.record.worker_id,
    tenant_id: input.record.tenant_id,
    period_start_ms: input.record.period_start_ms,
    period_end_ms: input.record.period_end_ms,
    metrics: input.record.metrics as never,
    hardware_spec: input.record.hardware_spec as never,
    worker_pubkey: input.record.worker_pubkey,
  };
  const evidence = input.evidence ?? [];
  const workerPre = canonicalCborForWorkerSig(recForSig, evidence);
  const contentHash = createHash("sha256")
    .update(workerPre)
    .digest("hex");
  const evHash = attestationEvidenceHash(evidence);
  process.stdout.write(`WORKER_PRE_HEX ${Buffer.from(workerPre).toString("hex")}\n`);
  process.stdout.write(`CONTENT_HASH ${contentHash}\n`);
  process.stdout.write(`EV_HASH ${evHash}\n`);
  process.stdout.write(`SCHEMA_HASH_V2_1 ${SCHEMA_HASH_V2_1_HEX}\n`);
}

main().catch((e) => {
  process.stderr.write(`harness error: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
