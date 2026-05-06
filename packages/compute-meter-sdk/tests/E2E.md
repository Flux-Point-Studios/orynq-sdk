# Compute-Metering E2E Suite (task #113)

End-to-end pytest suite that exercises the full Compute Portal compute-metering
pipeline against live Materios preprod:

```
worker SDK keypair
   └→ POST /metering/submit (compute_metering_v1 schema)
        └→ on-chain receipt (sponsored-receipt-submitter)
             └→ cert-daemon attestation
                  └→ Cardano L1 anchor (anchor-worker)
                       └→ GET /billing/usage shows it
```

This file is the **smoke-check entry-point**: when Hetzner-Claude (or any
operator) finishes a deploy, they run this suite and a green run means the
whole pipeline is healthy.

## TL;DR — quick run

```bash
cd /home/deci/work/orynq-sdk/packages/compute-meter-sdk

# 1. Install SDK + test deps (one-time):
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'

# 2. Set env vars:
export MATERIOS_METERING_GATEWAY_URL="https://materios.fluxpointstudios.com/preprod-blobs"
export MATERIOS_METERING_API_KEY="matra_<your-bearer>"

# 3. Run the default suite (≤15 min):
.venv/bin/pytest tests/test_e2e_preprod.py -m e2e --maxfail=1

# 4. Optional — full suite including Cardano anchor (≤45 min):
RUN_CARDANO_ANCHOR_TEST=1 .venv/bin/pytest tests/test_e2e_preprod.py \
    -m "e2e or slow" --maxfail=1
```

## Environment variables

| var | required | default | purpose |
|---|---|---|---|
| `MATERIOS_METERING_GATEWAY_URL` | no | `https://materios.fluxpointstudios.com/preprod-blobs` | Base URL of the Materios blob gateway. The suite appends `/metering/submit` and `/billing/usage`. Trailing slash is tolerated. |
| `MATERIOS_METERING_API_KEY` | yes | — | Bearer token (`matra_…`) used for `Authorization: Bearer` on the billing query. The submit route auths by sr25519 signature; the bearer is consumed only by the billing read. |
| `RUN_CARDANO_ANCHOR_TEST` | no | unset | Set to `1` to enable `test_e2e_cardano_anchor_landing` (≤30 min). Skipped otherwise. |

## Minting a Bearer token

The gateway exposes admin-only token management at `/auth/token`. To mint a
fresh Bearer for the E2E suite:

```bash
curl -X POST \
    -H "X-Admin-Token: $DAEMON_NOTIFY_TOKEN" \
    -H 'content-type: application/json' \
    -d '{"account":"<your SS58 address>","label":"e2e-task-113"}' \
    https://materios.fluxpointstudios.com/preprod-blobs/auth/token
```

The response carries `token` (shown ONCE). Store it in
`MATERIOS_METERING_API_KEY` and never log it.

## Tests in this suite

| name | what it proves | budget |
|---|---|---|
| `test_e2e_happy_path` | Single record. Submit → 200 + `content_hash` matches local canonical hash → cert-daemon certifies → `/billing/usage` shows `attestation_status="certified"` and aggregate sums equal the input fields exactly. | ≤10 min |
| `test_e2e_burst_5_records` | Five records under one tenant_id. All five certify. Aggregate equals elementwise sum (cpu, ram, net_in, net_out). `unique_workers == 5`. | ≤10 min |
| `test_e2e_signature_rejected` | Sign with key A but advertise pubkey B → 401 `SIGNATURE_INVALID`. | <1 min |
| `test_e2e_replay_rejected` | (a) Exact-bytes retry → 200 `status="replay"`. (b) New record with `period_start` below the last one for the same `worker_id` → 409 `MONOTONIC_VIOLATION`. | <2 min |
| `test_e2e_cardano_anchor_landing` (`@slow`) | Single record, full path including Cardano anchor. After cert lands, polls until `cardano_anchor_tx` is non-null. Asserts `aggregate.anchored_count >= 1`. | ≤30 min |

## Skip behaviour

The whole module skips with a clear diagnostic if any precondition fails:

* `MATERIOS_METERING_API_KEY` unset → instructions for minting one.
* `/health` returns non-200 → connectivity hint.
* `POST /metering/submit` returns 404 → "task #109 not deployed yet, re-run after merge".
* `GET /billing/usage` returns 404 → "task #112 not deployed yet, re-run after merge".
* `GET /billing/usage` returns 401 → "configured Bearer does not pass bearerAuth".

A skipped run is NOT a failure — it tells the operator exactly which
upstream piece is missing.

## Timing budgets — do not deviate

These are pinned in the test file as constants (`CERT_DEADLINE_S = 600.0`,
`ANCHOR_DEADLINE_S = 1800.0`). They were picked from task #114's audit which
established that real cert-daemon p50 is ~5 minutes (NOT the legacy 90-second
assumption that flaked across multiple suites). The 30-minute anchor budget
matches the anchor-worker's batch interval + Cardano confirmation latency.

If you find yourself wanting to tighten these because "preprod is fast today",
DON'T. The brief is explicit on this point — flaky timing is the dominant
failure mode in operator-facing CI.

## Why the tests don't use `materios_compute_meter.submit()`

Background: the SDK's `submit()` path signs over a different canonical CBOR
encoding than the gateway's `compute_metering_v1` schema validator expects.
Specifically:

* SDK uses `cbor2.dumps(canonical=True)` over a record dict with `_ms`-suffixed
  keys (`period_start_ms`) and NO `schema_version` field.
* Gateway uses an inline RFC 8949 §4.2.1 encoder over a record with bare
  `period_start` / `period_end` keys, a mandatory `schema_version`, an
  embedded `worker_pubkey`, and integer-valued floats encoded as ints (the
  way TS's `Number.isInteger(0.0) === true` dictates).

The E2E suite ships its own `_e2e_helpers.canonical_body()` — a 150-line
pure-Python encoder that is byte-for-byte identical to the gateway's TS
implementation (verified via cross-language hash comparison on multiple test
vectors). This insulates the E2E contract from any unrelated SDK refactors
and gives us a second independent implementation of the schema, which is
the whole reason canonical CBOR exists.

The SDK is still used for `WorkerKeypair.generate()` and `kp.sign_bytes()` —
those are the parts that don't depend on the canonical encoding.

## Adding new E2E tests

1. Mark with `@pytest.mark.e2e` (default suite) or `@pytest.mark.slow` (gated).
2. Use `cfg` fixture for gateway endpoint config.
3. Use a `fresh_tenant_id()` to keep tests isolated on a shared gateway.
4. For polling, use the helpers — never tight-loop. Exponential backoff with
   a deadline is the standard pattern; copy from `wait_for_certification()`.
5. Assert on the canonical content_hash AND the gateway's response field —
   both must match. A passing assertion that only checks one side is a
   regression-risk gap.
