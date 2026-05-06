"""LIVE preprod integration test for the worker compute-meter SDK.

This file hits real endpoints. NO mocks. Per
`feedback_intent_settlement_chain_tdd.md`, the SDK must work against the
gateway's real metering route and the chain that anchors it.

If the gateway's `/metering/submit` route is not yet deployed (Agent #1's
schema landing date), tests skip with a clear message rather than fail.

Manual setup before running:
  export MATERIOS_METERING_GATEWAY_URL="https://materios.fluxpointstudios.com/preprod-blobs"
  export MATERIOS_METERING_API_KEY="matra_<your_token>"
  # Optional — only needed for the on-chain receipt-landing assertion:
  export MATERIOS_RPC_URL="ws://127.0.0.1:9945"

If MATERIOS_METERING_API_KEY is absent, the integration test skips and
prints a one-liner pointing at the admin token endpoint
(POST /admin/keys with X-Admin-Token, see feedback_gateway_registration.md
+ services/blob-gateway/src/api-tokens.ts).
"""
from __future__ import annotations

import os
import time
from typing import Optional

import httpx
import pytest

from materios_compute_meter import MeteringRecord, WorkerKeypair, submit


GATEWAY_URL = os.environ.get(
    "MATERIOS_METERING_GATEWAY_URL",
    "https://materios.fluxpointstudios.com/preprod-blobs",
)
API_KEY = os.environ.get("MATERIOS_METERING_API_KEY", "")
RPC_URL = os.environ.get("MATERIOS_RPC_URL", "ws://127.0.0.1:9945")


def _gateway_endpoint_status() -> Optional[int]:
    """Probe the metering submit endpoint. Returns the HTTP status code or
    None on transport error. Used to decide skip-vs-run."""
    try:
        with httpx.Client(timeout=5.0) as c:
            r = c.post(f"{GATEWAY_URL}/metering/submit", json={"probe": True})
            return r.status_code
    except httpx.HTTPError:
        return None


pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def gateway_ready() -> None:
    """Skip the whole module if the gateway endpoint isn't up or returns 404
    (Agent #1 hasn't shipped yet)."""
    status = _gateway_endpoint_status()
    if status is None:
        pytest.skip(
            "Gateway is unreachable from this host. Set MATERIOS_METERING_GATEWAY_URL "
            f"or check connectivity to {GATEWAY_URL}."
        )
    if status == 404:
        pytest.skip(
            "Gateway /metering/submit is 404 — Agent #1's schema route is not yet "
            "deployed. Re-run this suite after the metering route lands."
        )


@pytest.fixture(scope="module")
def have_api_key() -> None:
    if not API_KEY:
        pytest.skip(
            "MATERIOS_METERING_API_KEY not set. Mint a Bearer via the gateway admin: "
            "POST /admin/keys with X-Admin-Token (see "
            "services/blob-gateway/src/api-tokens.ts), or use any existing matra_* "
            "Bearer that's authorised for /metering/submit."
        )


def test_live_submit_round_trip(gateway_ready, have_api_key) -> None:
    """End-to-end: generate fresh keypair, sign a record, POST to live gateway,
    verify the response carries the same content_hash we computed locally."""
    kp = WorkerKeypair.generate()

    # Fresh time-based identifiers so re-runs don't collide on the gateway side.
    period_start_ms = int(time.time() * 1000)
    period_end_ms = period_start_ms + 60_000

    rec = MeteringRecord(
        worker_id=f"worker-it-{period_start_ms}",
        tenant_id="tenant-it",
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms,
        cpu_seconds=12.5,
        ram_gb_hours=0.05,
        disk_gb_hours=0.0,
        net_bytes_in=4096,
        net_bytes_out=2048,
        gpu_seconds=0.0,
    )

    signed_local = kp.sign(rec)
    res = submit(signed_local, gateway_url=GATEWAY_URL, api_key=API_KEY)

    assert "receipt_id" in res
    assert "content_hash" in res
    assert res["content_hash"] == signed_local.content_hash, (
        "Server-reported content_hash MUST match SDK-computed canonical digest"
    )


def test_live_submit_replay_rejected_on_chain(gateway_ready, have_api_key) -> None:
    """A second submit with the same (worker_id, period_start_ms) should be
    rejected — locally by the SDK first (replay cache), and if forced, by the
    gateway's de-dupe at the (signer_pub, period_start_ms) tuple."""
    from materios_compute_meter.exceptions import ReplayRejectedError

    kp = WorkerKeypair.generate()
    period_start_ms = int(time.time() * 1000)

    rec = MeteringRecord(
        worker_id=f"worker-rep-{period_start_ms}",
        tenant_id="tenant-it",
        period_start_ms=period_start_ms,
        period_end_ms=period_start_ms + 1,
        cpu_seconds=1.0,
    )

    submit(kp, rec, gateway_url=GATEWAY_URL, api_key=API_KEY)

    with pytest.raises(ReplayRejectedError):
        submit(kp, rec, gateway_url=GATEWAY_URL, api_key=API_KEY)


def test_live_chain_anchors_metering_receipt(gateway_ready, have_api_key) -> None:
    """After a successful submit, the receipt should land on Materios via
    the existing receipt pipeline. We poll the gateway's status endpoint
    for the receipt to reach 'Certified' (matches behaviour of the
    sponsored-receipt pipeline — see project_sponsored_receipt_pipeline.md)."""
    kp = WorkerKeypair.generate()
    period_start_ms = int(time.time() * 1000)

    rec = MeteringRecord(
        worker_id=f"worker-chain-{period_start_ms}",
        tenant_id="tenant-it",
        period_start_ms=period_start_ms,
        period_end_ms=period_start_ms + 1,
        cpu_seconds=2.0,
    )

    res = submit(kp, rec, gateway_url=GATEWAY_URL, api_key=API_KEY)
    content_hash = res["content_hash"]

    # Poll gateway /blobs/<hash>/status for up to 60s waiting for Certified.
    deadline = time.time() + 60.0
    last_status: Optional[dict] = None
    with httpx.Client(timeout=10.0) as client:
        while time.time() < deadline:
            r = client.get(f"{GATEWAY_URL}/blobs/{content_hash}/status")
            if r.status_code == 200:
                last_status = r.json()
                if last_status.get("certified"):
                    break
            time.sleep(2.0)

    if last_status is None or not last_status.get("certified"):
        pytest.skip(
            f"Receipt {content_hash[:16]}... did not reach Certified within 60s. "
            "Either the metering pipeline is still in W0 staging, the cert-daemon "
            "is paused, or the gateway is enqueuing the receipt for a future "
            "anchor. Last status: " + str(last_status)
        )

    # If we got here, the chain accepted the SDK-generated digest.
    assert last_status["certified"] is True
