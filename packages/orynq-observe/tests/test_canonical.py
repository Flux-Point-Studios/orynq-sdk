"""Smoke tests for the SDK's canonical re-export.

The SDK's `canonical_cbor` / `canonical_content_hash` delegate to the
canonical schema codec in `orynq_sdk.schemas.ai_capability_observation_v1`.
Byte-pin lockstep is covered by `test_canonical_lockstep.py`; this file
just verifies the re-export wires through correctly + the schema constants
are surfaced.
"""
from __future__ import annotations

import hashlib

from orynq_observe.canonical import (
    SCHEMA_HASH_HEX,
    SCHEMA_VERSION,
    SEVERITIES,
    TEE_TIERS,
    canonical_cbor,
    canonical_content_hash,
)


def _good_record() -> dict:
    prompt = hashlib.sha256(b"prompt-bytes").hexdigest()
    response = hashlib.sha256(b"response-bytes").hexdigest()
    model_hash = hashlib.sha256(b"model-bytes").hexdigest()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "model": {
            "name": "claude-opus-4-7",
            "version": "20260201",
            "hash": model_hash,
        },
        "capability": {
            "taxonomyId": "AUTO-MONEY-001",
            "severity": "high",
        },
        "observation": {
            "promptHash": prompt,
            "responseHash": response,
            "artifactRef": None,
            "occurredAt": "2026-01-15T12:34:56Z",
        },
        "observer": {
            "ss58": "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
            "context": "independent red-team session",
            "teeAttestation": None,
        },
    }


def test_schema_version_pinned() -> None:
    assert SCHEMA_VERSION == "ai_capability_observation_v1"
    assert SCHEMA_HASH_HEX == hashlib.sha256(
        SCHEMA_VERSION.encode("utf-8")
    ).hexdigest()


def test_severities_pinned() -> None:
    assert SEVERITIES == ("low", "medium", "high", "critical")


def test_tee_tiers_pinned() -> None:
    assert TEE_TIERS == ("ARM-TZ", "Acurast", "SEV-SNP", "build")


def test_canonical_cbor_is_deterministic() -> None:
    rec = _good_record()
    assert canonical_cbor(rec) == canonical_cbor(rec)


def test_canonical_content_hash_matches_sha256_of_cbor() -> None:
    rec = _good_record()
    expected = hashlib.sha256(canonical_cbor(rec)).hexdigest()
    assert canonical_content_hash(rec) == expected
    assert len(canonical_content_hash(rec)) == 64


def test_canonical_cbor_starts_with_array_5() -> None:
    """Outer CBOR is a 5-element array: major 4, length 5 → single byte 0x85."""
    assert canonical_cbor(_good_record())[0] == 0x85


def test_null_tee_attestation_encodes_as_cbor_null() -> None:
    rec = _good_record()
    rec["observer"]["teeAttestation"] = None
    assert b"\xf6" in canonical_cbor(rec)
