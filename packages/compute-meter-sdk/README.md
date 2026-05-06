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

## Schema versions

| Version | Schema string         | Status     | Adds |
|---------|-----------------------|------------|------|
| v1      | `compute_metering_v1` | shipped    | original worker-signed record |
| v2      | `compute_metering_v2` | 0.2.0-rc1  | mandatory `hardware_spec` (FPS-fleet-operator-signed); optional `observer` co-signature (Wave 2) |

v1 stays untouched — backward compat is mandatory. v2 is opt-in: build a
v2 record with `build_record_v2(...)` + `sign_record_v2(...)` and submit
via `submit_v2(...)`.

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

## Usage — v1 (existing)

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

## Usage — v2 (new in 0.2.0-rc1)

v2 envelopes carry a **mandatory `hardware_spec`** that's signed by an
FPS-registered fleet operator (so a worker can't lie about its cores) and
an **optional observer co-signature** (Wave 2: an independent observer
attests to the same metric set the worker signed).

### Fleet operator workflow (offline / FPS-internal)

The fleet operator runs a one-time signing ceremony per worker (or per
hardware re-provisioning). Production fleet operators use HSM-backed
keys; tests and local dev can use `from_seed_hex` for determinism.

```python
from materios_compute_meter import WorkerKeypair, sign_hardware_spec

fleet_kp = WorkerKeypair.load("/secrets/fleet-operator.json")  # offline / HSM
spec = sign_hardware_spec(
    worker_id="worker-001",
    cpu_cores=8,
    ram_gb=32,
    gpu_type="none",        # "none" | "nvidia-h100" | ... | "custom"
    gpu_count=0,
    issued_ms=1_700_000_000_000,
    fleet_operator_keypair=fleet_kp,
)
spec.save("/etc/materios/hardware.json")  # ship to the worker
```

### Worker workflow

```python
from materios_compute_meter import (
    HardwareSpec, WorkerKeypair,
    build_record_v2, sign_record_v2,
    submit_v2,
)

# 1) Load the fleet-signed hardware spec at startup.
spec = HardwareSpec.load("/etc/materios/hardware.json")
assert spec.verify("worker-001"), "hardware spec was issued for a different worker"

# 2) Load (or generate) a worker key.
worker_kp = WorkerKeypair.load("/var/lib/materios/worker-key.json")

# 3) For each billable interval, build + sign + submit a v2 envelope.
body = build_record_v2(
    worker_id="worker-001",
    tenant_id="tenant-acme",
    period_start_ms=1_700_000_000_000,
    period_end_ms=1_700_000_060_000,
    metrics={
        "cpu_seconds": 60,
        "ram_gb_hours": 0.25,
        "disk_gb_hours": 0.0,
        "net_bytes_in": 1024,
        "net_bytes_out": 512,
        "gpu_seconds": 0,
    },
    hardware_spec=spec,
)
sealed = sign_record_v2(body, worker_kp)
res = submit_v2(
    sealed,
    gateway_url="https://materios.fluxpointstudios.com/preprod-blobs",
    bearer="matra_...",
)
print(res.receipt_id, res.content_hash)
```

### Observer workflow (Wave 2 — optional)

An independent observer (a watchdog process, peer worker, or third-party
attestor) co-signs the SAME canonical bytes the worker signed. Different
key, same payload. The observer's role is to stake reputation on the
honesty of the metric set — it does NOT add metrics of its own.

```python
from materios_compute_meter import ObserverKeypair, attach_observer_signature_v2

observer_kp = ObserverKeypair.load("/var/lib/materios/observer-key.json")
co_signed = attach_observer_signature_v2(sealed, observer_kp)
res = submit_v2(co_signed, gateway_url=..., bearer=...)
```

### Migration from v1

* v1 calls (`submit(...)`, `MeteringRecord`, `WorkerKeypair.sign(...)`)
  remain unchanged. You can mix v1 and v2 submissions in the same process.
* The gateway routes both v1 and v2 to `/metering/submit`; the
  `schema_version` field discriminates.
* The replay cache is shared per-(worker_id) across v1 and v2 — switching
  schema versions in mid-stream still respects monotonic period_start_ms.
* `content_hash` semantics differ: v1 hashes the flat record; v2 hashes
  the v2 pre-image (worker-sig pre-image, observer-stripped). Don't try
  to compare hashes across versions — they won't match by design.

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

## Wire format — v1

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

## Wire format — v2

The v2 envelope carries THREE signatures over distinct (overlapping)
pre-images:

1. `fleet_operator_signature` — issued offline by FPS, attests that this
   `worker_id` is bound to a specific (cpu_cores, ram_gb, gpu_type, ...)
   spec. Pre-image = sorted-key canonical CBOR of
   `{schema_version, worker_id, hardware_spec MINUS fleet_operator_signature}`.
2. `worker_signature` — sealed by the worker each interval. Pre-image =
   the full record MINUS `worker_signature` AND `observer`.
3. `observer_signature` (optional, Wave 2) — co-signed over the SAME
   bytes the worker signed; different key.

Wire body (`POST /metering/submit`, with `Bearer <token>` and
`X-Schema-Version: compute_metering_v2` headers):

```json
{
  "schema_version": "compute_metering_v2",
  "worker_id": "...",
  "tenant_id": "...",
  "period_start_ms": ...,
  "period_end_ms": ...,
  "metrics": {
    "cpu_seconds": int, "ram_gb_hours": float, "disk_gb_hours": float,
    "net_bytes_in": int, "net_bytes_out": int, "gpu_seconds": int
  },
  "hardware_spec": {
    "cpu_cores": int, "ram_gb": int,
    "gpu_type": "...", "gpu_count": int,
    "fleet_operator_pubkey_hex":     "<64 hex>",
    "fleet_operator_signature_hex":  "<128 hex>",
    "issued_ms": int
  },
  "worker_pubkey_hex":     "<64 hex>",
  "worker_signature_hex":  "<128 hex>",
  "observer": {
    "observer_pubkey_hex":     "<64 hex>",
    "observer_signature_hex":  "<128 hex>"
  }
}
```

Canonical CBOR rules for v2:
- Map keys sorted lexicographically by encoded-byte order (RFC 8949 §4.2.1).
- Strings: UTF-8 (major type 3); bytes: major type 2.
- Integers: shortest form (uint major 0/1).
- Whole-valued floats encode as integers (e.g. `64.0` → `uint(64)`) for
  parity with the JS encoder where `Number.isInteger(64.0) === true`.
- Non-integer floats: ALWAYS IEEE-754 binary64 (8 bytes, BE). No f16/f32
  shortening — the v1 TS encoder pinned this rule, v2 mirrors it.
- NaN / Infinity rejected.

The Python encoder (`canonical.canonical_cbor_v2`) and the TypeScript
encoder (`services/blob-gateway/src/schemas/compute_metering_v1.ts`'s
canonical body builder, plus `tests/_v2_ts_encoder.mjs` for v2-specific
fields) produce byte-identical bytes for the same input — verified on
every PR by `tests/test_v2_cross_language_bytes.py`.

## CLI

```bash
# v2 submit, optional observer:
python3 -m materios_compute_meter.cli submit-v2 \
    --gateway https://materios.fluxpointstudios.com/preprod-blobs \
    --bearer matra_xxx \
    --hardware-spec /etc/materios/hardware.json \
    --worker-key /var/lib/materios/worker-key.json \
    --worker-id worker-001 \
    --tenant-id tenant-acme \
    --period-start-ms 1700000000000 \
    --period-end-ms 1700000060000 \
    --cpu-seconds 60 \
    --ram-gb-hours 0.25 \
    --observer-key /var/lib/materios/observer-key.json   # optional
```

Exit codes: `0`=success, `1`=config error, `2`=validation/replay,
`3`=network/gateway.

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
