"""Submit-flow tests against a mocked gateway boundary.

We mock the HTTP boundary (httpx.Client) and assert:
  * The canonical content_hash sent to the gateway matches the SDK's recompute.
  * Signature + pubkey hex fields are populated.
  * Server-substituted content_hash mismatch raises SubmitError.
  * Receipt.refresh fills in materios_tx + cardano_anchor_tx.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List
from unittest.mock import MagicMock

import httpx
import pytest

from orynq_observe import (
    GatewayError,
    Observation,
    ObserverKeypair,
    SubmitError,
    canonical_content_hash,
    submit_observation,
)
from orynq_observe.submit import SubmissionReceipt


def _make_obs() -> Observation:
    return Observation(
        model_name="claude-opus-4-7",
        model_version="20260201",
        taxonomy_id="AUTO-MONEY-001",
        severity="high",
        observer_context="test",
        occurred_at="2026-11-14T22:13:20Z",
    ).add_evidence(prompt="p", response="r")


def _mock_client(
    *,
    status: int,
    body: Dict[str, Any],
) -> tuple[httpx.Client, List[Any]]:
    """Build an httpx.Client mock that returns one canned response and
    records every call to .post()."""
    calls: List[Any] = []

    def _post(url: str, headers: Dict[str, str], json: Dict[str, Any]):
        calls.append({"url": url, "headers": headers, "json": json})
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = status
        resp.text = ""
        resp.json = lambda: body
        return resp

    client = MagicMock(spec=httpx.Client)
    client.post = _post
    client.close = lambda: None
    return client, calls


def test_submit_observation_signs_and_posts(observer_keypair: ObserverKeypair) -> None:
    obs = _make_obs()
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    expected = canonical_content_hash(record)
    client, calls = _mock_client(
        status=200,
        body={
            "content_hash": expected,
            "accepted_at": 1_700_000_001_000,
            "materios_tx": None,
            "cardano_anchor_tx": None,
        },
    )

    receipt = submit_observation(
        record=record,
        keypair=observer_keypair,
        network="preprod",
        api_key="matra_test_token",
        _client=client,
        _retry_backoff_seconds=0,
    )

    assert isinstance(receipt, SubmissionReceipt)
    assert receipt.content_hash == expected
    assert receipt.gateway_status == 200
    assert receipt.observer_ss58 == observer_keypair.ss58_address
    assert len(calls) == 1
    sent = calls[0]["json"]
    assert sent["content_hash"] == expected
    assert sent["observer_pubkey"] == observer_keypair.public_hex
    assert len(sent["observer_signature"]) == 128  # 64 bytes hex
    assert sent["schema_version"] == "ai_capability_observation_v1"
    # Authorization header must be present.
    assert "authorization" in {k.lower() for k in calls[0]["headers"]}


def test_submit_observation_requires_api_key(observer_keypair: ObserverKeypair) -> None:
    obs = _make_obs()
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    with pytest.raises(SubmitError):
        submit_observation(
            record=record,
            keypair=observer_keypair,
            network="preprod",
            api_key="",
        )


def test_submit_observation_unknown_network(observer_keypair: ObserverKeypair) -> None:
    obs = _make_obs()
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    with pytest.raises(SubmitError):
        submit_observation(
            record=record,
            keypair=observer_keypair,
            network="rocketnet",
            api_key="matra_test",
        )


def test_submit_observation_rejects_server_content_hash_mismatch(
    observer_keypair: ObserverKeypair,
) -> None:
    """If the gateway echoes a content_hash that disagrees with the SDK's
    canonical recompute, the SDK refuses the response — we never trust a
    server-substituted hash."""
    obs = _make_obs()
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    client, _ = _mock_client(
        status=200,
        body={
            "content_hash": "ff" * 32,  # deliberately wrong
            "accepted_at": 0,
        },
    )
    with pytest.raises(SubmitError, match="content_hash"):
        submit_observation(
            record=record,
            keypair=observer_keypair,
            network="preprod",
            api_key="matra_test",
            _client=client,
            _retry_backoff_seconds=0,
        )


def test_submit_observation_raises_on_4xx(observer_keypair: ObserverKeypair) -> None:
    obs = _make_obs()
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    client, _ = _mock_client(
        status=401,
        body={"ok": False, "code": "AUTH_REJECTED", "message": "bad token"},
    )
    with pytest.raises(GatewayError) as info:
        submit_observation(
            record=record,
            keypair=observer_keypair,
            network="preprod",
            api_key="matra_test",
            _client=client,
            _retry_backoff_seconds=0,
        )
    assert info.value.status == 401
    assert "AUTH_REJECTED" in info.value.message


def test_submit_observation_retries_on_5xx(
    observer_keypair: ObserverKeypair,
) -> None:
    obs = _make_obs()
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    expected_hash = canonical_content_hash(record)

    responses: List[MagicMock] = []
    statuses = [503, 200]
    bodies = [
        {"ok": False, "code": "TRANSIENT"},
        {"content_hash": expected_hash, "accepted_at": 1},
    ]

    def _post(url, headers, json):
        r = MagicMock(spec=httpx.Response)
        r.status_code = statuses[len(responses)]
        r.text = ""
        r.json = lambda b=bodies[len(responses)]: b
        responses.append(r)
        return r

    client = MagicMock(spec=httpx.Client)
    client.post = _post
    client.close = lambda: None

    receipt = submit_observation(
        record=record,
        keypair=observer_keypair,
        network="preprod",
        api_key="matra_test",
        _client=client,
        _retry_backoff_seconds=0,
    )
    assert receipt.gateway_status == 200
    assert len(responses) == 2


def test_observation_submit_wraps_keypair_path(
    observer_keypair: ObserverKeypair, tmp_path
) -> None:
    """Observation.submit(wallet=<path>) must load the keyfile and call into
    the submit function with the loaded keypair."""
    # Persist the fixture key so submit(wallet=<path>) can load it.
    p = tmp_path / "obs.json"
    observer_keypair.save(str(p))

    obs = _make_obs()
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    expected_hash = canonical_content_hash(record)
    client, calls = _mock_client(
        status=200,
        body={"content_hash": expected_hash, "accepted_at": 1},
    )

    # Patch the module-level _client at the submit call site by passing
    # gateway_url + reaching into submit_observation directly through the
    # fluent path.
    import orynq_observe.submit as _submit_mod

    real_client_cls = _submit_mod.httpx.Client
    _submit_mod.httpx.Client = lambda *a, **k: client  # type: ignore
    try:
        receipt = obs.submit(
            wallet=str(p), network="preprod", api_key="matra_test",
        )
    finally:
        _submit_mod.httpx.Client = real_client_cls  # type: ignore
    assert receipt.content_hash == expected_hash


def test_submission_receipt_refresh_populates_tx(
    observer_keypair: ObserverKeypair,
) -> None:
    """A receipt with materios_tx=None should pick up the tx hash on
    refresh — the gateway exposes /receipts/{content_hash}."""
    receipt = SubmissionReceipt(
        content_hash="aa" * 32,
        gateway_status=200,
        accepted_at=1,
        materios_tx=None,
        cardano_anchor_tx=None,
        observer_ss58=observer_keypair.ss58_address,
    )

    # Patch httpx.Client to return a synthetic response.
    import orynq_observe.submit as _submit_mod

    class _FakeClient:
        def __init__(self, *_a, **_k): pass
        def __enter__(self): return self
        def __exit__(self, *_a): return False
        def get(self, url, headers=None):
            r = MagicMock(spec=httpx.Response)
            r.status_code = 200
            r.text = ""
            r.json = lambda: {
                "content_hash": "aa" * 32,
                "materios_tx": "0xdeadbeef",
                "cardano_anchor_tx": "cardano_tx_abcdef",
            }
            return r

    real = _submit_mod.httpx.Client
    _submit_mod.httpx.Client = _FakeClient
    try:
        receipt.refresh(
            gateway_url="https://example.invalid/preprod-blobs",
            api_key="matra_test",
        )
    finally:
        _submit_mod.httpx.Client = real
    assert receipt.materios_tx == "0xdeadbeef"
    assert receipt.cardano_anchor_tx == "cardano_tx_abcdef"
