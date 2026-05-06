"""Unit tests for the submit() HTTP path — exercises the wire format,
retry-on-5xx, replay rejection, and error mapping using a mock httpx transport.

NO live network access in this file — see test_submit_integration.py for the
end-to-end live preprod test.
"""
from __future__ import annotations

import json
from typing import Optional

import httpx
import pytest

from materios_compute_meter.exceptions import (
    GatewayError,
    ReplayRejectedError,
    SubmitError,
)
from materios_compute_meter.keypair import WorkerKeypair
from materios_compute_meter.record import MeteringRecord
from materios_compute_meter.submit import submit


def _make_record(
    period_start_ms: int = 1,
    period_end_ms: Optional[int] = None,
) -> MeteringRecord:
    return MeteringRecord(
        worker_id="worker-test",
        tenant_id="tenant-test",
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms if period_end_ms is not None else period_start_ms + 1,
        cpu_seconds=10.0,
    )


def _mock_transport(handler):
    return httpx.MockTransport(handler)


def test_submit_happy_path_signs_and_posts(monkeypatch: pytest.MonkeyPatch) -> None:
    kp = WorkerKeypair.generate()
    rec = _make_record(period_start_ms=1000)
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["method"] = request.method
        captured["body"] = json.loads(request.content)
        captured["headers"] = dict(request.headers)
        return httpx.Response(
            200,
            json={
                "receipt_id": "0xrcpt0001",
                "content_hash": captured["body"]["content_hash"],
                "accepted_at": 1733400000,
            },
        )

    client = httpx.Client(transport=_mock_transport(handler))
    res = submit(
        kp,
        rec,
        gateway_url="https://example.com/gw",
        api_key="matra_test",
        _client=client,
    )

    assert captured["method"] == "POST"
    assert captured["url"].endswith("/metering/submit")
    assert captured["headers"]["authorization"] == "Bearer matra_test"
    assert captured["headers"]["content-type"] == "application/json"
    body = captured["body"]
    assert body["record"]["worker_id"] == "worker-test"
    assert body["signer_public"] == kp.public_hex
    assert body["scheme"] == "sr25519"
    assert len(body["signature"]) == 128
    assert len(body["content_hash"]) == 64

    assert res["receipt_id"] == "0xrcpt0001"
    assert res["content_hash"] == body["content_hash"]


def test_submit_signed_envelope_form() -> None:
    """submit() also accepts a pre-signed envelope (Signed[MeteringRecord])."""
    kp = WorkerKeypair.generate()
    rec = _make_record(period_start_ms=2000)
    signed = kp.sign(rec)

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={"receipt_id": "0xrcpt", "content_hash": signed.content_hash, "accepted_at": 0},
        )

    client = httpx.Client(transport=_mock_transport(handler))
    submit(signed, gateway_url="https://example.com/gw", api_key="k", _client=client)
    # Signature on the wire equals the one from the pre-signed envelope.
    assert captured["body"]["signature"] == signed.signature
    assert captured["body"]["content_hash"] == signed.content_hash


def test_submit_retries_once_on_5xx_then_succeeds() -> None:
    kp = WorkerKeypair.generate()
    rec = _make_record(period_start_ms=3000)
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        if calls["count"] == 1:
            return httpx.Response(503, json={"error": "service unavailable"})
        return httpx.Response(
            200,
            json={"receipt_id": "0xok", "content_hash": "0" * 64, "accepted_at": 0},
        )

    client = httpx.Client(transport=_mock_transport(handler))
    res = submit(
        kp, rec, gateway_url="https://x/gw", api_key="k",
        _client=client, _retry_backoff_seconds=0.0,
    )
    assert calls["count"] == 2
    assert res["receipt_id"] == "0xok"


def test_submit_retries_once_then_gives_up_on_persistent_5xx() -> None:
    kp = WorkerKeypair.generate()
    rec = _make_record(period_start_ms=4000)
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(500, json={"error": "boom"})

    client = httpx.Client(transport=_mock_transport(handler))
    with pytest.raises(GatewayError) as exc:
        submit(
            kp, rec, gateway_url="https://x/gw", api_key="k",
            _client=client, _retry_backoff_seconds=0.0,
        )
    # 1 try + 1 retry = 2 calls
    assert calls["count"] == 2
    assert exc.value.status == 500


def test_submit_does_not_retry_on_4xx() -> None:
    kp = WorkerKeypair.generate()
    rec = _make_record(period_start_ms=5000)
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(401, json={"error": "unauthorized"})

    client = httpx.Client(transport=_mock_transport(handler))
    with pytest.raises(GatewayError):
        submit(
            kp, rec, gateway_url="https://x/gw", api_key="k",
            _client=client, _retry_backoff_seconds=0.0,
        )
    assert calls["count"] == 1


def test_submit_replay_rejection_local_cache_blocks_decreasing_period() -> None:
    """The SDK keeps a per-(worker_id) monotonic period_start_ms cache. Submitting
    a record with period_start_ms <= last seen for the same worker raises before
    any HTTP call goes out."""
    kp = WorkerKeypair.generate()

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={"receipt_id": "0xa", "content_hash": body["content_hash"], "accepted_at": 0},
        )

    client = httpx.Client(transport=_mock_transport(handler))

    submit(
        kp, _make_record(period_start_ms=10_000),
        gateway_url="https://x/gw", api_key="k", _client=client,
    )

    # Same worker_id, identical period_start_ms => replay
    with pytest.raises(ReplayRejectedError):
        submit(
            kp, _make_record(period_start_ms=10_000),
            gateway_url="https://x/gw", api_key="k", _client=client,
        )

    # Same worker_id, lower period_start_ms => replay
    with pytest.raises(ReplayRejectedError):
        submit(
            kp, _make_record(period_start_ms=5_000),
            gateway_url="https://x/gw", api_key="k", _client=client,
        )

    # Same worker_id, higher period_start_ms => OK
    submit(
        kp, _make_record(period_start_ms=20_000),
        gateway_url="https://x/gw", api_key="k", _client=client,
    )


def test_submit_replay_cache_is_per_worker() -> None:
    """Two distinct worker_ids must NOT collide in the replay cache."""
    kp = WorkerKeypair.generate()

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={"receipt_id": "0xa", "content_hash": body["content_hash"], "accepted_at": 0},
        )

    client = httpx.Client(transport=_mock_transport(handler))

    rec_a = MeteringRecord(
        worker_id="worker-A", tenant_id="t", period_start_ms=100, period_end_ms=200, cpu_seconds=1.0,
    )
    rec_b = MeteringRecord(
        worker_id="worker-B", tenant_id="t", period_start_ms=100, period_end_ms=200, cpu_seconds=1.0,
    )

    submit(kp, rec_a, gateway_url="https://x/gw", api_key="k", _client=client)
    # Same period_start_ms but DIFFERENT worker_id — must succeed.
    submit(kp, rec_b, gateway_url="https://x/gw", api_key="k", _client=client)


def test_submit_raises_on_network_error() -> None:
    kp = WorkerKeypair.generate()
    rec = _make_record(period_start_ms=6000)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("DNS fail")

    client = httpx.Client(transport=_mock_transport(handler))
    with pytest.raises(SubmitError):
        submit(
            kp, rec, gateway_url="https://x/gw", api_key="k",
            _client=client, _retry_backoff_seconds=0.0,
        )


def test_submit_url_strips_trailing_slash() -> None:
    """Both `https://x/gw` and `https://x/gw/` should produce
    `https://x/gw/metering/submit`, not `gw//metering/submit`."""
    kp = WorkerKeypair.generate()
    rec = _make_record(period_start_ms=7000)
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(
            200,
            json={"receipt_id": "0x", "content_hash": "0" * 64, "accepted_at": 0},
        )

    client = httpx.Client(transport=_mock_transport(handler))
    submit(
        kp, rec, gateway_url="https://x/gw/", api_key="k", _client=client,
    )
    assert "//" not in captured["url"].split("https://")[1]


def test_submit_rejects_empty_api_key() -> None:
    kp = WorkerKeypair.generate()
    rec = _make_record(period_start_ms=8000)
    with pytest.raises(SubmitError):
        submit(kp, rec, gateway_url="https://x/gw", api_key="")


def test_submit_one_shot_form_signs_inline() -> None:
    """submit(kp, record, ...) should produce identical wire form to
    submit(kp.sign(record), ...)."""
    kp = WorkerKeypair.generate()
    rec = _make_record(period_start_ms=9000)
    signed = kp.sign(rec)

    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.setdefault("bodies", []).append(json.loads(request.content))
        return httpx.Response(
            200,
            json={"receipt_id": "0x", "content_hash": signed.content_hash, "accepted_at": 0},
        )

    # We need to bypass the per-process replay cache for this test — use distinct
    # worker_ids to do that.
    rec_b = MeteringRecord(
        worker_id="worker-other", tenant_id=rec.tenant_id,
        period_start_ms=rec.period_start_ms, period_end_ms=rec.period_end_ms,
        cpu_seconds=rec.cpu_seconds,
    )
    signed_b = kp.sign(rec_b)

    client = httpx.Client(transport=_mock_transport(handler))
    submit(signed, gateway_url="https://x/gw", api_key="k", _client=client)
    submit(kp, rec_b, gateway_url="https://x/gw", api_key="k", _client=client)

    body_signed_form = captured["bodies"][0]
    body_one_shot = captured["bodies"][1]

    # Signatures will differ because sr25519 is randomized — but the
    # content_hash MUST match canonical form for the corresponding records.
    assert body_signed_form["content_hash"] == signed.content_hash
    assert body_one_shot["content_hash"] == signed_b.content_hash
    # The envelope shape is the same.
    assert set(body_signed_form.keys()) == set(body_one_shot.keys())
