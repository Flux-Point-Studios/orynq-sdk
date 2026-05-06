/**
 * Cross-language byte-pinning harness for compute_metering_v2.
 *
 * Reads a JSON record from stdin, prints to stdout (one line each):
 *   FLEET_PRE_HEX <hex>
 *   WORKER_PRE_HEX <hex>
 *   CONTENT_HASH <hex>
 *   SCHEMA_HASH <hex>
 *
 * The Python test in `test_v2_cross_lang.py` invokes this script via tsx and
 * asserts byte-equality against the Python encoder's output. This is the
 * SOLE existence-reason for Team 1: the worker SDK (Python) and gateway
 * validator (TS) must produce identical canonical CBOR bytes, otherwise
 * gateway-validates-but-worker-can't-sign (or vice versa).
 *
 * NOT shipped as a runtime artefact — strictly a tests harness invoked by
 * pytest. No network I/O, no side effects beyond stdout.
 */

import {
  canonicalCborForFleetOpSig,
  canonicalCborForWorkerSig,
  canonicalContentHash,
  SCHEMA_HASH_HEX,
} from "../../../services/blob-gateway/src/schemas/compute_metering_v2.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const record = JSON.parse(raw);
  const fleetPre = canonicalCborForFleetOpSig(record.worker_id, record.hardware_spec);
  const workerPre = canonicalCborForWorkerSig({
    schema_version: "compute_metering_v2",
    worker_id: record.worker_id,
    tenant_id: record.tenant_id,
    period_start_ms: record.period_start_ms,
    period_end_ms: record.period_end_ms,
    metrics: record.metrics,
    hardware_spec: record.hardware_spec,
    worker_pubkey: record.worker_pubkey,
  });
  const contentHash = canonicalContentHash({
    schema_version: "compute_metering_v2",
    worker_id: record.worker_id,
    tenant_id: record.tenant_id,
    period_start_ms: record.period_start_ms,
    period_end_ms: record.period_end_ms,
    metrics: record.metrics,
    hardware_spec: record.hardware_spec,
    worker_pubkey: record.worker_pubkey,
  });
  process.stdout.write(`FLEET_PRE_HEX ${Buffer.from(fleetPre).toString("hex")}\n`);
  process.stdout.write(`WORKER_PRE_HEX ${Buffer.from(workerPre).toString("hex")}\n`);
  process.stdout.write(`CONTENT_HASH ${contentHash}\n`);
  process.stdout.write(`SCHEMA_HASH ${SCHEMA_HASH_HEX}\n`);
}

main().catch((e) => {
  process.stderr.write(`harness error: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
