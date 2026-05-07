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

---

## v2 (`compute_metering_v2`) E2E suite — `tests/test_v2_e2e_preprod.py`

Separate suite for the v2 envelope (mandatory `hardware_spec` +
optional `observer` co-signature). Gated by env vars per the team-3
brief; skips gracefully when any prerequisite is missing.

### Quick run

```bash
cd /home/deci/work/orynq-sdk/packages/compute-meter-sdk

# Required:
export MATERIOS_E2E_BEARER="matra_<your_token>"
export MATERIOS_E2E_HARDWARE_SPEC="/path/to/fleet-signed-hardware.json"

# Choose ONE worker_id-binding strategy:
export MATERIOS_E2E_WORKER_ID="worker-baked-into-the-spec"
# OR (preferred for repeated runs — re-issues per run):
export MATERIOS_E2E_FLEET_OPERATOR_KEY="/path/to/fleet-operator-key.json"

# Optional:
export MATERIOS_E2E_GATEWAY="https://materios.fluxpointstudios.com/preprod-blobs"
export MATERIOS_E2E_WORKER_KEY="/path/to/worker-key.json"
export MATERIOS_E2E_OBSERVER_KEY="/path/to/observer-key.json"
export MATERIOS_E2E_TENANT_ID="tenant-acme"

.venv/bin/pytest tests/test_v2_e2e_preprod.py -m e2e -v
```

### v2 environment variables

| var | required | default | purpose |
|---|---|---|---|
| `MATERIOS_E2E_BEARER` | yes | — | Bearer token for `/metering/submit`. Same token shape as v1 (`matra_*`). |
| `MATERIOS_E2E_HARDWARE_SPEC` | yes | — | Path to a fleet-operator-signed hardware spec JSON (the file `HardwareSpec.save()` writes). |
| `MATERIOS_E2E_FLEET_OPERATOR_KEY` | no | — | Path to the fleet operator's `WorkerKeypair` JSON keyfile. If set, the test re-issues hardware specs per run so each test gets a unique worker_id. Recommended. |
| `MATERIOS_E2E_WORKER_KEY` | no | (generates) | Path to the worker's keyfile. Defaults to a fresh `WorkerKeypair.generate()`. |
| `MATERIOS_E2E_OBSERVER_KEY` | no | (generates) | Path to the observer's `ObserverKeypair` JSON. Defaults to a fresh `ObserverKeypair.generate()`. |
| `MATERIOS_E2E_TENANT_ID` | no | `tenant-e2e` | The `tenant_id` field for the test record. Must match `[a-z0-9-]{4,64}`. |
| `MATERIOS_E2E_WORKER_ID` | no | `worker-e2e` | Prefix for the per-test worker_id. Each test appends a timestamp + suffix so submissions don't collide. |
| `MATERIOS_E2E_GATEWAY` | no | preprod-blobs | Gateway base URL. |

### Tests in the v2 suite

| name | what it proves | budget |
|---|---|---|
| `test_live_v2_submit_no_observer_round_trips` | Build → sign → submit a v2 envelope WITHOUT an observer block. Gateway returns 2xx + a `content_hash` matching the SDK's locally-recomputed canonical hash. | <30s |
| `test_live_v2_submit_with_observer_round_trips` | Same, with an observer co-signature attached. content_hash MUST equal the worker's pre-image hash (observer doesn't change content). | <30s |
| `test_live_v2_replay_rejected_by_gateway` | Submit twice with the same (worker_id, period_start_ms). Second submit must be rejected by either the SDK's local cache OR the gateway's 409. | <30s |

### v2 skip behaviour

The suite gracefully skips with a CLEAR diagnostic at module level when:

* `MATERIOS_E2E_BEARER` or `MATERIOS_E2E_HARDWARE_SPEC` is unset.
* The hardware spec JSON file doesn't exist.
* The gateway is unreachable.
* The gateway's `/metering/submit` returns 404 (no metering route at all).
* The gateway accepts only `compute_metering_v1` (Team 2's v2 validator
  hasn't shipped). Detected by probing with a `compute_metering_v2`
  schema_version and checking for a `WRONG_SCHEMA_VERSION` response.

A skipped E2E run is NOT a failure — it tells the operator exactly which
upstream piece is missing so they can fix THAT, not chase the SDK.

---

## Wave 3 Phase 2 Path C smoke — `tests/test_phase2_path_c_smoke.py`

Test-vector-driven Phase 2 demo: submits a `compute_metering_v2.1` record
that carries a real Google-rooted Pixel StrongBox attestation chain
(vendored from `pallets/tee-attestation/src/test_vectors.rs`), watches the
chain attest + Cardano-anchor it, and round-trips the
`attestation_evidence_hash` back through Blockfrost. When this harness
goes green end-to-end, Wave 3 Phase 2 is shipped.

The harness uses two independent trust layers — see the long explanation
in `tests/_phase2_helpers.py`. Short version: the cert chain in the
payload is REAL (Google-rooted Android Key Attestation); the sr25519
signature on `/v2/attestation_evidence` is from a fresh synthetic key
(we don't have the Pixel TEE's private key). The on-chain pallet's
`ArmTrustZoneVerifier` is what proves the chain-of-trust property; the
endpoint signature only authenticates "this attestor agrees this evidence
belongs to this receipt."

### Quick run

```bash
cd /home/deci/work/orynq-sdk/packages/compute-meter-sdk

# Required:
export MATERIOS_E2E_BEARER="matra_<your_token>"
export MATERIOS_E2E_HARDWARE_SPEC="/path/to/fleet-signed-hardware.json"
export PHASE2_ADMIN_TOKEN="<gateway-admin-shared-secret>"

# Strongly recommended (otherwise the synthetic worker_id won't verify
# against a baked-in spec):
export MATERIOS_E2E_FLEET_OPERATOR_KEY="/path/to/fleet-operator-key.json"

# Required for test #5 (Cardano metadata round-trip):
export PHASE2_BLOCKFROST_PROJECT_ID="preprod<your_project_id>"

# Optional:
export MATERIOS_E2E_GATEWAY="https://materios.fluxpointstudios.com/preprod-blobs"
export MATERIOS_RPC_URL="ws://127.0.0.1:9945"
export PHASE2_ATTESTOR_KEY="/path/to/attestor-key.json"   # otherwise generated fresh per session
export PHASE2_BLOCKFROST_URL="https://cardano-preprod.blockfrost.io/api/v0"

.venv/bin/pytest tests/test_phase2_path_c_smoke.py -m phase_2_smoke -v
```

### Tests in the Phase 2 suite

| name | what it proves | budget |
|---|---|---|
| `test_path_c_v2_record_lands_on_chain` | Gateway accepts a v2.1 envelope under the tenant Bearer; receipt visible in `/billing/usage` within 60 s. | <60s |
| `test_path_c_evidence_submission_returns_correct_hash` | The gateway's `attestation_evidence_hash` matches the SDK's pinned canonical-CBOR-sha256 byte-for-byte. Cross-language encoder property test, end-to-end. | <60s |
| `test_path_c_invalid_pixel_chain_rejected` | Tampered Pixel chain (`PIXEL_KEY_CERT_INVALID`) — the gateway accepts the evidence at the endpoint level, but `composite_trust_score` MUST stay at 0 past `PHASE2_DEADLINE_NEGATIVE_S` (default 180 s). The cert-daemon refuses to attest. | <3 min |
| `test_path_c_valid_pixel_chain_attested` | Headline demo. Valid Pixel chain → `composite_trust_score >= 1` AND `cardano_anchor_tx != null`. Logs the cexplorer.io URL on success. | <20 min |
| `test_path_c_anchor_evidence_hash_round_trips` | Reads back the Cardano anchor tx via Blockfrost, parses label-8746 metadata, finds the leaf for our receipt, asserts the leaf's `attestation_evidence_hash` matches the SDK's value. Real Google-rooted hardware → Cardano L1 audit trail. | <30s after #4 |

### Phase 2 skip behaviour

Each test reports the FIRST unmet prerequisite:

* `MATERIOS_E2E_BEARER` not set
* `MATERIOS_E2E_HARDWARE_SPEC` not set or file missing
* `PHASE2_ADMIN_TOKEN` not set (needed for attestor registration)
* Gateway unreachable
* Gateway returns 404 on `POST /v2/attestation_evidence` — old image, deploy the v2.1 build (PR #34)
* Gateway returns 404 on `/admin/attestation-evidence-attestors` — same fix
* Materios RPC unreachable
* `pallet-tee-attestation` not in runtime metadata — runtime upgrade for PR #17 hasn't landed yet
* `pallet-tee-attestation::Disabled` is `true` — sudo-flip via `set_disabled(false)` needed to take the kill-switch off

The skip messages are deliberately verbose — running `pytest -m phase_2_smoke -v -rs` should tell you in one shot exactly which step of the upgrade ceremony is incomplete. There is no "look at the wiki" — the test output IS the runbook.

### Polling budgets — env overrides

| var | default | meaning |
|---|---|---|
| `PHASE2_DEADLINE_RECEIPT_S` | 60 | Max time to wait for the v2.1 record to surface in `/billing/usage`. |
| `PHASE2_DEADLINE_CERT_S` | 600 | (reserved) — the chain attestation half budget. |
| `PHASE2_DEADLINE_NEGATIVE_S` | 180 | Negative-test deadline: how long to wait before concluding the cert-daemon WON'T attest a tampered chain. |
| `PHASE2_DEADLINE_ANCHOR_S` | 1200 | Max wait for the headline demo's anchor + trust-score to land (Cardano preprod p50 ≈ 5-15 min). |
