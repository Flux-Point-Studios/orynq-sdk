"""Tests for the Observation fluent builder."""
from __future__ import annotations

import hashlib

import pytest

from orynq_observe import (
    Observation,
    ObservationError,
    ObserverKeypair,
    SCHEMA_VERSION,
    canonical_content_hash,
)


def _make_obs() -> Observation:
    return Observation(
        model_name="claude-opus-4-7",
        model_version="20260201",
        taxonomy_id="AUTO-MONEY-001",
        severity="high",
        observer_context="independent red-team session",
        occurred_at="2026-01-15T12:34:56Z",
    )


def test_observation_rejects_empty_model_name() -> None:
    with pytest.raises(ObservationError):
        Observation(
            model_name="",
            model_version="20260201",
            taxonomy_id="AUTO-MONEY-001",
            severity="high",
            observer_context="x",
        )


def test_observation_rejects_unknown_severity() -> None:
    with pytest.raises(ObservationError):
        Observation(
            model_name="m",
            model_version="v",
            taxonomy_id="t",
            severity="catastrophic",
            observer_context="x",
        )


def test_observation_rejects_int_occurred_at() -> None:
    """occurredAt must be an ISO 8601 UTC string in the canonical schema."""
    with pytest.raises(ObservationError):
        Observation(
            model_name="m",
            model_version="v",
            taxonomy_id="t",
            severity="high",
            observer_context="x",
            occurred_at=1_700_000_000_000,  # type: ignore[arg-type]
        )


def test_observation_to_record_requires_evidence(observer_keypair: ObserverKeypair) -> None:
    obs = _make_obs()
    with pytest.raises(ObservationError):
        obs.to_record(observer_ss58=observer_keypair.ss58_address)


def test_observation_add_evidence_hashes_inputs(observer_keypair: ObserverKeypair) -> None:
    obs = _make_obs()
    obs.add_evidence(prompt="prompt-bytes", response="response-bytes")
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    assert record["observation"]["promptHash"] == hashlib.sha256(
        b"prompt-bytes"
    ).hexdigest()
    assert record["observation"]["responseHash"] == hashlib.sha256(
        b"response-bytes"
    ).hexdigest()


def test_observation_add_evidence_accepts_bytes(observer_keypair: ObserverKeypair) -> None:
    obs = _make_obs()
    obs.add_evidence(prompt=b"\xde\xad\xbe\xef", response=b"\x01\x02\x03")
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    assert record["observation"]["promptHash"] == hashlib.sha256(
        b"\xde\xad\xbe\xef"
    ).hexdigest()
    assert record["observation"]["responseHash"] == hashlib.sha256(
        b"\x01\x02\x03"
    ).hexdigest()


def test_observation_record_has_schema_version(observer_keypair: ObserverKeypair) -> None:
    obs = _make_obs().add_evidence(prompt="p", response="r")
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    assert record["schemaVersion"] == SCHEMA_VERSION


def test_observation_record_carries_observer_ss58(
    observer_keypair: ObserverKeypair,
) -> None:
    obs = _make_obs().add_evidence(prompt="p", response="r")
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    assert record["observer"]["ss58"] == observer_keypair.ss58_address


def test_observation_attest_tee_adds_envelope(
    observer_keypair: ObserverKeypair,
) -> None:
    obs = _make_obs().add_evidence(prompt="p", response="r")
    obs.attest_tee(tier="Acurast", evidence=b"\x01\x02\x03")
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    assert record["observer"]["teeAttestation"] == {
        "tier": "Acurast",
        "evidence": "010203",
    }


def test_observation_attest_tee_accepts_hex(
    observer_keypair: ObserverKeypair,
) -> None:
    obs = _make_obs().add_evidence(prompt="p", response="r")
    obs.attest_tee(tier="SEV-SNP", evidence="deadbeef")
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    assert record["observer"]["teeAttestation"] == {
        "tier": "SEV-SNP",
        "evidence": "deadbeef",
    }


def test_observation_add_artifact_opaque_ref(
    observer_keypair: ObserverKeypair,
) -> None:
    obs = _make_obs().add_evidence(prompt="p", response="r")
    obs.add_artifact("ipfs://Qmabc")
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    assert record["observation"]["artifactRef"] == "ipfs://Qmabc"


def test_observation_content_hash_matches_canonical(
    observer_keypair: ObserverKeypair,
) -> None:
    obs = _make_obs().add_evidence(prompt="p", response="r")
    record = obs.to_record(observer_ss58=observer_keypair.ss58_address)
    assert obs.content_hash(observer_keypair.ss58_address) == (
        canonical_content_hash(record)
    )


def test_observation_chain_calls(observer_keypair: ObserverKeypair) -> None:
    h = (
        _make_obs()
        .add_evidence(prompt="p", response="r")
        .add_artifact("ipfs://Qmabc")
        .attest_tee(tier="Acurast", evidence=b"\x00")
        .content_hash(observer_keypair.ss58_address)
    )
    assert len(h) == 64
