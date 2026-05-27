"""Self-tests for the ai_capability_observation_v1 canonical CBOR encoder.

Determinism + nullable handling + validator surface — all in pure Python.
Cross-language byte-equality with the TS encoder is covered separately by
`test_ai_capability_observation_v1_cross_lang.py`.
"""
from __future__ import annotations

import hashlib
from copy import deepcopy

import pytest

from orynq_sdk.schemas.ai_capability_observation_v1 import (
    MAX_CONTEXT_LEN,
    SCHEMA_HASH_HEX,
    SCHEMA_VERSION,
    SEVERITIES,
    TEE_TIERS,
    canonical_cbor_pre_image,
    canonical_content_hash,
    validate_ai_capability_observation_v1,
)


PROMPT_HASH = "a" * 64
RESPONSE_HASH = "b" * 64
MODEL_HASH = "c" * 64
TEE_EVIDENCE_HEX = "de" * 48
OBSERVER_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"


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
            "ss58": OBSERVER_SS58,
            "context": "scripted regression run",
            "teeAttestation": {
                "tier": "Acurast",
                "evidence": TEE_EVIDENCE_HEX,
            },
        },
    }


def _null_fields() -> dict:
    return {
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
            "ss58": OBSERVER_SS58,
            "context": "no tee, no artifact, no model hash",
            "teeAttestation": None,
        },
    }


# ---------------------------------------------------------------------------
# Schema constants
# ---------------------------------------------------------------------------


def test_schema_version_is_pinned_literal() -> None:
    assert SCHEMA_VERSION == "ai_capability_observation_v1"


def test_schema_hash_is_sha256_of_version_string() -> None:
    expected = hashlib.sha256(SCHEMA_VERSION.encode("utf-8")).hexdigest()
    assert SCHEMA_HASH_HEX == expected


def test_tee_tiers_pinned_order() -> None:
    assert TEE_TIERS == ("ARM-TZ", "Acurast", "SEV-SNP", "build")


def test_severities_pinned_order() -> None:
    assert SEVERITIES == ("low", "medium", "high", "critical")


# ---------------------------------------------------------------------------
# Canonical CBOR encoder
# ---------------------------------------------------------------------------


def test_pre_image_is_deterministic_across_repeated_encoding() -> None:
    rec = _baseline()
    a = canonical_cbor_pre_image(rec)
    b = canonical_cbor_pre_image(rec)
    assert a == b


def test_pre_image_is_deterministic_under_dict_key_reorder() -> None:
    rec_a = _baseline()
    a = canonical_cbor_pre_image(rec_a)
    # Rebuild every nested map with reversed insertion order to prove the
    # encoder doesn't depend on dict iteration order.
    rec_b = _baseline()
    for key in ("model", "capability", "observation", "observer"):
        sub = rec_b[key]
        rec_b[key] = {k: sub[k] for k in reversed(list(sub.keys()))}
    # Also reverse the top-level dict.
    rec_b = {k: rec_b[k] for k in reversed(list(rec_b.keys()))}
    b = canonical_cbor_pre_image(rec_b)
    assert a == b


def test_pre_image_differs_when_any_field_changes() -> None:
    rec = _baseline()
    a = canonical_cbor_pre_image(rec)
    mutated = deepcopy(rec)
    mutated["capability"]["severity"] = "critical"
    b = canonical_cbor_pre_image(mutated)
    assert a != b


def test_pre_image_starts_with_schema_version_literal() -> None:
    pre = canonical_cbor_pre_image(_baseline())
    # CBOR array head major-4 length-5 = 0x85; then text major-3 with length-28
    # head = 0x78 0x1c; then 28 UTF-8 bytes of the schema version.
    assert pre[0] == 0x85
    assert pre[1] == 0x78
    assert pre[2] == 0x1C
    assert pre[3 : 3 + 28].decode("utf-8") == SCHEMA_VERSION


def test_pre_image_handles_all_null_optional_fields() -> None:
    rec = _null_fields()
    pre = canonical_cbor_pre_image(rec)
    assert len(pre) > 0
    # The non-null variant must differ end-to-end.
    full = canonical_cbor_pre_image(_baseline())
    assert pre != full


def test_null_tee_attestation_encodes_as_cbor_null_primitive() -> None:
    pre = canonical_cbor_pre_image(_null_fields())
    # Locate the key "teeAttestation" (14 chars; major-3 length-14 head = 0x6e).
    key_text = b"teeAttestation"
    key_head = bytes([0x6E]) + key_text
    idx = pre.find(key_head)
    assert idx >= 0
    value_byte = pre[idx + len(key_head)]
    assert value_byte == 0xF6


def test_pre_image_keys_appear_in_sorted_order() -> None:
    """RFC 8949 §4.2.1: map keys sorted by encoded-key bytes.

    The `model_map` has keys [hash, name, version]; sorted-by-encoded-bytes
    this remains [hash, name, version]. Locate each key's text representation
    in the encoded bytes and check positional order.
    """
    pre = canonical_cbor_pre_image(_baseline())
    pos_hash = pre.find(b"\x64hash")  # text length 4
    pos_name = pre.find(b"\x64name")
    pos_version = pre.find(b"\x67version")  # text length 7
    assert 0 < pos_hash < pos_name < pos_version


# ---------------------------------------------------------------------------
# content_hash
# ---------------------------------------------------------------------------


def test_content_hash_equals_sha256_of_pre_image() -> None:
    rec = _baseline()
    pre = canonical_cbor_pre_image(rec)
    expected = hashlib.sha256(pre).hexdigest()
    assert canonical_content_hash(rec) == expected


def test_content_hash_is_stable_across_re_encoding() -> None:
    rec = _baseline()
    assert canonical_content_hash(rec) == canonical_content_hash(rec)


def test_content_hash_changes_when_capability_severity_changes() -> None:
    rec_a = _baseline()
    rec_b = deepcopy(rec_a)
    rec_b["capability"]["severity"] = "critical"
    assert canonical_content_hash(rec_a) != canonical_content_hash(rec_b)


# ---------------------------------------------------------------------------
# Validator
# ---------------------------------------------------------------------------


def test_validate_accepts_baseline() -> None:
    res = validate_ai_capability_observation_v1(_baseline())
    assert res["ok"] is True
    assert res["record"]["schemaVersion"] == SCHEMA_VERSION
    assert len(res["contentHash"]) == 64
    assert res["schemaHash"] == SCHEMA_HASH_HEX


def test_validate_accepts_all_nulls() -> None:
    res = validate_ai_capability_observation_v1(_null_fields())
    assert res["ok"] is True


def test_validate_rejects_unknown_schema_version() -> None:
    bad = _baseline()
    bad["schemaVersion"] = "ai_capability_observation_v2"
    res = validate_ai_capability_observation_v1(bad)
    assert res["ok"] is False
    assert res["code"] == "WRONG_SCHEMA_VERSION"


def test_validate_rejects_invalid_tee_tier() -> None:
    bad = _baseline()
    bad["observer"]["teeAttestation"]["tier"] = "TPM"
    res = validate_ai_capability_observation_v1(bad)
    assert res["ok"] is False
    assert res["code"] == "TEE_TIER_INVALID"


def test_validate_rejects_invalid_severity() -> None:
    bad = _baseline()
    bad["capability"]["severity"] = "extreme"
    res = validate_ai_capability_observation_v1(bad)
    assert res["ok"] is False
    assert res["code"] == "SEVERITY_INVALID"


def test_validate_rejects_long_context() -> None:
    bad = _baseline()
    bad["observer"]["context"] = "x" * (MAX_CONTEXT_LEN + 1)
    res = validate_ai_capability_observation_v1(bad)
    assert res["ok"] is False
    assert res["code"] == "CONTEXT_TOO_LONG"


def test_validate_rejects_non_hex_prompt_hash() -> None:
    bad = _baseline()
    bad["observation"]["promptHash"] = "not-hex"
    res = validate_ai_capability_observation_v1(bad)
    assert res["ok"] is False
    assert res["code"] == "HEX_FORMAT"


def test_validate_rejects_non_iso_occurred_at() -> None:
    bad = _baseline()
    bad["observation"]["occurredAt"] = "2026/01/15 12:34"
    res = validate_ai_capability_observation_v1(bad)
    assert res["ok"] is False
    assert res["code"] == "OCCURRED_AT_INVALID"


def test_validate_rejects_missing_model_name() -> None:
    bad = _baseline()
    del bad["model"]["name"]
    res = validate_ai_capability_observation_v1(bad)
    assert res["ok"] is False
    assert res["code"] == "MISSING_FIELD"


def test_validate_rejects_non_object_root() -> None:
    res = validate_ai_capability_observation_v1("not a dict")  # type: ignore[arg-type]
    assert res["ok"] is False
    assert res["code"] == "WRONG_TYPE"


@pytest.mark.parametrize("sev", list(SEVERITIES))
def test_every_severity_value_is_accepted(sev: str) -> None:
    rec = _baseline()
    rec["capability"]["severity"] = sev
    res = validate_ai_capability_observation_v1(rec)
    assert res["ok"] is True


@pytest.mark.parametrize("tier", list(TEE_TIERS))
def test_every_tee_tier_is_accepted(tier: str) -> None:
    rec = _baseline()
    rec["observer"]["teeAttestation"]["tier"] = tier
    res = validate_ai_capability_observation_v1(rec)
    assert res["ok"] is True
