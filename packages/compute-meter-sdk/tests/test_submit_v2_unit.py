"""Unit tests for submit_v2 — wire format, retry, error mapping, replay,
content-hash cross-check.

Mock httpx transport throughout. NO live network access in this file —
see test_v2_e2e_preprod.py for the live preprod test.

REAL sr25519 signatures are used (no mocked crypto) so the SDK's
canonical content_hash is computed on actual signed bytes.
"""
from __future__ import annotations

import json
from typing import Optional

import httpx
import pytest

from materios_compute_meter.canonical import (
    SCHEMA_VERSION_V2,
    canonical_content_hash_v2,
)
from materios_compute_meter.exceptions import (
    GatewayError,
    ReplayRejectedError,
    SubmitError,
)
from materios_compute_meter.hardware_spec import sign_hardware_spec
from materios_compute_meter.keypair import ObserverKeypair, WorkerKeypair
from materios_compute_meter.record import (
    attach_observer_signature_v2,
    build_record_v2,
    sign_record_v2,
)
from materios_compute_meter.submit import (
    SubmissionResult,
    submit_v2,
)


_FLEET_SEED = "0x" + "10" * 32
_WORKER_SEED = "0x" + "20" * 32
_OBSERVER_SEED = "0x" + "30" * 32


def _fleet_kp() -> WorkerKeypair:
    return WorkerKeypair.from_seed_hex(_FLEET_SEED)


def _worker_kp() -> WorkerKeypair:
    return WorkerKeypair.from_seed_hex(_WORKER_SEED)


def _observer_kp() -> ObserverKeypair:
    return ObserverKeypair.from_seed_hex(_OBSERVER_SEED)


def _make_sealed_record(
    *,
    worker_id: str = "worker-v2-001",
    period_start_ms: int = 1_700_000_000_000,
    period_end_ms: Optional[int] = None,
    with_observer: bool = False,
) -> dict:
    if period_end_ms is None:
        period_end_ms = period_start_ms + 60_000
    spec = sign_hardware_spec(
        worker_id=worker_id,
        cpu_cores=8,
        ram_gb=32,
        gpu_type="none",
        gpu_count=0,
        issued_ms=1_699_000_000_000,
        fleet_operator_keypair=_fleet_kp(),
    )
    body = build_record_v2(
        worker_id=worker_id,
        tenant_id="tenant-test",
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms,
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
    sealed = sign_record_v2(body, _worker_kp())
    if with_observer:
        sealed = attach_observer_signature_v2(sealed, _observer_kp())
    return sealed


def _mock_transport(handler):
    return httpx.MockTransport(handler)


# ---- happy path ----------------------------------------------------------


def test_submit_v2_happy_path_posts_correct_wire_format() -> None:
    rec = _make_sealed_record()
    expected_hash = canonical_content_hash_v2(rec)
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["method"] = request.method
        captured["body"] = json.loads(request.content)
        captured["headers"] = dict(request.headers)
        return httpx.Response(
            200,
            json={
                "receipt_id": "0xrcpt_v2_001",
                "content_hash": expected_hash,
                "accepted_at": 1_700_000_999,
            },
        )

    client = httpx.Client(transport=_mock_transport(handler))
    res = submit_v2(
        rec,
        gateway_url="https://example.com/gw",
        bearer="matra_v2_token",
        _client=client,
    )
    assert isinstance(res, SubmissionResult)
    assert res.receipt_id == "0xrcpt_v2_001"
    assert res.content_hash == expected_hash
    assert res.status_code == 200
    assert res.accepted_at == 1_700_000_999

    # Wire format checks:
    assert captured["method"] == "POST"
    assert captured["url"].endswith("/metering/submit")
    assert captured["headers"]["authorization"] == "Bearer matra_v2_token"
    assert captured["headers"]["x-schema-version"] == SCHEMA_VERSION_V2
    body = captured["body"]
    # v2-shape fields:
    assert body["schema_version"] == SCHEMA_VERSION_V2
    assert body["worker_id"] == "worker-v2-001"
    assert body["tenant_id"] == "tenant-test"
    assert body["period_start_ms"] == 1_700_000_000_000
    assert body["period_end_ms"] == 1_700_000_060_000
    assert body["metrics"]["cpu_seconds"] == 60
    assert body["hardware_spec"]["cpu_cores"] == 8
    # Bytes are hex-on-the-wire.
    assert isinstance(body["worker_pubkey_hex"], str)
    assert len(body["worker_pubkey_hex"]) == 64
    assert isinstance(body["worker_signature_hex"], str)
    assert len(body["worker_signature_hex"]) == 128
    assert len(body["hardware_spec"]["fleet_operator_pubkey_hex"]) == 64
    assert len(body["hardware_spec"]["fleet_operator_signature_hex"]) == 128
    # No observer block in this run.
    assert "observer" not in body


def test_submit_v2_with_observer_block_posts_observer_in_body() -> None:
    rec = _make_sealed_record(with_observer=True)
    expected_hash = canonical_content_hash_v2(rec)
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "receipt_id": "0xrcpt_v2_obs",
                "content_hash": expected_hash,
                "accepted_at": 1,
            },
        )

    client = httpx.Client(transport=_mock_transport(handler))
    submit_v2(
        rec,
        gateway_url="https://example.com/gw",
        bearer="t",
        _client=client,
    )
    body = captured["body"]
    assert "observer" in body
    assert len(body["observer"]["observer_pubkey_hex"]) == 64
    assert len(body["observer"]["observer_signature_hex"]) == 128


def test_submit_v2_accepts_api_key_alias_for_bearer() -> None:
    rec = _make_sealed_record()
    expected_hash = canonical_content_hash_v2(rec)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer alias_token"
        return httpx.Response(
            200,
            json={
                "receipt_id": "x",
                "content_hash": expected_hash,
                "accepted_at": 1,
            },
        )

    client = httpx.Client(transport=_mock_transport(handler))
    submit_v2(
        rec,
        gateway_url="https://x/gw",
        api_key="alias_token",  # alias of bearer
        _client=client,
    )


# ---- error mapping (4xx) -------------------------------------------------


def test_submit_v2_403_maps_to_fleet_operator_unknown() -> None:
    rec = _make_sealed_record(period_start_ms=2_000_000_000_000)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            json={"error": "fleet_operator pubkey not registered"},
        )

    client = httpx.Client(transport=_mock_transport(handler))
    with pytest.raises(GatewayError) as exc:
        submit_v2(
            rec,
            gateway_url="https://x/gw",
            bearer="t",
            _client=client,
            _retry_backoff_seconds=0.0,
        )
    assert exc.value.status == 403
    assert "fleet_operator unknown" in str(exc.value)


def test_submit_v2_422_maps_to_hardware_bound_violated() -> None:
    rec = _make_sealed_record(period_start_ms=2_000_000_001_000)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            422,
            json={"error": "cpu_seconds exceeds cap (8 cores * 60s)"},
        )

    client = httpx.Client(transport=_mock_transport(handler))
    with pytest.raises(GatewayError) as exc:
        submit_v2(
            rec,
            gateway_url="https://x/gw",
            bearer="t",
            _client=client,
            _retry_backoff_seconds=0.0,
        )
    assert exc.value.status == 422
    assert "hardware bound violated" in str(exc.value)


def test_submit_v2_401_maps_to_unauthorized() -> None:
    rec = _make_sealed_record(period_start_ms=2_000_000_002_000)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "bad token"})

    client = httpx.Client(transport=_mock_transport(handler))
    with pytest.raises(GatewayError) as exc:
        submit_v2(
            rec,
            gateway_url="https://x/gw",
            bearer="t",
            _client=client,
            _retry_backoff_seconds=0.0,
        )
    assert exc.value.status == 401


# ---- retry / network -----------------------------------------------------


def test_submit_v2_retries_once_on_5xx_then_succeeds() -> None:
    rec = _make_sealed_record(period_start_ms=2_000_000_003_000)
    expected_hash = canonical_content_hash_v2(rec)
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        if calls["count"] == 1:
            return httpx.Response(503, json={"error": "service unavailable"})
        return httpx.Response(
            200,
            json={
                "receipt_id": "0xok",
                "content_hash": expected_hash,
                "accepted_at": 0,
            },
        )

    client = httpx.Client(transport=_mock_transport(handler))
    res = submit_v2(
        rec,
        gateway_url="https://x/gw",
        bearer="t",
        _client=client,
        _retry_backoff_seconds=0.0,
    )
    assert calls["count"] == 2
    assert res.receipt_id == "0xok"


def test_submit_v2_does_not_retry_on_4xx() -> None:
    rec = _make_sealed_record(period_start_ms=2_000_000_004_000)
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(400, json={"error": "bad"})

    client = httpx.Client(transport=_mock_transport(handler))
    with pytest.raises(GatewayError):
        submit_v2(
            rec,
            gateway_url="https://x/gw",
            bearer="t",
            _client=client,
            _retry_backoff_seconds=0.0,
        )
    assert calls["count"] == 1


def test_submit_v2_raises_on_network_error() -> None:
    rec = _make_sealed_record(period_start_ms=2_000_000_005_000)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("DNS fail")

    client = httpx.Client(transport=_mock_transport(handler))
    with pytest.raises(SubmitError):
        submit_v2(
            rec,
            gateway_url="https://x/gw",
            bearer="t",
            _client=client,
            _retry_backoff_seconds=0.0,
        )


# ---- replay --------------------------------------------------------------


def test_submit_v2_replay_rejection_on_duplicate_period_start_ms() -> None:
    rec = _make_sealed_record(period_start_ms=2_000_000_006_000)
    expected_hash = canonical_content_hash_v2(rec)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "receipt_id": "0x",
                "content_hash": expected_hash,
                "accepted_at": 0,
            },
        )

    client = httpx.Client(transport=_mock_transport(handler))
    submit_v2(rec, gateway_url="https://x/gw", bearer="t", _client=client)
    with pytest.raises(ReplayRejectedError):
        submit_v2(rec, gateway_url="https://x/gw", bearer="t", _client=client)


# ---- content_hash cross-check -------------------------------------------


def test_submit_v2_rejects_server_substituted_content_hash() -> None:
    """If the server returns a content_hash that doesn't match the SDK's
    locally-recomputed canonical digest, the SDK MUST refuse to trust it."""
    rec = _make_sealed_record(period_start_ms=2_000_000_007_000)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "receipt_id": "0x",
                "content_hash": "00" * 32,  # bogus
                "accepted_at": 0,
            },
        )

    client = httpx.Client(transport=_mock_transport(handler))
    with pytest.raises(SubmitError) as exc:
        submit_v2(
            rec,
            gateway_url="https://x/gw",
            bearer="t",
            _client=client,
        )
    assert "content_hash" in str(exc.value)


# ---- input validation ---------------------------------------------------


def test_submit_v2_rejects_empty_bearer_and_api_key() -> None:
    rec = _make_sealed_record(period_start_ms=2_000_000_008_000)
    with pytest.raises(SubmitError):
        submit_v2(rec, gateway_url="https://x/gw")


def test_submit_v2_rejects_conflicting_bearer_and_api_key() -> None:
    rec = _make_sealed_record(period_start_ms=2_000_000_009_000)
    with pytest.raises(SubmitError):
        submit_v2(
            rec,
            gateway_url="https://x/gw",
            api_key="A",
            bearer="B",
        )


def test_submit_v2_url_strips_trailing_slash() -> None:
    rec = _make_sealed_record(period_start_ms=2_000_000_010_000)
    expected_hash = canonical_content_hash_v2(rec)
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(
            200,
            json={
                "receipt_id": "0x",
                "content_hash": expected_hash,
                "accepted_at": 0,
            },
        )

    client = httpx.Client(transport=_mock_transport(handler))
    submit_v2(
        rec,
        gateway_url="https://x/gw/",
        bearer="t",
        _client=client,
    )
    assert "//" not in captured["url"].split("https://")[1]


def test_submit_v2_rejects_record_missing_required_fields() -> None:
    """If the record dict is missing worker_signature, surface a SubmitError
    with a clear message — don't crash the encoder."""
    rec = _make_sealed_record(period_start_ms=2_000_000_011_000)
    rec.pop("worker_signature")
    with pytest.raises(SubmitError):
        submit_v2(rec, gateway_url="https://x/gw", bearer="t")


def test_submit_v2_rejects_record_with_wrong_pubkey_byte_length() -> None:
    rec = _make_sealed_record(period_start_ms=2_000_000_012_000)
    rec["worker_pubkey"] = b"\x00" * 16  # too short
    with pytest.raises(SubmitError):
        submit_v2(rec, gateway_url="https://x/gw", bearer="t")
