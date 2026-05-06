# materios-compute-meter

Worker signing identity SDK for Materios verifiable compute metering.

Compute workers (K8s pods, VMs, containers) use this SDK to sign metering
records and POST them to the Materios blob gateway. The gateway validates
the signature, records the canonical content hash, and forwards the
receipt to the Materios chain via the existing sponsored-receipt
pipeline.

This package lives inside the `orynq-sdk` monorepo so the Python SDK and
the TypeScript gateway validator (`services/blob-gateway/src/schemas/
compute_metering_v1.ts`) stay byte-pinned together. CI verifies the
canonical CBOR encoders agree across both languages on every PR.

## Install

From PyPI (recommended for production workers):

```bash
pip install materios-compute-meter
```

From source (the monorepo path):

```bash
git clone https://github.com/Flux-Point-Studios/orynq-sdk
cd orynq-sdk/packages/compute-meter-sdk
pip install -e '.[dev]'
```

## Usage

```python
from materios_compute_meter import WorkerKeypair, MeteringRecord, submit

# 1) Provision a key. In production, load from a secrets manager; for
# tests / local dev, generate fresh:
kp = WorkerKeypair.generate()
kp.save("/var/lib/materios/worker-key.json")  # mode 0600

# 2) Build a record describing one billable interval.
record = MeteringRecord(
    worker_id="worker-001",
    tenant_id="tenant-acme",
    period_start_ms=1733400000000,
    period_end_ms=1733403600000,
    cpu_seconds=120.5,
    ram_gb_hours=0.42,
    disk_gb_hours=0.0,
    net_bytes_in=1_048_576,
    net_bytes_out=524_288,
    gpu_seconds=0.0,
)

# 3) Sign + submit (one-shot).
result = submit(
    kp, record,
    gateway_url="https://materios.fluxpointstudios.com/preprod-blobs",
    api_key="matra_...",
)
print(result["receipt_id"], result["content_hash"])

# Or pre-sign for offline / batched submission:
signed = kp.sign(record)
print(signed.content_hash, signed.signature[:16] + "...")
result = submit(signed, gateway_url=..., api_key=...)
```

## Loading existing keys

```python
# Deterministic from a 32-byte seed (handy for tests; do NOT use a static
# seed in production unless it comes from an HSM or secrets manager).
kp = WorkerKeypair.from_seed_hex("0x" + "11" * 32)

# Or from a JSON keyfile previously written by `kp.save(...)`.
kp = WorkerKeypair.load("/var/lib/materios/worker-key.json")
```

## Replay protection

Each successful `submit()` records the record's `period_start_ms` in a
per-process cache keyed by `worker_id`. A subsequent `submit()` for the
same `worker_id` with `period_start_ms <= last seen` raises
`ReplayRejectedError` BEFORE any HTTP traffic goes out.

The gateway also rejects replays server-side at the
`(signer_pub, period_start_ms)` tuple — the SDK's local cache is a
defense-in-depth + cost-saving check.

## Wire format

The signed payload is `sha256(canonical_cbor(record_without_signature))`.
The gateway request body is:

```json
{
  "scheme": "sr25519",
  "record": { ... canonical record dict, sorted keys ... },
  "content_hash": "<64 hex>",
  "signature":    "<128 hex>",
  "signer_public":"<64 hex>"
}
```

Canonical CBOR rules:
- Map keys sorted lexicographically.
- Lists / tuples NOT sorted (order is meaningful).
- Only built-in primitives (dict / list / tuple / str / bytes / int /
  float / bool / None) are accepted; foreign types are rejected with
  `TypeError` so the canonical form cannot drift via custom encoders.

## Testing

Run from `packages/compute-meter-sdk/` inside a fresh venv:

```bash
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'

# Unit + canonicalization + keypair tests (no network):
.venv/bin/pytest tests/ -m "not integration and not e2e and not slow"

# LIVE preprod SDK-only integration:
export MATERIOS_METERING_GATEWAY_URL="https://materios.fluxpointstudios.com/preprod-blobs"
export MATERIOS_METERING_API_KEY="matra_..."
.venv/bin/pytest tests/test_submit_integration.py

# Full end-to-end Compute-Portal pipeline (≤15 min default, ≤45 min with anchor):
.venv/bin/pytest tests/test_e2e_preprod.py -m e2e
RUN_CARDANO_ANCHOR_TEST=1 .venv/bin/pytest tests/test_e2e_preprod.py -m "e2e or slow"
```

See [`tests/E2E.md`](tests/E2E.md) for the full operator runbook.

## License

MIT
