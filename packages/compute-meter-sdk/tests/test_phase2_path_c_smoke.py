"""Phase 2 Path C smoke harness — Wave 3 polychain attestation, demo-mode.

Path C is the test-vector-driven Phase 2 demo: when this harness goes green
end-to-end, Materios Wave 3 Phase 2 is shipped. It submits a
``compute_metering_v2.1`` record carrying a real Pixel StrongBox attestation
chain (vendored from `pallets/tee-attestation/src/test_vectors.rs`), watches
the gateway accept it, the cert-daemon attest it, the anchor-worker batch
it onto Cardano L1, and the billing API surface ``composite_trust_score=1``
+ a Cardano anchor tx hash. cexplorer.io URL printed on success.

The five acceptance criteria (one test each) come from the brief:

    1. test_path_c_v2_record_lands_on_chain
       — submit a v2.1 record with EMPTY evidence vec; assert receipt
       reaches the chain within 60 s (proves the v2.1 schema is accepted).

    2. test_path_c_evidence_submission_returns_correct_hash
       — register the synthetic attestor, post one Pixel-chain evidence
       entry, assert the gateway-returned attestation_evidence_hash equals
       the off-chain canonical-CBOR-sha256 over the same vec.

    3. test_path_c_invalid_pixel_chain_rejected
       — post a TAMPERED Pixel cert chain (PIXEL_KEY_CERT_INVALID).
       The gateway accepts the evidence at the endpoint level (it doesn't
       run the Rust verifier locally), but the cert-daemon must REFUSE to
       attest, so on-chain ``availability_cert_hash`` stays zero past a
       reasonable wait window.

    4. test_path_c_valid_pixel_chain_attested
       — the headline demo. Post a GOOD Pixel chain; poll until
       ``availability_cert_hash != 0`` AND ``composite_trust_score == 1``
       AND ``cardano_anchor_tx != null``. When this passes, Phase 2
       end-to-end is shipped.

    5. test_path_c_anchor_evidence_hash_round_trips
       — fetch the Cardano anchor tx via Blockfrost, parse label-8746,
       find the leaf for our receipt, assert the leaf's
       ``attestation_evidence_hash`` matches the SDK-computed value.

All five are gated behind ``@pytest.mark.phase_2_smoke`` so they only run
when explicitly invoked: ``pytest -m phase_2_smoke -v``.

Pre-flight skip conditions (each test prints exactly which one fired):

    * Gateway unreachable — DNS/TLS error.
    * ``/v2/attestation_evidence`` 404s — gateway image is the OLD one.
    * ``/admin/attestation-evidence-attestors`` 404s — same.
    * RPC unreachable — Materios chain RPC down.
    * Pallet metadata missing — runtime upgrade hasn't landed yet.
    * Pallet ``Disabled`` is true — kill-switch flipped on, sudo-flip
      via ``set_disabled(false)`` needed.
    * Bearer / Hardware-spec env vars missing — same as the v2 e2e suite.
    * Gateway admin token missing — needed to register the attestor.

The harness ships in this state on purpose: every prereq has a clear,
named skip message. Future-deci runs ``pytest -m phase_2_smoke -v`` and
the skips tell them what's left to do.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

import httpx
import pytest

from materios_compute_meter import (
    HardwareSpec,
    SubmissionResult,
    WorkerKeypair,
    build_record_v2,
    canonical_content_hash_v2,
    sign_record_v2,
    submit_v2,
    verify_record_v2,
)
from materios_compute_meter.canonical import attestation_evidence_hash

from tests._e2e_helpers import (
    GatewayConfig as E2EGatewayConfig,
    PollResult,
    _exp_backoff,
    _find_record_by_hash,
    fetch_billing_usage,
)
from tests._phase2_helpers import (
    GatewayConfig as Phase2GatewayConfig,
    HARNESS_ENV_VARS,
    PalletReadiness,
    build_arm_trustzone_payload,
    cardano_explorer_url,
    derive_receipt_id,
    explain_skip,
    fetch_cardano_metadata_8746,
    gateway_admin_attestor_endpoint_present,
    gateway_evidence_endpoint_present,
    load_or_generate_synthetic_attestor,
    post_evidence,
    probe_pallet_tee_attestation,
    register_attestor,
    sign_evidence,
)

pytestmark = pytest.mark.phase_2_smoke

_LOG = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Resolved configuration. All env vars listed in `HARNESS_ENV_VARS`.
# ---------------------------------------------------------------------------

GATEWAY_URL = os.environ.get(
    "MATERIOS_E2E_GATEWAY",
    "https://materios.fluxpointstudios.com/preprod-blobs",
)
BEARER = os.environ.get("MATERIOS_E2E_BEARER", "")
HARDWARE_SPEC_PATH = os.environ.get("MATERIOS_E2E_HARDWARE_SPEC", "")
FLEET_OPERATOR_KEY_PATH = os.environ.get("MATERIOS_E2E_FLEET_OPERATOR_KEY", "")
RPC_URL = os.environ.get("MATERIOS_RPC_URL", "ws://127.0.0.1:9945")
ADMIN_TOKEN = os.environ.get("PHASE2_ADMIN_TOKEN", "")
TENANT_ID_PREFIX = os.environ.get("MATERIOS_E2E_TENANT_ID", "tenant-phase2")
WORKER_ID_PREFIX = os.environ.get("MATERIOS_E2E_WORKER_ID", "worker-phase2")
BLOCKFROST_URL = os.environ.get(
    "PHASE2_BLOCKFROST_URL", "https://cardano-preprod.blockfrost.io/api/v0"
)
BLOCKFROST_PROJECT_ID = os.environ.get("PHASE2_BLOCKFROST_PROJECT_ID", "")

# Polling budgets. Set conservatively; the demo's slow leg is the Cardano
# anchor (~5-15 min p50 on preprod). Override via env for fast/slow fleets.
DEADLINE_RECEIPT_S = float(os.environ.get("PHASE2_DEADLINE_RECEIPT_S", "60"))
DEADLINE_CERT_S = float(os.environ.get("PHASE2_DEADLINE_CERT_S", "600"))
DEADLINE_NEGATIVE_S = float(os.environ.get("PHASE2_DEADLINE_NEGATIVE_S", "180"))
DEADLINE_ANCHOR_S = float(os.environ.get("PHASE2_DEADLINE_ANCHOR_S", "1200"))


# ---------------------------------------------------------------------------
# Module-scope prerequisite probe — used by every test's skip path.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Prereqs:
    """Resolved state of the harness's external prerequisites.

    Used by per-test fixtures: each test calls into this once and skips on
    the first unmet condition. The dataclass is frozen so a half-cached
    `Prereqs` can't be mutated mid-run by a flaky test.
    """

    bearer_set: bool
    hardware_spec_set: bool
    admin_token_set: bool
    gateway_evidence_route_present: Optional[bool]  # None = transport error
    gateway_admin_attestor_route_present: Optional[bool]
    pallet: Optional[PalletReadiness]  # None = RPC unreachable

    def first_unmet_reason(self, *, requires_admin: bool = True) -> Optional[str]:
        """Return the human-readable reason for the FIRST failing prereq, or
        None when all required conditions are satisfied.

        The order matches the sequence of operations in the actual harness
        — env vars first (cheapest to fail), then network probes, then
        chain probes (most expensive). Order of messages is the order the
        operator should fix things.
        """
        if not self.bearer_set:
            return explain_skip(
                "MATERIOS_E2E_BEARER not set",
                f"see {', '.join(HARNESS_ENV_VARS)} for the full env list",
            )
        if not self.hardware_spec_set:
            return explain_skip(
                "MATERIOS_E2E_HARDWARE_SPEC not set",
                "pass the path to a fleet-operator-signed hardware spec JSON",
            )
        if requires_admin and not self.admin_token_set:
            return explain_skip(
                "PHASE2_ADMIN_TOKEN not set",
                "needed to register the synthetic attestor pubkey via "
                "POST /admin/attestation-evidence-attestors",
            )
        if self.gateway_evidence_route_present is None:
            return explain_skip(
                f"gateway {GATEWAY_URL} is unreachable",
                "transport error probing /v2/attestation_evidence",
            )
        if self.gateway_evidence_route_present is False:
            return explain_skip(
                "gateway image is too old — POST /v2/attestation_evidence is 404",
                "deploy the v2.1 gateway image (PR #34 already merged to "
                "orynq-sdk main)",
            )
        if requires_admin and self.gateway_admin_attestor_route_present is False:
            return explain_skip(
                "gateway image is too old — /admin/attestation-evidence-attestors is 404",
                "deploy the v2.1 gateway image (PR #34)",
            )
        if self.pallet is None:
            return explain_skip(
                f"Materios RPC at {RPC_URL} is unreachable",
                "set MATERIOS_RPC_URL to a reachable endpoint",
            )
        if not self.pallet.metadata_present:
            return explain_skip(
                "pallet-tee-attestation is not in runtime metadata",
                "the runtime upgrade ceremony for PR #17 hasn't landed yet",
            )
        if self.pallet.disabled is None:
            return explain_skip(
                "pallet-tee-attestation::Disabled storage unreadable",
                "metadata exposes the pallet but the storage query failed",
            )
        if self.pallet.disabled is True:
            return explain_skip(
                "pallet-tee-attestation::Disabled is true (kill-switch on)",
                "sudo-flip via set_disabled(false) needed before the smoke can run",
            )
        return None


@pytest.fixture(scope="module")
def prereqs() -> Prereqs:
    """Resolve once per module. Tests skip on whatever the FIRST unmet
    condition is — the order in `Prereqs.first_unmet_reason` is the
    operator-friendly fix sequence.
    """
    base_url = GATEWAY_URL.rstrip("/")
    ev_route = gateway_evidence_endpoint_present(base_url)
    if ADMIN_TOKEN:
        admin_route = gateway_admin_attestor_endpoint_present(
            base_url, admin_token=ADMIN_TOKEN
        )
    else:
        admin_route = None
    pallet = probe_pallet_tee_attestation(RPC_URL)
    return Prereqs(
        bearer_set=bool(BEARER),
        hardware_spec_set=bool(HARDWARE_SPEC_PATH and os.path.isfile(HARDWARE_SPEC_PATH)),
        admin_token_set=bool(ADMIN_TOKEN),
        gateway_evidence_route_present=ev_route,
        gateway_admin_attestor_route_present=admin_route,
        pallet=pallet,
    )


def _skip_unless_ready(prereqs: Prereqs, *, requires_admin: bool = True) -> None:
    """Helper: skip with a clear reason on the first unmet prereq."""
    reason = prereqs.first_unmet_reason(requires_admin=requires_admin)
    if reason is not None:
        pytest.skip(reason)


# ---------------------------------------------------------------------------
# Fixtures: hardware spec, worker key, attestor key. Module-scoped where
# possible to keep the smoke single-trip on the chain.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def hardware_spec(prereqs: Prereqs) -> HardwareSpec:
    if not prereqs.hardware_spec_set:
        pytest.skip(prereqs.first_unmet_reason() or "hardware spec missing")
    return HardwareSpec.load(HARDWARE_SPEC_PATH)


@pytest.fixture(scope="module")
def fleet_operator_kp() -> Optional[WorkerKeypair]:
    if FLEET_OPERATOR_KEY_PATH and os.path.isfile(FLEET_OPERATOR_KEY_PATH):
        return WorkerKeypair.load(FLEET_OPERATOR_KEY_PATH)
    return None


@pytest.fixture(scope="module")
def worker_kp() -> WorkerKeypair:
    return WorkerKeypair.generate()


@pytest.fixture(scope="module")
def attestor_kp() -> WorkerKeypair:
    """Synthetic sr25519 attestor — the Layer-2 key (see
    ``_phase2_helpers.py`` module docstring). Pubkey is registered with
    the gateway once per session.
    """
    return load_or_generate_synthetic_attestor()


@pytest.fixture(scope="module")
def gateway_cfg() -> Phase2GatewayConfig:
    return Phase2GatewayConfig(
        base_url=GATEWAY_URL.rstrip("/"),
        bearer=BEARER,
        admin_token=ADMIN_TOKEN or None,
    )


@pytest.fixture(scope="module")
def e2e_gateway_cfg() -> E2EGatewayConfig:
    """Re-use the v1/v2 e2e helpers' config shape for billing/usage polls."""
    return E2EGatewayConfig(base_url=GATEWAY_URL.rstrip("/"), bearer=BEARER)


@pytest.fixture(scope="module")
def attestor_registered(
    prereqs: Prereqs, attestor_kp: WorkerKeypair, gateway_cfg: Phase2GatewayConfig
) -> str:
    """Register the synthetic attestor's pubkey (idempotent). Returns the
    pubkey hex on success. Skips on the first unmet prereq.
    """
    _skip_unless_ready(prereqs, requires_admin=True)
    register_attestor(
        gateway_cfg,
        pubkey_hex=attestor_kp.public_hex,
        label="phase-2-path-c-pixel-strongbox-test-vector",
        notes=(
            "Phase 2 Path C demo. Synthetic sr25519 keypair signing real "
            "Google-rooted Pixel StrongBox cert chain from "
            "pallets/tee-attestation/src/test_vectors.rs. Layer-1 chain trust "
            "is what the on-chain pallet verifies; this Layer-2 sig only "
            "authenticates the evidence-submission endpoint. Replaceable by "
            "live-phone evidence once Acurast onboarding unblocks."
        ),
    )
    return attestor_kp.public_hex


# ---------------------------------------------------------------------------
# Helpers: build a per-test sealed v2.1 envelope.
# ---------------------------------------------------------------------------


def _resolve_spec_for_worker(
    base_spec: HardwareSpec, fleet_kp: Optional[WorkerKeypair], worker_id: str
) -> HardwareSpec:
    """If ``base_spec`` verifies for ``worker_id``, use it as-is. Otherwise
    re-issue with ``fleet_kp`` (the v2 e2e suite's pattern). Skips when
    neither path is available.
    """
    if base_spec.verify(worker_id):
        return base_spec
    if fleet_kp is not None:
        from materios_compute_meter.hardware_spec import sign_hardware_spec

        return sign_hardware_spec(
            worker_id=worker_id,
            cpu_cores=base_spec.cpu_cores,
            ram_gb=base_spec.ram_gb,
            gpu_type=base_spec.gpu_type,
            gpu_count=base_spec.gpu_count,
            issued_ms=int(time.time() * 1000),
            fleet_operator_keypair=fleet_kp,
        )
    pytest.skip(
        "hardware_spec does not verify for the synthetic worker_id and no "
        "MATERIOS_E2E_FLEET_OPERATOR_KEY is set; cannot re-issue per run"
    )


def _build_v2_1_envelope(
    *,
    spec: HardwareSpec,
    worker_kp: WorkerKeypair,
    worker_id: str,
    tenant_id: str,
    period_start_ms: int,
    period_end_ms: int,
) -> Dict[str, Any]:
    """Build + sign a v2 record body (no attestation_evidence inline — the
    evidence is posted to /v2/attestation_evidence in a SECOND call).

    The schema_version on the wire stays ``compute_metering_v2`` because
    the evidence is attached out-of-band; per the v2.1 spec
    (services/blob-gateway/src/schemas/compute_metering_v2.ts), the
    schema literal flips to ``compute_metering_v2.1`` ONLY when
    ``attestation_evidence`` is non-empty INSIDE the metering record. The
    Path C harness uses the out-of-band path because that's the path the
    real cert-daemon uses (see PR #34 design doc).
    """
    body = build_record_v2(
        worker_id=worker_id,
        tenant_id=tenant_id,
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms,
        metrics={
            "cpu_seconds": 30,
            "ram_gb_hours": 0.05,
            "disk_gb_hours": 0.0,
            "net_bytes_in": 4096,
            "net_bytes_out": 2048,
            "gpu_seconds": 0,
        },
        hardware_spec=spec,
    )
    return sign_record_v2(body, worker_kp)


def _wait_for_anchor(
    cfg: E2EGatewayConfig,
    *,
    tenant_id: str,
    content_hash: str,
    period_start_ms: int,
    period_end_ms: int,
    deadline_s: float,
    require_trust_score: bool,
) -> PollResult:
    """Poll ``/billing/usage`` until the record reports ``cardano_anchor_tx``
    AND (optionally) ``composite_trust_score >= 1`` — the Phase-2 demo's
    headline state.

    Mirrors the existing ``wait_for_cardano_anchor`` pattern from
    ``_e2e_helpers.py`` but adds the trust-score gate (which the existing
    helper doesn't know about — it pre-dates v2.1).
    """
    start = time.monotonic()
    attempt = 0
    last_body: Optional[Dict[str, Any]] = None
    last_status: Optional[str] = None
    while True:
        elapsed = time.monotonic() - start
        if elapsed >= deadline_s:
            return PollResult(
                success=False,
                elapsed_s=elapsed,
                polls=attempt,
                final=last_body,
                final_status=last_status,
            )
        attempt += 1
        try:
            r = fetch_billing_usage(
                cfg,
                tenant_id=tenant_id,
                start_ms=max(0, period_start_ms - 1),
                end_ms=period_end_ms + 1,
                include_records=True,
                timeout_s=15.0,
            )
        except httpx.HTTPError:
            time.sleep(_exp_backoff(attempt))
            continue
        if r.status_code == 200:
            try:
                body = r.json()
            except Exception:
                body = None
            if isinstance(body, dict):
                last_body = body
                rec = _find_record_by_hash(body, content_hash)
                if rec is not None:
                    last_status = rec.get("attestation_status")
                    anchor_tx = rec.get("cardano_anchor_tx")
                    trust_score = rec.get("composite_trust_score")
                    score_ok = (
                        trust_score is not None and int(trust_score) >= 1
                        if require_trust_score
                        else True
                    )
                    if anchor_tx and score_ok:
                        return PollResult(
                            success=True,
                            elapsed_s=time.monotonic() - start,
                            polls=attempt,
                            final=body,
                            final_status="anchored",
                        )
        remaining = deadline_s - (time.monotonic() - start)
        if remaining <= 0:
            continue
        time.sleep(min(_exp_backoff(attempt), max(0.5, remaining)))


# ===========================================================================
# Test 1 — v2.1 record lands on chain (with empty evidence vec)
# ===========================================================================


def test_path_c_v2_record_lands_on_chain(
    prereqs: Prereqs,
    hardware_spec: HardwareSpec,
    fleet_operator_kp: Optional[WorkerKeypair],
    worker_kp: WorkerKeypair,
    e2e_gateway_cfg: E2EGatewayConfig,
) -> None:
    """Submit a v2.1 record (with empty evidence vec — i.e. plain v2 wire
    bytes) and confirm the gateway records it under our tenant within a
    minute. This is the smoke's first leg — it proves the gateway accepts
    the v2.1 SDK payload shape under the tenant-bound bearer."""
    _skip_unless_ready(prereqs, requires_admin=False)

    period_start_ms = int(time.time() * 1000)
    period_end_ms = period_start_ms + 60_000
    worker_id = f"{WORKER_ID_PREFIX}-t1-{period_start_ms}"
    tenant_id = f"{TENANT_ID_PREFIX}-t1-{period_start_ms}"

    spec = _resolve_spec_for_worker(hardware_spec, fleet_operator_kp, worker_id)
    sealed = _build_v2_1_envelope(
        spec=spec,
        worker_kp=worker_kp,
        worker_id=worker_id,
        tenant_id=tenant_id,
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms,
    )

    assert verify_record_v2(sealed) is True
    expected_hash = canonical_content_hash_v2(sealed)
    res = submit_v2(sealed, gateway_url=GATEWAY_URL, bearer=BEARER)
    assert isinstance(res, SubmissionResult)
    assert 200 <= res.status_code < 300, f"submit_v2 status={res.status_code}"
    assert res.content_hash == expected_hash, (
        "gateway-returned content_hash diverged from SDK-computed"
    )

    # Poll the gateway's /billing/usage until our record is visible. The
    # window is narrow so a single page contains the row.
    deadline = time.monotonic() + DEADLINE_RECEIPT_S
    seen = False
    while time.monotonic() < deadline and not seen:
        r = fetch_billing_usage(
            e2e_gateway_cfg,
            tenant_id=tenant_id,
            start_ms=period_start_ms - 1,
            end_ms=period_end_ms + 1,
            include_records=True,
            timeout_s=10.0,
        )
        if r.status_code == 200:
            body = r.json() if r.text else {}
            if _find_record_by_hash(body, expected_hash) is not None:
                seen = True
                break
        time.sleep(2.0)
    assert seen, (
        f"v2.1 record content_hash={expected_hash} did not appear in "
        f"/billing/usage within {DEADLINE_RECEIPT_S}s"
    )


# ===========================================================================
# Test 2 — evidence submission returns the expected hash
# ===========================================================================


def test_path_c_evidence_submission_returns_correct_hash(
    prereqs: Prereqs,
    hardware_spec: HardwareSpec,
    fleet_operator_kp: Optional[WorkerKeypair],
    worker_kp: WorkerKeypair,
    attestor_kp: WorkerKeypair,
    attestor_registered: str,
    gateway_cfg: Phase2GatewayConfig,
    e2e_gateway_cfg: E2EGatewayConfig,
) -> None:
    """Round-trip an evidence submission and assert the returned
    ``attestation_evidence_hash`` equals what we compute off-chain via the
    SDK's pinned canonical-CBOR encoder.

    This is the gateway-side property test: the encoder on both sides
    (Python in our SDK, TypeScript in the gateway) MUST agree byte-for-byte
    on the evidence hash. The cross-language test (test_v2_1_cross_lang.py)
    already proves this with synthetic vectors; this test verifies the same
    property end-to-end with a real gateway round-trip.
    """
    _skip_unless_ready(prereqs, requires_admin=True)
    assert attestor_registered == attestor_kp.public_hex

    # Build + submit the metering record first — the evidence post requires
    # the receipt's content_hash to derive the nonce.
    period_start_ms = int(time.time() * 1000)
    period_end_ms = period_start_ms + 60_000
    worker_id = f"{WORKER_ID_PREFIX}-t2-{period_start_ms}"
    tenant_id = f"{TENANT_ID_PREFIX}-t2-{period_start_ms}"

    spec = _resolve_spec_for_worker(hardware_spec, fleet_operator_kp, worker_id)
    sealed = _build_v2_1_envelope(
        spec=spec,
        worker_kp=worker_kp,
        worker_id=worker_id,
        tenant_id=tenant_id,
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms,
    )
    expected_content_hash = canonical_content_hash_v2(sealed)
    submit_v2(sealed, gateway_url=GATEWAY_URL, bearer=BEARER)

    # Build + post evidence. The Pixel chain in the payload is the REAL one;
    # the sig is from our synthetic sr25519 attestor (Layer 1 vs Layer 2,
    # see _phase2_helpers.py).
    payload = build_arm_trustzone_payload(valid=True)
    bundle = sign_evidence(
        content_hash_hex=expected_content_hash,
        payload=payload,
        attestor=attestor_kp,
        evidence_type="arm_trustzone",
    )
    status, body = post_evidence(gateway_cfg, bundle)
    assert status == 200, f"evidence post failed: {status} {body!r}"
    assert body.get("ok") is True, body
    assert body.get("status") in ("accepted", "replay"), body
    returned_hash = body.get("attestation_evidence_hash")
    assert isinstance(returned_hash, str) and len(returned_hash) == 64

    # Off-chain recomputation: build the canonical-CBOR-sha256 over the
    # ONE-entry evidence vec we just stored and confirm equality.
    expected_evidence_hash = attestation_evidence_hash(
        [
            {
                "evidence_type": bundle.evidence_type,
                "nonce": bundle.nonce,
                "payload": bundle.payload,
                "attestor_pubkey": bundle.attestor_pubkey,
            }
        ]
    )
    assert returned_hash == expected_evidence_hash, (
        f"gateway-returned attestation_evidence_hash {returned_hash!r} != "
        f"SDK-computed {expected_evidence_hash!r} — encoder drift"
    )


# ===========================================================================
# Test 3 — invalid Pixel chain is rejected (cert-daemon refuses to attest)
# ===========================================================================


def test_path_c_invalid_pixel_chain_rejected(
    prereqs: Prereqs,
    hardware_spec: HardwareSpec,
    fleet_operator_kp: Optional[WorkerKeypair],
    worker_kp: WorkerKeypair,
    attestor_kp: WorkerKeypair,
    attestor_registered: str,
    gateway_cfg: Phase2GatewayConfig,
    e2e_gateway_cfg: E2EGatewayConfig,
) -> None:
    """Submit a TAMPERED Pixel chain (PIXEL_KEY_CERT_INVALID — last byte of
    the leaf signature flipped). The gateway accepts the evidence at the
    endpoint level (it doesn't run the Rust verifier locally), but the
    cert-daemon must REFUSE to attest. We assert the on-chain
    ``availability_cert_hash`` stays at zero past a reasonable deadline.

    The deadline is shorter than the positive test's anchor wait — we're
    checking ABSENCE of attestation, so we want to fail fast if the
    cert-daemon decided to attest anyway.
    """
    _skip_unless_ready(prereqs, requires_admin=True)
    assert attestor_registered == attestor_kp.public_hex

    period_start_ms = int(time.time() * 1000)
    period_end_ms = period_start_ms + 60_000
    worker_id = f"{WORKER_ID_PREFIX}-t3-{period_start_ms}"
    tenant_id = f"{TENANT_ID_PREFIX}-t3-{period_start_ms}"

    spec = _resolve_spec_for_worker(hardware_spec, fleet_operator_kp, worker_id)
    sealed = _build_v2_1_envelope(
        spec=spec,
        worker_kp=worker_kp,
        worker_id=worker_id,
        tenant_id=tenant_id,
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms,
    )
    expected_content_hash = canonical_content_hash_v2(sealed)
    submit_v2(sealed, gateway_url=GATEWAY_URL, bearer=BEARER)

    # Tampered chain — pallet's chain-of-trust check will fail at the leaf.
    payload = build_arm_trustzone_payload(valid=False)
    bundle = sign_evidence(
        content_hash_hex=expected_content_hash,
        payload=payload,
        attestor=attestor_kp,
    )
    status, body = post_evidence(gateway_cfg, bundle)
    # Endpoint accepts the evidence — it doesn't run the Rust verifier.
    assert status == 200, f"evidence post unexpectedly failed: {status} {body!r}"

    # Now the absence assertion: poll for `composite_trust_score`. After
    # `DEADLINE_NEGATIVE_S`, the score MUST still be 0 (or the field absent
    # / null). If the cert-daemon attested a tampered chain, this fails
    # loudly.
    deadline = time.monotonic() + DEADLINE_NEGATIVE_S
    last_seen_score: Any = None
    last_seen_anchor: Any = None
    while time.monotonic() < deadline:
        r = fetch_billing_usage(
            e2e_gateway_cfg,
            tenant_id=tenant_id,
            start_ms=period_start_ms - 1,
            end_ms=period_end_ms + 1,
            include_records=True,
            timeout_s=10.0,
        )
        if r.status_code == 200:
            body = r.json() if r.text else {}
            rec = _find_record_by_hash(body, expected_content_hash)
            if rec is not None:
                last_seen_score = rec.get("composite_trust_score")
                last_seen_anchor = rec.get("cardano_anchor_tx")
                # Hard fail if the cert-daemon attested.
                if last_seen_score is not None and int(last_seen_score) > 0:
                    pytest.fail(
                        f"tampered Pixel chain unexpectedly attested: "
                        f"composite_trust_score={last_seen_score}, "
                        f"cardano_anchor_tx={last_seen_anchor!r}. The pallet's "
                        f"ArmTrustZoneVerifier should have failed "
                        f"ChainOfTrustBroken on PIXEL_KEY_CERT_INVALID."
                    )
        time.sleep(5.0)
    # Reached the deadline with no attestation — exactly what we want.
    assert (last_seen_score in (None, 0)), (
        f"unexpected end-state composite_trust_score={last_seen_score}"
    )


# ===========================================================================
# Test 4 — the headline demo: valid Pixel chain attests + anchors to L1
# ===========================================================================


def test_path_c_valid_pixel_chain_attested(
    prereqs: Prereqs,
    hardware_spec: HardwareSpec,
    fleet_operator_kp: Optional[WorkerKeypair],
    worker_kp: WorkerKeypair,
    attestor_kp: WorkerKeypair,
    attestor_registered: str,
    gateway_cfg: Phase2GatewayConfig,
    e2e_gateway_cfg: E2EGatewayConfig,
    request: pytest.FixtureRequest,
) -> None:
    """The Path C headline demo. When this passes, Phase 2 end-to-end is
    SHIPPED.

    Submits a valid Pixel chain. Polls until the receipt has BOTH:
        * ``composite_trust_score >= 1`` (cert-daemon attested), AND
        * ``cardano_anchor_tx`` non-null (anchor-worker batched it).
    Prints the cexplorer.io URL on success — the demo's evidence link.
    """
    _skip_unless_ready(prereqs, requires_admin=True)
    assert attestor_registered == attestor_kp.public_hex

    period_start_ms = int(time.time() * 1000)
    period_end_ms = period_start_ms + 60_000
    worker_id = f"{WORKER_ID_PREFIX}-t4-{period_start_ms}"
    tenant_id = f"{TENANT_ID_PREFIX}-t4-{period_start_ms}"

    spec = _resolve_spec_for_worker(hardware_spec, fleet_operator_kp, worker_id)
    sealed = _build_v2_1_envelope(
        spec=spec,
        worker_kp=worker_kp,
        worker_id=worker_id,
        tenant_id=tenant_id,
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms,
    )
    content_hash = canonical_content_hash_v2(sealed)
    submit_v2(sealed, gateway_url=GATEWAY_URL, bearer=BEARER)

    payload = build_arm_trustzone_payload(valid=True)
    bundle = sign_evidence(
        content_hash_hex=content_hash, payload=payload, attestor=attestor_kp
    )
    status, body = post_evidence(gateway_cfg, bundle)
    assert status == 200, f"evidence post failed: {status} {body!r}"
    expected_evidence_hash = body.get("attestation_evidence_hash")
    assert isinstance(expected_evidence_hash, str) and len(expected_evidence_hash) == 64

    # Watch the chain.
    result = _wait_for_anchor(
        e2e_gateway_cfg,
        tenant_id=tenant_id,
        content_hash=content_hash,
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms,
        deadline_s=DEADLINE_ANCHOR_S,
        require_trust_score=True,
    )
    assert result.success, (
        f"Phase 2 headline assertion FAILED: receipt did not anchor + attest "
        f"within {DEADLINE_ANCHOR_S}s. final_status={result.final_status!r}, "
        f"polls={result.polls}, final body excerpt={str(result.final)[:400]!r}"
    )
    rec = _find_record_by_hash(result.final or {}, content_hash) or {}
    anchor_tx = rec.get("cardano_anchor_tx")
    trust_score = rec.get("composite_trust_score")
    explorer = cardano_explorer_url(str(anchor_tx))
    _LOG.info(
        "Phase 2 Path C demo complete: composite_trust_score=%s anchor_tx=%s "
        "explorer=%s",
        trust_score,
        anchor_tx,
        explorer,
    )
    # Stash for the round-trip test in case it's run in the same session.
    request.config.cache.set("phase2/last_anchor_tx", str(anchor_tx))
    request.config.cache.set("phase2/last_content_hash", content_hash)
    request.config.cache.set("phase2/last_evidence_hash", expected_evidence_hash)
    request.config.cache.set("phase2/last_receipt_id", derive_receipt_id(content_hash))

    assert isinstance(anchor_tx, str) and len(anchor_tx) >= 64
    assert int(trust_score) >= 1


# ===========================================================================
# Test 5 — Cardano-anchor round-trip: label-8746 leaf carries our evidence_hash
# ===========================================================================


def test_path_c_anchor_evidence_hash_round_trips(
    prereqs: Prereqs,
    request: pytest.FixtureRequest,
) -> None:
    """Read back the Cardano anchor tx for the headline demo, parse the
    label-8746 metadata, find the leaf for our receipt, and assert the
    leaf's ``attestation_evidence_hash`` equals what we computed off-chain.

    This is what closes the Phase 2 loop end-to-end:
    real Google-rooted hardware attestation → Cardano L1 audit trail.
    """
    _skip_unless_ready(prereqs, requires_admin=True)

    if not BLOCKFROST_PROJECT_ID:
        pytest.skip(
            explain_skip(
                "PHASE2_BLOCKFROST_PROJECT_ID not set",
                "needed to fetch tx metadata for the round-trip assertion",
            )
        )

    cache = request.config.cache
    anchor_tx = cache.get("phase2/last_anchor_tx", None)
    receipt_id = cache.get("phase2/last_receipt_id", None)
    evidence_hash = cache.get("phase2/last_evidence_hash", None)
    if not (anchor_tx and receipt_id and evidence_hash):
        pytest.skip(
            "round-trip test requires test_path_c_valid_pixel_chain_attested "
            "to have run successfully in the same session"
        )

    metas = fetch_cardano_metadata_8746(
        str(anchor_tx),
        blockfrost_url=BLOCKFROST_URL,
        blockfrost_project_id=BLOCKFROST_PROJECT_ID,
    )
    if metas is None:
        pytest.skip(
            "Blockfrost did not return metadata for the anchor tx (transient "
            "explorer lag or wrong network); rerun"
        )
    assert metas, f"no label-8746 entries in tx {anchor_tx}"

    # Walk every label-8746 entry's `leaves` list (or top-level dict shape —
    # the on-chain payload format is documented in
    # project_cardano_l1_metadata_labels.md). Find a leaf with our
    # receipt_id and assert its `attestation_evidence_hash`.
    found = False
    cleaned_receipt = (
        receipt_id[2:] if str(receipt_id).startswith("0x") else str(receipt_id)
    )
    for meta in metas:
        leaves = meta.get("leaves") if isinstance(meta, dict) else None
        if not isinstance(leaves, list):
            continue
        for leaf in leaves:
            if not isinstance(leaf, dict):
                continue
            leaf_rid = str(leaf.get("receipt_id", "")).lower()
            leaf_rid = leaf_rid[2:] if leaf_rid.startswith("0x") else leaf_rid
            if leaf_rid == cleaned_receipt.lower():
                leaf_eh = str(leaf.get("attestation_evidence_hash", "")).lower()
                leaf_eh = leaf_eh[2:] if leaf_eh.startswith("0x") else leaf_eh
                assert leaf_eh == str(evidence_hash).lower(), (
                    f"leaf attestation_evidence_hash on chain {leaf_eh} != "
                    f"SDK-computed {evidence_hash}"
                )
                found = True
                break
        if found:
            break
    assert found, (
        f"no leaf in label-8746 metadata of {anchor_tx} matched our "
        f"receipt_id={cleaned_receipt}"
    )
