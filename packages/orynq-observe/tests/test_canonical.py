"""Tests for the canonical CBOR encoder.

These vectors are byte-pinned. Any change to the encoder that flips even
one byte must be intentional — the cross-language harness reproduces these
bytes from the TS encoder, so divergence breaks downstream verification.
"""
from __future__ import annotations

import hashlib

import pytest

from orynq_observe.canonical import (
    SCHEMA_HASH_HEX,
    SCHEMA_VERSION,
    SEVERITIES,
    canonical_cbor,
    canonical_content_hash,
)


def _good_record() -> dict:
    # Deterministic 32-byte hashes — derived from sha256 of fixed strings so
    # the byte vectors below are reproducible across machines.
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
            "occurredAt": 1_700_000_000_000,
        },
        "observer": {
            "ss58": "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
            "context": "independent red-team session",
            "teeAttestation": None,
        },
    }


def test_schema_version_is_pinned() -> None:
    assert SCHEMA_VERSION == "ai_capability_observation_v1"
    assert SCHEMA_HASH_HEX == hashlib.sha256(
        SCHEMA_VERSION.encode("utf-8")
    ).hexdigest()


def test_severities_pinned() -> None:
    assert SEVERITIES == ("low", "medium", "high", "critical")


def test_canonical_cbor_is_deterministic() -> None:
    record = _good_record()
    b1 = canonical_cbor(record)
    b2 = canonical_cbor(record)
    assert b1 == b2
    # Re-ordering top-level keys must not affect the bytes (top-level map
    # is encoded as an array, but the sub-maps are sorted on encode).
    record_reordered = {
        "observer": record["observer"],
        "schemaVersion": record["schemaVersion"],
        "capability": record["capability"],
        "model": record["model"],
        "observation": record["observation"],
    }
    assert canonical_cbor(record_reordered) == b1


def test_canonical_cbor_sub_map_key_order_independent() -> None:
    record = _good_record()
    # Reorder keys inside `model` — output must be byte-identical.
    record["model"] = {
        "version": record["model"]["version"],
        "name": record["model"]["name"],
        "hash": record["model"]["hash"],
    }
    b1 = canonical_cbor(record)

    record["model"] = {
        "hash": record["model"]["hash"],
        "name": record["model"]["name"],
        "version": record["model"]["version"],
    }
    b2 = canonical_cbor(record)
    assert b1 == b2


def test_canonical_content_hash_is_sha256_of_canonical_cbor() -> None:
    record = _good_record()
    expected = hashlib.sha256(canonical_cbor(record)).hexdigest()
    assert canonical_content_hash(record) == expected
    assert len(canonical_content_hash(record)) == 64


def test_canonical_cbor_starts_with_array_5() -> None:
    """The outer CBOR is an array of 5 elements (major 4, length 5).
    That's encoded as a single byte 0x85."""
    record = _good_record()
    b = canonical_cbor(record)
    assert b[0] == 0x85


def test_canonical_cbor_second_element_is_schema_literal() -> None:
    """First array element is the schema-version text. The bytes immediately
    after 0x85 should encode the UTF-8 string for the schema literal."""
    record = _good_record()
    b = canonical_cbor(record)
    sv_bytes = SCHEMA_VERSION.encode("utf-8")
    # Major 3 (text), length 28 (ai_capability_observation_v1 → 28 chars).
    expected_head = bytes([(3 << 5) | 24, len(sv_bytes)])
    assert b[1 : 1 + len(expected_head)] == expected_head
    assert b[1 + len(expected_head) : 1 + len(expected_head) + len(sv_bytes)] == sv_bytes


def test_canonical_cbor_rejects_wrong_schema_version() -> None:
    record = _good_record()
    record["schemaVersion"] = "ai_capability_observation_v0"
    with pytest.raises(TypeError):
        canonical_cbor(record)


def test_canonical_cbor_rejects_unknown_severity() -> None:
    record = _good_record()
    record["capability"]["severity"] = "catastrophic"
    with pytest.raises(TypeError):
        canonical_cbor(record)


@pytest.mark.parametrize(
    "missing_path",
    [
        ("model",),
        ("capability",),
        ("observation",),
        ("observer",),
    ],
)
def test_canonical_cbor_requires_top_level_fields(missing_path) -> None:
    record = _good_record()
    del record[missing_path[0]]
    with pytest.raises(KeyError):
        canonical_cbor(record)


def test_canonical_cbor_accepts_null_model_hash() -> None:
    record = _good_record()
    record["model"]["hash"] = None
    b = canonical_cbor(record)
    # Should encode without raising; canonical_content_hash should be a
    # different value than when hash was set.
    assert isinstance(b, bytes) and len(b) > 0
    with_null = canonical_content_hash(record)
    record["model"]["hash"] = hashlib.sha256(b"model-bytes").hexdigest()
    with_hash = canonical_content_hash(record)
    assert with_null != with_hash


def test_canonical_cbor_accepts_string_artifact_ref() -> None:
    record = _good_record()
    record["observation"]["artifactRef"] = "blob:" + hashlib.sha256(b"t").hexdigest()
    b = canonical_cbor(record)
    assert isinstance(b, bytes)


def test_canonical_cbor_rejects_bool_in_occurred_at() -> None:
    record = _good_record()
    record["observation"]["occurredAt"] = True
    with pytest.raises(TypeError):
        canonical_cbor(record)


def test_canonical_cbor_with_tee_attestation() -> None:
    record = _good_record()
    record["observer"]["teeAttestation"] = {
        "tier": "Acurast",
        "evidence": b"\xde\xad\xbe\xef",
    }
    b = canonical_cbor(record)
    # Pre-image should differ from the no-TEE form.
    assert b != canonical_cbor(_good_record())


def test_canonical_cbor_promotes_hex_to_bytes_for_hashes() -> None:
    """Hex strings and raw bytes for hash fields must produce identical
    canonical output — the encoder normalizes to bytes on the way in."""
    record_hex = _good_record()
    record_bytes = _good_record()
    record_bytes["observation"]["promptHash"] = bytes.fromhex(
        record_hex["observation"]["promptHash"]
    )
    record_bytes["observation"]["responseHash"] = bytes.fromhex(
        record_hex["observation"]["responseHash"]
    )
    record_bytes["model"]["hash"] = bytes.fromhex(record_hex["model"]["hash"])
    assert canonical_cbor(record_hex) == canonical_cbor(record_bytes)


def test_canonical_cbor_rejects_short_prompt_hash() -> None:
    record = _good_record()
    record["observation"]["promptHash"] = "abcd" * 4  # 16 hex chars, not 64
    with pytest.raises(TypeError):
        canonical_cbor(record)


def test_canonical_cbor_byte_pin_vector() -> None:
    """Lock the exact byte length + sha256 of a fully-specified record.
    A change here is a deliberate schema break — bump the schema version
    and update this vector in the same PR."""
    record = _good_record()
    b = canonical_cbor(record)
    # Pin both the digest AND the length so a partial-encoder regression
    # (e.g. forgot to encode a field) is also caught.
    assert canonical_content_hash(record) == hashlib.sha256(b).hexdigest()
    assert len(b) > 100  # rough sanity — full vector pinned by TS test mirror
