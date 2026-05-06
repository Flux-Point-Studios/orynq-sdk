"""LIVE preprod E2E test for compute_metering_v2 envelopes.

Gated by `MATERIOS_E2E_BEARER` AND `MATERIOS_E2E_HARDWARE_SPEC` per the
team-3 brief. Skips gracefully (with a clear reason) when either is unset
or when the gateway hasn't shipped the v2 route yet.

Manual setup:

    export MATERIOS_E2E_BEARER="matra_<your_token>"

    # OPTION A — hardware spec bound to a single fixed worker_id
    export MATERIOS_E2E_HARDWARE_SPEC="/path/to/fleet-signed-hardware.json"
    export MATERIOS_E2E_WORKER_ID="<the worker_id baked into the spec>"

    # OPTION B — fleet operator key on disk; tests will generate per-run
    # specs so each test gets a unique worker_id without re-issuing.
    # (Same env var, set BOTH:)
    export MATERIOS_E2E_HARDWARE_SPEC="/path/to/fleet-signed-hardware.json"
    export MATERIOS_E2E_FLEET_OPERATOR_KEY="/path/to/fleet-operator-key.json"

    # Optional:
    export MATERIOS_E2E_GATEWAY="https://materios.fluxpointstudios.com/preprod-blobs"
    export MATERIOS_E2E_WORKER_KEY="/path/to/worker-key.json"
    export MATERIOS_E2E_OBSERVER_KEY="/path/to/observer-key.json"
    export MATERIOS_E2E_TENANT_ID="tenant-acme"

    .venv/bin/pytest tests/test_v2_e2e_preprod.py -v -m e2e

If MATERIOS_E2E_WORKER_KEY is unset, a fresh keypair is generated for the
run (the gateway should accept any sr25519 pubkey because the hardware
spec is what binds identity in v2).
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

from materios_compute_meter.canonical import canonical_content_hash_v2
from materios_compute_meter.exceptions import GatewayError
from materios_compute_meter.hardware_spec import HardwareSpec, sign_hardware_spec
from materios_compute_meter.keypair import ObserverKeypair, WorkerKeypair
from materios_compute_meter.record import (
    attach_observer_signature_v2,
    build_record_v2,
    sign_record_v2,
    verify_record_v2,
)
from materios_compute_meter.submit import SubmissionResult, submit_v2

pytestmark = pytest.mark.e2e


GATEWAY_URL = os.environ.get(
    "MATERIOS_E2E_GATEWAY",
    "https://materios.fluxpointstudios.com/preprod-blobs",
)
BEARER = os.environ.get("MATERIOS_E2E_BEARER", "")
HARDWARE_SPEC_PATH = os.environ.get("MATERIOS_E2E_HARDWARE_SPEC", "")
FLEET_OPERATOR_KEY_PATH = os.environ.get("MATERIOS_E2E_FLEET_OPERATOR_KEY", "")
WORKER_KEY_PATH = os.environ.get("MATERIOS_E2E_WORKER_KEY", "")
OBSERVER_KEY_PATH = os.environ.get("MATERIOS_E2E_OBSERVER_KEY", "")
TENANT_ID = os.environ.get("MATERIOS_E2E_TENANT_ID", "tenant-e2e")
WORKER_ID_PREFIX = os.environ.get("MATERIOS_E2E_WORKER_ID", "worker-e2e")


def _gateway_route_ready() -> str:
    """Probe the v2 metering route. Returns one of:

      * "ready"           — gateway returns a 4xx (not 404) for an empty
                            POST. Means route exists and accepts our shape.
      * "v1-only"         — gateway accepts /metering/submit but rejects
                            schema_version=compute_metering_v2 with
                            WRONG_SCHEMA_VERSION; Team 2 hasn't shipped.
      * "404"             — route doesn't exist yet.
      * "unreachable"     — network / DNS / TLS error.
    """
    try:
        with httpx.Client(timeout=8.0) as c:
            # Probe with a v2 schema_version to detect v1-only validators.
            r = c.post(
                f"{GATEWAY_URL}/metering/submit",
                json={"schema_version": "compute_metering_v2"},
                headers={"authorization": "Bearer probe"},
            )
            if r.status_code == 404:
                return "404"
            try:
                body = r.json()
            except Exception:
                body = None
            if (
                isinstance(body, dict)
                and body.get("code") == "WRONG_SCHEMA_VERSION"
                and "compute_metering_v1" in str(body.get("message", ""))
            ):
                return "v1-only"
            return "ready"
    except httpx.HTTPError:
        return "unreachable"


@pytest.fixture(scope="module")
def env_ready() -> None:
    if not BEARER:
        pytest.skip(
            "MATERIOS_E2E_BEARER not set — see test_v2_e2e_preprod.py "
            "module docstring for setup."
        )
    if not HARDWARE_SPEC_PATH:
        pytest.skip(
            "MATERIOS_E2E_HARDWARE_SPEC not set — pass the path to a "
            "fleet-operator-signed hardware spec JSON."
        )
    if not os.path.isfile(HARDWARE_SPEC_PATH):
        pytest.skip(
            f"MATERIOS_E2E_HARDWARE_SPEC={HARDWARE_SPEC_PATH!r} does not "
            "exist. Cannot run live E2E."
        )


@pytest.fixture(scope="module")
def gateway_ready() -> None:
    status = _gateway_route_ready()
    if status == "unreachable":
        pytest.skip(
            f"Gateway {GATEWAY_URL} is unreachable from this host."
        )
    if status == "404":
        pytest.skip(
            f"Gateway {GATEWAY_URL}/metering/submit is 404 — neither v1 "
            "nor v2 metering routes are deployed."
        )
    if status == "v1-only":
        pytest.skip(
            f"Gateway {GATEWAY_URL}/metering/submit accepts only "
            "compute_metering_v1 — Team 2's v2 validator hasn't shipped "
            "yet. The SDK's wire format is correct (verified by the "
            "cross-language test); re-run this E2E after the gateway "
            "v2 route deploys."
        )


@pytest.fixture(scope="module")
def hardware_spec(env_ready) -> HardwareSpec:
    return HardwareSpec.load(HARDWARE_SPEC_PATH)


@pytest.fixture(scope="module")
def fleet_operator_kp() -> WorkerKeypair:
    """If MATERIOS_E2E_FLEET_OPERATOR_KEY is set, load that key. Otherwise
    return None — tests that need per-run hw spec generation will skip
    if this fixture is None."""
    if FLEET_OPERATOR_KEY_PATH and os.path.isfile(FLEET_OPERATOR_KEY_PATH):
        return WorkerKeypair.load(FLEET_OPERATOR_KEY_PATH)
    return None


def _per_run_hw_spec(
    fleet_kp: WorkerKeypair, base_spec: HardwareSpec, worker_id: str
) -> HardwareSpec:
    """Re-issue the hardware spec for `worker_id` using the fleet operator
    key. Used by E2E tests so each run gets a unique worker_id."""
    return sign_hardware_spec(
        worker_id=worker_id,
        cpu_cores=base_spec.cpu_cores,
        ram_gb=base_spec.ram_gb,
        gpu_type=base_spec.gpu_type,
        gpu_count=base_spec.gpu_count,
        issued_ms=int(time.time() * 1000),
        fleet_operator_keypair=fleet_kp,
    )


@pytest.fixture(scope="module")
def worker_kp() -> WorkerKeypair:
    if WORKER_KEY_PATH and os.path.isfile(WORKER_KEY_PATH):
        return WorkerKeypair.load(WORKER_KEY_PATH)
    return WorkerKeypair.generate()


@pytest.fixture(scope="module")
def observer_kp() -> ObserverKeypair:
    if OBSERVER_KEY_PATH and os.path.isfile(OBSERVER_KEY_PATH):
        return ObserverKeypair.load(OBSERVER_KEY_PATH)
    return ObserverKeypair.generate()


def _make_v2_envelope(
    *,
    spec: HardwareSpec,
    worker_kp: WorkerKeypair,
    observer_kp: ObserverKeypair = None,
    worker_id: str,
    period_start_ms: int,
    period_end_ms: int,
) -> dict:
    body = build_record_v2(
        worker_id=worker_id,
        tenant_id=TENANT_ID,
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
    sealed = sign_record_v2(body, worker_kp)
    if observer_kp is not None:
        sealed = attach_observer_signature_v2(sealed, observer_kp)
    return sealed


def _resolve_spec_for_worker(
    base_spec: HardwareSpec,
    fleet_operator_kp,
    worker_id: str,
) -> HardwareSpec:
    """If the base spec verifies for `worker_id`, use it. Otherwise, if a
    fleet operator key is available, re-issue. Otherwise skip the test."""
    if base_spec.verify(worker_id):
        return base_spec
    if fleet_operator_kp is not None:
        return _per_run_hw_spec(fleet_operator_kp, base_spec, worker_id)
    pytest.skip(
        f"hardware_spec at {HARDWARE_SPEC_PATH} does not verify for "
        f"worker_id={worker_id!r}. Either set MATERIOS_E2E_WORKER_ID "
        "to the worker_id baked into the spec, OR set "
        "MATERIOS_E2E_FLEET_OPERATOR_KEY so the test can re-issue per run."
    )


def test_live_v2_submit_no_observer_round_trips(
    env_ready,
    gateway_ready,
    hardware_spec: HardwareSpec,
    worker_kp: WorkerKeypair,
    fleet_operator_kp,
) -> None:
    """End-to-end: build → sign → submit → assert gateway echoes the SAME
    canonical content_hash the SDK computed locally."""
    period_start_ms = int(time.time() * 1000)
    period_end_ms = period_start_ms + 60_000
    worker_id = f"{WORKER_ID_PREFIX}-noobs-{period_start_ms}"

    spec = _resolve_spec_for_worker(hardware_spec, fleet_operator_kp, worker_id)

    sealed = _make_v2_envelope(
        spec=spec,
        worker_kp=worker_kp,
        observer_kp=None,
        worker_id=worker_id,
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms,
    )
    # Local verify before submit — defense in depth.
    assert verify_record_v2(sealed) is True
    expected_hash = canonical_content_hash_v2(sealed)

    res = submit_v2(sealed, gateway_url=GATEWAY_URL, bearer=BEARER)
    assert isinstance(res, SubmissionResult)
    assert 200 <= res.status_code < 300
    assert res.content_hash == expected_hash
    assert isinstance(res.receipt_id, str) and len(res.receipt_id) > 0


def test_live_v2_submit_with_observer_round_trips(
    env_ready,
    gateway_ready,
    hardware_spec: HardwareSpec,
    worker_kp: WorkerKeypair,
    observer_kp: ObserverKeypair,
    fleet_operator_kp,
) -> None:
    """Wave 2 path: observer co-sig present. The gateway should still
    return a content_hash matching the worker's pre-image (observer
    doesn't change the content_hash)."""
    period_start_ms = int(time.time() * 1000) + 1_000  # +1s vs no-observer
    period_end_ms = period_start_ms + 60_000
    worker_id = f"{WORKER_ID_PREFIX}-obs-{period_start_ms}"

    spec = _resolve_spec_for_worker(hardware_spec, fleet_operator_kp, worker_id)

    sealed = _make_v2_envelope(
        spec=spec,
        worker_kp=worker_kp,
        observer_kp=observer_kp,
        worker_id=worker_id,
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms,
    )
    assert verify_record_v2(sealed) is True
    expected_hash = canonical_content_hash_v2(sealed)

    res = submit_v2(sealed, gateway_url=GATEWAY_URL, bearer=BEARER)
    assert 200 <= res.status_code < 300
    assert res.content_hash == expected_hash


def test_live_v2_replay_rejected_by_gateway(
    env_ready,
    gateway_ready,
    hardware_spec: HardwareSpec,
    worker_kp: WorkerKeypair,
    fleet_operator_kp,
) -> None:
    """Submit twice with the SAME (worker_id, period_start_ms). The SECOND
    submit must be rejected — by the SDK's local cache OR by the gateway's
    server-side de-dupe at the (worker_pubkey, period_start_ms) tuple."""
    from materios_compute_meter.exceptions import ReplayRejectedError

    period_start_ms = int(time.time() * 1000) + 2_000
    period_end_ms = period_start_ms + 60_000
    worker_id = f"{WORKER_ID_PREFIX}-replay-{period_start_ms}"

    spec = _resolve_spec_for_worker(hardware_spec, fleet_operator_kp, worker_id)

    sealed = _make_v2_envelope(
        spec=spec,
        worker_kp=worker_kp,
        observer_kp=None,
        worker_id=worker_id,
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms,
    )
    submit_v2(sealed, gateway_url=GATEWAY_URL, bearer=BEARER)

    # Second submit: same record. Either the SDK's local cache rejects
    # (preferred — saves a network round trip) OR the gateway returns 409.
    try:
        submit_v2(sealed, gateway_url=GATEWAY_URL, bearer=BEARER)
    except ReplayRejectedError:
        pass  # local cache caught it — perfect.
    except GatewayError as e:
        # Gateway-side de-dupe: 409 conflict is the expected status.
        assert e.status in (409, 422), (
            f"expected 409 (or 422) on duplicate, got {e.status}"
        )
    else:
        pytest.fail(
            "duplicate submit was accepted by both SDK and gateway — "
            "replay protection regressed"
        )
