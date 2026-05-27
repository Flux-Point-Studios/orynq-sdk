"""Round-trip the JSON-Schema artefact against the same test vectors used by
the byte-pin lockstep test. The JSON Schema is meant for downstream consumers
that don't link the orynq-sdk codec but still need wire-shape validation —
so the published artefact MUST accept every record the SDK validator accepts
and reject every record it rejects (on the same wire-shape grounds).
"""
from __future__ import annotations

import json
import sys
from copy import deepcopy
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from orynq_sdk.schemas.ai_capability_observation_v1 import (  # noqa: E402
    validate_ai_capability_observation_v1,
)


jsonschema = pytest.importorskip("jsonschema")


SCHEMA_PATH = (
    Path(__file__).resolve().parents[2]
    / "fixtures"
    / "ai_capability_observation_v1.schema.json"
)


@pytest.fixture(scope="module")
def schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


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


def test_json_schema_accepts_baseline(schema: dict) -> None:
    rec = _baseline()
    jsonschema.validate(instance=rec, schema=schema)
    assert validate_ai_capability_observation_v1(rec)["ok"] is True


def test_json_schema_accepts_all_nulls(schema: dict) -> None:
    rec = _baseline()
    rec["model"]["hash"] = None
    rec["observation"]["artifactRef"] = None
    rec["observer"]["teeAttestation"] = None
    jsonschema.validate(instance=rec, schema=schema)
    assert validate_ai_capability_observation_v1(rec)["ok"] is True


@pytest.mark.parametrize(
    "mutator,key",
    [
        (
            lambda r: r.update({"schemaVersion": "ai_capability_observation_v2"}),
            "schemaVersion",
        ),
        (lambda r: r["capability"].update({"severity": "extreme"}), "severity"),
        (
            lambda r: r["observer"]["teeAttestation"].update({"tier": "TPM"}),
            "tier",
        ),
        (
            lambda r: r["observation"].update({"promptHash": "not-hex"}),
            "promptHash",
        ),
        (
            lambda r: r["observation"].update({"occurredAt": "2026/01/15"}),
            "occurredAt",
        ),
        (lambda r: r["model"].update({"name": ""}), "model.name"),
        (
            lambda r: r["observer"].update({"context": "x" * 281}),
            "context",
        ),
    ],
)
def test_json_schema_rejects_mutations(
    schema: dict, mutator, key: str
) -> None:
    rec = _baseline()
    mutator(rec)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=rec, schema=schema)
    sdk = validate_ai_capability_observation_v1(rec)
    assert sdk["ok"] is False, f"SDK validator unexpectedly accepted {key}={rec}"


def test_json_schema_rejects_extra_top_level_property(schema: dict) -> None:
    rec = _baseline()
    rec["extraField"] = "unexpected"  # type: ignore[typeddict-item]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=rec, schema=schema)


def test_json_schema_rejects_missing_required(schema: dict) -> None:
    rec = _baseline()
    del rec["observer"]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=rec, schema=schema)


def test_sdk_accepts_records_the_schema_accepts() -> None:
    """The SDK validator is the byte-canonicaliser; the JSON schema is a
    downstream wire check. Whenever the JSON schema accepts a record, the
    SDK validator MUST also accept it (otherwise the SDK is stricter than
    the published contract and consumers can't predict acceptance).
    """
    rec = _baseline()
    rec2 = deepcopy(rec)
    rec2["observer"]["teeAttestation"] = None
    rec2["observation"]["artifactRef"] = None
    rec2["model"]["hash"] = None
    assert validate_ai_capability_observation_v1(rec)["ok"] is True
    assert validate_ai_capability_observation_v1(rec2)["ok"] is True
