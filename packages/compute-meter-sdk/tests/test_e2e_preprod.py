"""End-to-end pytest suite for the Compute Portal compute-metering pipeline
against live Materios preprod (task #113).

This is the FINAL piece that proves the four already-shipped components
(#109 schema/route, #110 SDK, #111 anchor batching, #112 billing query) tie
together into a working customer pipeline:

    SDK keypair  →  POST /metering/submit  →  receipt on-chain  →
    cert-daemon attests  →  Cardano anchor  →  GET /billing/usage shows it.

How to run
----------

    cd /home/deci/work/materios-compute-meter
    export MATERIOS_METERING_GATEWAY_URL="https://materios.fluxpointstudios.com/preprod-blobs"
    export MATERIOS_METERING_API_KEY="matra_<...>"  # Bearer minted via /auth/token

    # Default (≤15 min) — submit→cert→billing-shows path:
    .venv/bin/pytest tests/test_e2e_preprod.py -m e2e --maxfail=1

    # Full path including Cardano anchor (≤45 min):
    RUN_CARDANO_ANCHOR_TEST=1 .venv/bin/pytest tests/test_e2e_preprod.py \\
        -m "e2e or slow" --maxfail=1

If `MATERIOS_METERING_GATEWAY_URL` / `MATERIOS_METERING_API_KEY` are unset, or
if either route returns 404 (not deployed yet), the suite skips with a clear
diagnostic. We do NOT mock the gateway or the chain — per
`feedback_intent_settlement_chain_tdd.md`, that's the whole point.

Timing budgets — match task brief #113
--------------------------------------

    Submit  →  200 from gateway:                       ≤10 s   (p50 <1 s)
    Submit  →  cert (cert-daemon attests):             ≤600 s  (p50 ≈300 s)
    Cert    →  /billing/usage shows certified:         ≤30 s   (p50 <5 s)
    Cert    →  Cardano anchor lands:                   ≤1800 s (p50 ≈900 s)
    Anchor  →  /billing/usage shows cardano_anchor_tx: ≤30 s   (p50 <5 s)

The Cardano-anchor path is gated behind `RUN_CARDANO_ANCHOR_TEST=1` so the
default suite stays under 15 minutes (per task brief).
"""
from __future__ import annotations

import os
import time
from typing import Any, Dict, Optional

import httpx
import pytest

from materios_compute_meter import WorkerKeypair

from tests._e2e_helpers import (
    GatewayConfig,
    SCHEMA_HASH_HEX,
    billing_endpoint_status,
    build_record,
    canonical_content_hash,
    fetch_billing_usage,
    fresh_tenant_id,
    fresh_worker_id,
    gateway_health,
    metering_endpoint_status,
    sign_envelope,
    submit_metering,
    wait_for_cardano_anchor,
    wait_for_certification,
)

pytestmark = pytest.mark.e2e


# ---------------------------------------------------------------------------
# Timing budgets — kept as constants so failure messages can quote them
# verbatim and so the slow-path test only differs by one number.
# ---------------------------------------------------------------------------

SUBMIT_RESPONSE_BUDGET_S = 10.0
CERT_DEADLINE_S = 600.0  # 10 min — task brief calls for 600s, p50≈300s
ANCHOR_DEADLINE_S = 1800.0  # 30 min — gated, slow-path only


# ---------------------------------------------------------------------------
# Module-level config + skip gates.
# ---------------------------------------------------------------------------


def _resolve_config() -> GatewayConfig:
    """Build a GatewayConfig from env. Caller decides what to do if the env
    is incomplete — `_skip_if_not_ready` consumes this for skip messages."""
    base = os.environ.get(
        "MATERIOS_METERING_GATEWAY_URL",
        "https://materios.fluxpointstudios.com/preprod-blobs",
    )
    bearer = os.environ.get("MATERIOS_METERING_API_KEY", "")
    return GatewayConfig(base_url=base, bearer=bearer)


@pytest.fixture(scope="module")
def cfg() -> GatewayConfig:
    """Resolved gateway config, shared across all tests in the module."""
    return _resolve_config()


@pytest.fixture(scope="module", autouse=True)
def _skip_if_not_ready(cfg: GatewayConfig) -> None:
    """Skip the entire module if the live preprod gateway is unreachable
    OR if the metering / billing routes return 404 (not deployed yet)."""
    if not cfg.bearer:
        pytest.skip(
            "MATERIOS_METERING_API_KEY not set. Mint a Bearer via the gateway "
            "admin API:\n"
            "  curl -X POST -H 'X-Admin-Token: <DAEMON_NOTIFY_TOKEN>' \\\n"
            "    -H 'content-type: application/json' \\\n"
            "    -d '{\"account\":\"<SS58>\",\"label\":\"e2e-suite\"}' \\\n"
            f"    {cfg.base_url}/auth/token"
        )

    health = gateway_health(cfg)
    if health != 200:
        pytest.skip(
            f"Gateway /health did not return 200 (got {health!r}). Verify "
            f"connectivity to {cfg.base_url}."
        )

    metering_status = metering_endpoint_status(cfg)
    billing_status = billing_endpoint_status(cfg)

    # The `/metering/submit` route, when deployed, replies to a `{"probe":true}`
    # POST with 400 (`MISSING_FIELD: schema_version`), 401 (signature_invalid
    # if no auth check before validation), or 422 (schema-version mismatch).
    # Anything OTHER than 404 / None means the route is up. The bearer-auth
    # middleware on the SUBMIT route is by signature, not Bearer — there is
    # no 401 from missing Bearer there.
    if metering_status in (None, 404):
        pytest.skip(
            "POST /metering/submit returned "
            f"{metering_status!r} — task #109's metering route is not yet "
            "deployed to live preprod. Re-run this suite after the route is "
            "shipped (orynq-sdk PR series for #109/#112)."
        )

    # `/billing/usage` requires Bearer; we send Bearer in the probe, so
    # 400 (missing tenant_id) is the success indicator. 404 == not deployed.
    if billing_status in (None, 404):
        pytest.skip(
            "GET /billing/usage returned "
            f"{billing_status!r} — task #112's billing route is not yet "
            "deployed to live preprod. Re-run this suite after the route is "
            "shipped (orynq-sdk PR series for #109/#112)."
        )

    if billing_status == 401:
        pytest.skip(
            "GET /billing/usage returned 401 — the configured "
            "MATERIOS_METERING_API_KEY does not pass bearerAuth. Issue a new "
            "Bearer via /auth/token (admin) and retry."
        )


# ---------------------------------------------------------------------------
# Test 1 — happy path: single record, submit → certify → billing-shows.
# ---------------------------------------------------------------------------


def test_e2e_happy_path(cfg: GatewayConfig) -> None:
    """Exercise every link in the chain for one record:

      1. Generate a fresh sr25519 WorkerKeypair via the SDK.
      2. Build a `compute_metering_v1` record covering a 60s window
         ending 10s ago (well inside the gateway's 60s future-skew window).
      3. Sign the canonical body and POST to /metering/submit.
      4. Assert 200 + content_hash matches what we computed locally +
         receipt_id is returned.
      5. Long-poll /billing/usage until attestation_status == "certified"
         within CERT_DEADLINE_S. Capture timing.
      6. Assert the aggregate sums match the single record exactly.
    """
    kp = WorkerKeypair.generate()
    tenant_id = fresh_tenant_id("happy")
    worker_id = fresh_worker_id("happy")

    period_end_ms = int(time.time() * 1000) - 10_000
    period_start_ms = period_end_ms - 60_000  # 60s window

    cpu_seconds = 12.5
    ram_gb_hours = 0.05
    disk_gb_hours = 0.0
    net_bytes_in = 4096
    net_bytes_out = 2048
    gpu_seconds = 0.0

    record = build_record(
        worker_id=worker_id,
        tenant_id=tenant_id,
        period_start=period_start_ms,
        period_end=period_end_ms,
        cpu_seconds=cpu_seconds,
        ram_gb_hours=ram_gb_hours,
        disk_gb_hours=disk_gb_hours,
        net_bytes_in=net_bytes_in,
        net_bytes_out=net_bytes_out,
        gpu_seconds=gpu_seconds,
        worker_pubkey_hex=kp.public_hex,
    )
    expected_hash = canonical_content_hash(record)
    envelope = sign_envelope(kp, record)
    assert envelope.content_hash == expected_hash, (
        "sign_envelope hash does not match canonical_content_hash; helper "
        "regression"
    )

    # ---- POST /metering/submit ----
    t_submit = time.monotonic()
    r = submit_metering(cfg, envelope, timeout_s=SUBMIT_RESPONSE_BUDGET_S)
    submit_elapsed = time.monotonic() - t_submit
    assert submit_elapsed < SUBMIT_RESPONSE_BUDGET_S, (
        f"submit took {submit_elapsed:.2f}s, budget {SUBMIT_RESPONSE_BUDGET_S}s"
    )
    assert r.status_code == 200, (
        f"POST /metering/submit returned {r.status_code} "
        f"body={r.text[:500]!r}"
    )
    body = r.json()
    assert body.get("ok") is True, f"unexpected body: {body!r}"
    assert body.get("status") in ("accepted", "replay"), body
    assert body.get("content_hash") == envelope.content_hash, (
        "Server-reported content_hash does NOT match the canonical hash the "
        "test computed locally — this is a wire-encoding regression. "
        f"server={body.get('content_hash')!r} local={envelope.content_hash!r}"
    )
    assert body.get("schema_hash") == SCHEMA_HASH_HEX, (
        f"schema_hash mismatch: server={body.get('schema_hash')!r} "
        f"expected={SCHEMA_HASH_HEX!r}"
    )
    assert body.get("worker_id") == worker_id

    # ---- Wait for cert-daemon ----
    poll = wait_for_certification(
        cfg,
        tenant_id=tenant_id,
        content_hash=envelope.content_hash,
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms,
        deadline_s=CERT_DEADLINE_S,
    )
    assert poll.success, (
        f"Receipt {envelope.content_hash[:16]}... did not certify within "
        f"{CERT_DEADLINE_S}s (polled {poll.polls}x, elapsed "
        f"{poll.elapsed_s:.1f}s, last status={poll.final_status!r}). "
        f"Last billing body: {poll.final!r}"
    )

    # ---- Verify aggregate sums match the single record ----
    final_body = poll.final
    assert isinstance(final_body, dict)
    aggregate = final_body.get("aggregate")
    assert isinstance(aggregate, dict), final_body
    # The window includes ONLY this record (we used a fresh tenant_id so
    # nothing else can leak in). Asserting equality, not >=, makes the
    # contract tight.
    assert aggregate["record_count"] == 1, aggregate
    assert aggregate["certified_count"] == 1, aggregate
    assert aggregate["unique_workers"] == 1, aggregate
    assert _approx_eq(aggregate["cpu_seconds_total"], cpu_seconds), aggregate
    assert _approx_eq(aggregate["ram_gb_hours_total"], ram_gb_hours), aggregate
    assert _approx_eq(aggregate["disk_gb_hours_total"], disk_gb_hours), aggregate
    assert aggregate["net_bytes_in_total"] == net_bytes_in, aggregate
    assert aggregate["net_bytes_out_total"] == net_bytes_out, aggregate
    assert _approx_eq(aggregate["gpu_seconds_total"], gpu_seconds), aggregate
    assert aggregate["first_record_ms"] == period_start_ms, aggregate
    assert aggregate["last_record_ms"] == period_start_ms, aggregate

    # The audit_trail block is required by #112's contract.
    audit = final_body.get("audit_trail")
    assert isinstance(audit, dict), final_body
    assert audit.get("schema_hash") == SCHEMA_HASH_HEX

    # Verify the per-record fields (the assertion target the brief calls out).
    records = final_body.get("records") or []
    matching = [r for r in records if r.get("content_hash") == envelope.content_hash]
    assert len(matching) == 1, (
        f"Expected exactly 1 record with content_hash={envelope.content_hash[:16]}..., "
        f"got {len(matching)}: {records!r}"
    )
    rec = matching[0]
    assert rec["worker_id"] == worker_id
    assert rec["period_start_ms"] == period_start_ms
    assert rec["period_end_ms"] == period_end_ms
    assert rec["attestation_status"] == "certified"
    # Anchor may or may not have landed by now; both are acceptable in this
    # default-path test. The slow test below exercises the anchor leg.
    anchor_tx = rec.get("cardano_anchor_tx")
    assert anchor_tx is None or _is_well_formed_tx_hash(anchor_tx), rec


# ---------------------------------------------------------------------------
# Test 2 — burst of 5 records, all certify, aggregate sum is correct.
# ---------------------------------------------------------------------------


def test_e2e_burst_5_records(cfg: GatewayConfig) -> None:
    """Submit 5 records under the same tenant_id (different workers,
    contiguous time windows). Wait for all to certify. Verify aggregate
    sums match elementwise.

    Workers are independent keypairs so the gateway's per-worker monotonic
    `period_start` check doesn't reject any of them, but the same tenant
    binds the records into one billing window.
    """
    n = 5
    tenant_id = fresh_tenant_id("burst5")

    base_end_ms = int(time.time() * 1000) - 10_000
    window_ms = 60_000

    submitted: list[Dict[str, Any]] = []
    for i in range(n):
        kp = WorkerKeypair.generate()
        worker_id = fresh_worker_id(f"b{i}")
        period_end = base_end_ms - i * 1000  # stagger 1s so first_/last_record_ms vary
        period_start = period_end - window_ms

        cpu = 1.0 + i  # 1,2,3,4,5 — sum=15, easy to eyeball
        ram = 0.10 * (i + 1)
        net_in = 1000 * (i + 1)
        net_out = 500 * (i + 1)

        record = build_record(
            worker_id=worker_id,
            tenant_id=tenant_id,
            period_start=period_start,
            period_end=period_end,
            cpu_seconds=cpu,
            ram_gb_hours=ram,
            net_bytes_in=net_in,
            net_bytes_out=net_out,
            worker_pubkey_hex=kp.public_hex,
        )
        envelope = sign_envelope(kp, record)
        r = submit_metering(cfg, envelope)
        assert r.status_code == 200, f"record {i}: {r.status_code} {r.text[:300]}"
        body = r.json()
        assert body.get("ok") is True
        submitted.append(
            {
                "content_hash": envelope.content_hash,
                "period_start": period_start,
                "period_end": period_end,
                "worker_id": worker_id,
                "cpu": cpu,
                "ram": ram,
                "net_in": net_in,
                "net_out": net_out,
            }
        )

    # ---- Wait for ALL to certify ----
    earliest = min(s["period_start"] for s in submitted)
    latest = max(s["period_end"] for s in submitted)
    submitted_hashes = {s["content_hash"] for s in submitted}

    deadline = time.monotonic() + CERT_DEADLINE_S
    final_body: Optional[Dict[str, Any]] = None
    last_certified_count = 0
    last_records_len = 0
    while time.monotonic() < deadline:
        r = fetch_billing_usage(
            cfg,
            tenant_id=tenant_id,
            start_ms=max(0, earliest - 1),
            end_ms=latest + 1,
            include_records=True,
            page_size=100,
            timeout_s=10.0,
        )
        if r.status_code != 200:
            time.sleep(5.0)
            continue
        body = r.json()
        records = body.get("records") or []
        last_records_len = len(records)
        certified = [
            rec
            for rec in records
            if rec.get("content_hash") in submitted_hashes
            and rec.get("attestation_status") == "certified"
        ]
        last_certified_count = len(certified)
        if last_certified_count == n:
            final_body = body
            break
        time.sleep(10.0)

    if final_body is None:
        pytest.fail(
            f"Only {last_certified_count}/{n} burst records certified within "
            f"{CERT_DEADLINE_S}s (last response had {last_records_len} records "
            f"in window)"
        )

    # ---- Aggregate must equal the elementwise sum ----
    aggregate = final_body["aggregate"]
    assert aggregate["record_count"] == n
    assert aggregate["certified_count"] == n
    assert aggregate["unique_workers"] == n
    assert _approx_eq(aggregate["cpu_seconds_total"], sum(s["cpu"] for s in submitted))
    assert _approx_eq(aggregate["ram_gb_hours_total"], sum(s["ram"] for s in submitted))
    assert aggregate["net_bytes_in_total"] == sum(s["net_in"] for s in submitted)
    assert aggregate["net_bytes_out_total"] == sum(s["net_out"] for s in submitted)
    assert aggregate["first_record_ms"] == min(s["period_start"] for s in submitted)
    assert aggregate["last_record_ms"] == max(s["period_start"] for s in submitted)


# ---------------------------------------------------------------------------
# Test 3 — bad signature is rejected with HTTP 401.
# ---------------------------------------------------------------------------


def test_e2e_signature_rejected(cfg: GatewayConfig) -> None:
    """The gateway MUST reject a record whose signature does not verify
    against the declared `worker_pubkey`. Per #109's
    `compute_metering_v1.ts`, the status for `SIGNATURE_INVALID` is 401.

    We achieve this by signing with one keypair but advertising another
    pubkey. The canonical body is the one the SECOND key would have
    produced, so the signature simply won't verify.
    """
    real_kp = WorkerKeypair.generate()
    decoy_kp = WorkerKeypair.generate()
    assert real_kp.public_hex != decoy_kp.public_hex

    tenant_id = fresh_tenant_id("badsig")
    worker_id = fresh_worker_id("badsig")
    period_end = int(time.time() * 1000) - 10_000
    period_start = period_end - 60_000

    record = build_record(
        worker_id=worker_id,
        tenant_id=tenant_id,
        period_start=period_start,
        period_end=period_end,
        cpu_seconds=1.0,
        worker_pubkey_hex=decoy_kp.public_hex,  # claim decoy
    )
    # Sign with real_kp (NOT decoy_kp) — but we manually patch the envelope
    # so that worker_pubkey says decoy and signature is from real. Bypass
    # sign_envelope's public/private match check.
    from tests._e2e_helpers import canonical_body

    body_bytes = canonical_body(record)
    sig_hex = real_kp.sign_bytes(body_bytes).hex()
    wire = {**record, "worker_signature": sig_hex}

    headers = {
        **cfg.auth_header,
        "content-type": "application/json",
    }
    with httpx.Client(timeout=10.0) as client:
        r = client.post(cfg.metering_submit_url, json=wire, headers=headers)
    assert r.status_code == 401, (
        f"Expected 401 SIGNATURE_INVALID, got {r.status_code}. "
        f"body={r.text[:500]!r}"
    )
    body = r.json()
    assert body.get("ok") is False, body
    # Per `compute_metering_v1.ts` the error code is `SIGNATURE_INVALID`.
    assert body.get("code") == "SIGNATURE_INVALID", body


# ---------------------------------------------------------------------------
# Test 4 — replay protection: identical record submitted twice → second is
# treated as a replay (200 with status="replay") and the in-flight
# notification is NOT re-fired.
#
# NOTE on the spec: the gateway's metering route returns 200 + status="replay"
# on an exact-bytes retry (idempotency). It returns 409 MONOTONIC_VIOLATION
# only when a DIFFERENT record from the SAME worker_id has period_start
# BELOW the previously-seen value. The brief's "second is 409" wording
# describes the latter; we test BOTH paths so the contract is fully covered.
# ---------------------------------------------------------------------------


def test_e2e_replay_rejected(cfg: GatewayConfig) -> None:
    """Two scenarios:

      a) Exact-bytes retry → 200 with status="replay" (idempotent shortcut).
      b) New record with period_start BELOW the earlier one → 409
         MONOTONIC_VIOLATION.
    """
    kp = WorkerKeypair.generate()
    tenant_id = fresh_tenant_id("replay")
    worker_id = fresh_worker_id("replay")
    period_end = int(time.time() * 1000) - 10_000
    period_start = period_end - 60_000

    record = build_record(
        worker_id=worker_id,
        tenant_id=tenant_id,
        period_start=period_start,
        period_end=period_end,
        cpu_seconds=2.0,
        worker_pubkey_hex=kp.public_hex,
    )
    envelope = sign_envelope(kp, record)

    # First submission — must be 200/accepted.
    r1 = submit_metering(cfg, envelope)
    assert r1.status_code == 200, f"first submit: {r1.status_code} {r1.text[:300]}"
    body1 = r1.json()
    assert body1.get("status") == "accepted", body1

    # (a) Exact-bytes retry — replay shortcut.
    r2 = submit_metering(cfg, envelope)
    assert r2.status_code == 200, f"replay: {r2.status_code} {r2.text[:300]}"
    body2 = r2.json()
    assert body2.get("status") == "replay", body2
    assert body2.get("content_hash") == envelope.content_hash, body2
    assert body2.get("worker_id") == worker_id

    # (b) New record from the SAME worker_id with period_start BELOW the
    # earlier one — gateway returns 409 MONOTONIC_VIOLATION.
    earlier_record = build_record(
        worker_id=worker_id,
        tenant_id=tenant_id,
        period_start=period_start - 10_000,
        period_end=period_end - 10_000,
        cpu_seconds=2.5,  # different so the envelope hash differs
        worker_pubkey_hex=kp.public_hex,
    )
    earlier_envelope = sign_envelope(kp, earlier_record)
    r3 = submit_metering(cfg, earlier_envelope)
    assert r3.status_code == 409, (
        f"Expected 409 MONOTONIC_VIOLATION, got {r3.status_code}. "
        f"body={r3.text[:500]!r}"
    )
    body3 = r3.json()
    assert body3.get("ok") is False
    assert body3.get("code") == "MONOTONIC_VIOLATION", body3


# ---------------------------------------------------------------------------
# Test 5 — Cardano anchor lands. Slow path; gated on env var.
# ---------------------------------------------------------------------------


@pytest.mark.slow
@pytest.mark.skipif(
    os.environ.get("RUN_CARDANO_ANCHOR_TEST") != "1",
    reason="Slow path (≤30 min); set RUN_CARDANO_ANCHOR_TEST=1 to enable.",
)
def test_e2e_cardano_anchor_landing(cfg: GatewayConfig) -> None:
    """End-to-end including Cardano anchor.

    Submits a single record, waits for cert (CERT_DEADLINE_S), then waits for
    the Cardano anchor tx to populate the record's `cardano_anchor_tx` field
    (ANCHOR_DEADLINE_S). p50 ≈ 15 min.
    """
    kp = WorkerKeypair.generate()
    tenant_id = fresh_tenant_id("anchor")
    worker_id = fresh_worker_id("anchor")
    period_end = int(time.time() * 1000) - 10_000
    period_start = period_end - 60_000

    record = build_record(
        worker_id=worker_id,
        tenant_id=tenant_id,
        period_start=period_start,
        period_end=period_end,
        cpu_seconds=3.5,
        worker_pubkey_hex=kp.public_hex,
    )
    envelope = sign_envelope(kp, record)
    r = submit_metering(cfg, envelope)
    assert r.status_code == 200, f"submit: {r.status_code} {r.text[:300]}"

    cert_poll = wait_for_certification(
        cfg,
        tenant_id=tenant_id,
        content_hash=envelope.content_hash,
        period_start_ms=period_start,
        period_end_ms=period_end,
        deadline_s=CERT_DEADLINE_S,
    )
    assert cert_poll.success, (
        f"cert phase failed in {cert_poll.elapsed_s:.1f}s "
        f"(polls={cert_poll.polls}, status={cert_poll.final_status!r})"
    )

    anchor_poll = wait_for_cardano_anchor(
        cfg,
        tenant_id=tenant_id,
        content_hash=envelope.content_hash,
        period_start_ms=period_start,
        period_end_ms=period_end,
        deadline_s=ANCHOR_DEADLINE_S,
    )
    assert anchor_poll.success, (
        f"anchor phase failed in {anchor_poll.elapsed_s:.1f}s "
        f"(polls={anchor_poll.polls}, last status={anchor_poll.final_status!r}). "
        f"Last billing body: {anchor_poll.final!r}"
    )

    final_body = anchor_poll.final
    assert isinstance(final_body, dict)
    aggregate = final_body["aggregate"]
    assert aggregate["anchored_count"] >= 1, aggregate

    records = final_body.get("records") or []
    matching = [r for r in records if r.get("content_hash") == envelope.content_hash]
    assert len(matching) == 1, records
    rec = matching[0]
    assert rec["attestation_status"] == "certified"
    assert _is_well_formed_tx_hash(rec["cardano_anchor_tx"]), rec


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _approx_eq(a: float, b: float, rel: float = 1e-9, absol: float = 1e-9) -> bool:
    """Float comparison tolerant to single-precision drift introduced by the
    gateway's CBOR round-trip (always 8-byte float64 — but Node's JSON.stringify
    emits decimal-shortest, so 0.05 may serialize as 0.05 then re-parse as
    the nearest double which is 0.05000000000000000277..., identical to the
    Python double we sent). Tolerance is comfortably below the smallest
    `cpu_seconds`-class metric we use (0.05)."""
    return abs(a - b) <= max(rel * max(abs(a), abs(b)), absol)


def _is_well_formed_tx_hash(s: Any) -> bool:
    """Loose tx-hash check: 32-byte hex, optional `0x` prefix. Cardano tx ids
    are 64 lowercase hex chars; the billing route normalizes to `0x`-prefixed
    so we accept either."""
    if not isinstance(s, str):
        return False
    if s.startswith("0x"):
        s = s[2:]
    return len(s) == 64 and all(c in "0123456789abcdef" for c in s.lower())
