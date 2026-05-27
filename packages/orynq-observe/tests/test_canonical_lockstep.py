"""Byte-pin lockstep test: the SDK's submit-path encoder MUST produce bytes
byte-identical to the canonical schema codec for every TEE tier + null.

The SDK is a thin wrapper around `orynq_sdk.schemas.ai_capability_observation_v1`;
this test is the harness that decides when the alignment is correct.
"""
from __future__ import annotations

from copy import deepcopy

import pytest

from orynq_observe.canonical import canonical_cbor, canonical_content_hash
from orynq_sdk.schemas.ai_capability_observation_v1 import (
    TEE_TIERS,
    canonical_cbor_pre_image,
    canonical_content_hash as schema_canonical_content_hash,
)


PROMPT_HASH = "a" * 64
RESPONSE_HASH = "b" * 64
MODEL_HASH = "c" * 64
TEE_EVIDENCE = "de" * 48
SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"


def _baseline() -> dict:
    return {
        "schemaVersion": "ai_capability_observation_v1",
        "model": {
            "name": "claude-opus-4-7",
            "version": "20260201",
            "hash": MODEL_HASH,
        },
        "capability": {
            "taxonomyId": "AUTO-MONEY-001",
            "severity": "high",
        },
        "observation": {
            "promptHash": PROMPT_HASH,
            "responseHash": RESPONSE_HASH,
            "artifactRef": "ipfs://QmSomeCidHere",
            "occurredAt": "2026-01-15T12:34:56Z",
        },
        "observer": {
            "ss58": SS58,
            "context": "scripted regression run",
            "teeAttestation": {
                "tier": "Acurast",
                "evidence": TEE_EVIDENCE,
            },
        },
    }


def test_baseline_lockstep() -> None:
    rec = _baseline()
    assert canonical_cbor(rec) == canonical_cbor_pre_image(rec)
    assert canonical_content_hash(rec) == schema_canonical_content_hash(rec)


def test_absent_tee_attestation_is_cbor_null() -> None:
    rec = _baseline()
    rec["observer"]["teeAttestation"] = None
    sdk_bytes = canonical_cbor(rec)
    schema_bytes = canonical_cbor_pre_image(rec)
    assert sdk_bytes == schema_bytes
    # CBOR null primitive = 0xf6 — must appear somewhere in the pre-image.
    assert b"\xf6" in sdk_bytes


@pytest.mark.parametrize("tier", TEE_TIERS)
def test_each_tier_lockstep(tier: str) -> None:
    rec = _baseline()
    rec["observer"]["teeAttestation"] = {"tier": tier, "evidence": TEE_EVIDENCE}
    assert canonical_cbor(rec) == canonical_cbor_pre_image(rec)
    assert canonical_content_hash(rec) == schema_canonical_content_hash(rec)


def test_all_nulls_lockstep() -> None:
    rec = {
        "schemaVersion": "ai_capability_observation_v1",
        "model": {"name": "anon-model", "version": "v0", "hash": None},
        "capability": {"taxonomyId": "TEST-001", "severity": "low"},
        "observation": {
            "promptHash": PROMPT_HASH,
            "responseHash": RESPONSE_HASH,
            "artifactRef": None,
            "occurredAt": "2026-05-27T00:00:00Z",
        },
        "observer": {
            "ss58": SS58,
            "context": "no tee, no artifact, no model hash",
            "teeAttestation": None,
        },
    }
    assert canonical_cbor(rec) == canonical_cbor_pre_image(rec)


@pytest.mark.parametrize("dead_tier", ["None", "Intel_TDX", "ARM_TrustZone", "AMD_SEV_SNP", "ReproducibleBuild"])
def test_builder_rejects_dead_tier_string(dead_tier: str) -> None:
    """The builder must reject every tier name from the pre-fix SDK enum."""
    from orynq_observe import Observation, ObservationError

    obs = Observation(
        model_name="m",
        model_version="v",
        taxonomy_id="t",
        severity="low",
        observer_context="x",
    ).add_evidence(prompt="p", response="r")
    with pytest.raises(ObservationError):
        obs.attest_tee(tier=dead_tier, evidence=TEE_EVIDENCE)


def test_builder_output_lockstep_matches_schema_validator() -> None:
    """Records produced by the high-level Observation builder must validate
    against the canonical schema and produce the same content hash."""
    from orynq_observe import Observation
    from orynq_sdk.schemas.ai_capability_observation_v1 import (
        validate_ai_capability_observation_v1,
    )

    obs = Observation(
        model_name="claude-opus-4-7",
        model_version="20260201",
        taxonomy_id="AUTO-MONEY-001",
        severity="high",
        observer_context="builder lockstep test",
        occurred_at="2026-01-15T12:34:56Z",
    ).add_evidence(prompt="prompt-bytes", response="response-bytes")
    obs.attest_tee(tier="Acurast", evidence=TEE_EVIDENCE)
    record = obs.to_record(observer_ss58=SS58)

    result = validate_ai_capability_observation_v1(record)
    assert result["ok"] is True, result
    assert canonical_content_hash(record) == result["contentHash"]
    assert canonical_cbor(record) == canonical_cbor_pre_image(record)
