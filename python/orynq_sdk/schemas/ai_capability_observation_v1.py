"""`ai_capability_observation_v1` — canonical encoder, content_hash, validator.

Python lockstep of `packages/anchors-materios/src/schemas/ai_capability_observation_v1.ts`.
Cross-language byte-equality is enforced by
`python/tests/test_ai_capability_observation_v1_cross_lang.py`.

--- Canonical CBOR rules (RFC 8949 §4.2.1) ---

  * Definite-length encoding only.
  * Shortest possible integer head per RFC 8949 §3.1.
  * Map keys sorted by encoded-byte lexicographic order.
  * Strings: UTF-8, major type 3.
  * Byte strings: major type 2 (hashes, TEE evidence in pre-images).
  * Arrays: major type 4.
  * Maps: major type 5.
  * Null: major type 7, additional 22 (single byte 0xf6).

--- Pre-image (PINNED — coordinated with the TS encoder) ---

  [ "ai_capability_observation_v1", model_map, capability_map,
    observation_map, observer_map ]

  model_map         { hash: bytes32 | null, name: text, version: text }
  capability_map    { severity: text, taxonomyId: text }
  observation_map   { artifactRef: text | null, occurredAt: text,
                      promptHash: bytes32, responseHash: bytes32 }
  observer_map      { context: text, ss58: text,
                      teeAttestation: { evidence: bytes, tier: text } | null }
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Tuple, Union

# --- Schema constants ---

SCHEMA_VERSION = "ai_capability_observation_v1"
SCHEMA_HASH_HEX = hashlib.sha256(SCHEMA_VERSION.encode("utf-8")).hexdigest()

TEE_TIERS: Tuple[str, ...] = ("ARM-TZ", "Acurast", "SEV-SNP", "build")
_TEE_TIER_SET = frozenset(TEE_TIERS)

SEVERITIES: Tuple[str, ...] = ("low", "medium", "high", "critical")
_SEVERITY_SET = frozenset(SEVERITIES)

MAX_CONTEXT_LEN = 280

_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
_HEX_EVIDENCE_RE = re.compile(r"^[0-9a-f]+$")
_OCCURRED_AT_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$"
)
_SS58_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{46,50}$")
_TAXONOMY_ID_RE = re.compile(r"^[A-Z0-9_-]{1,64}$")


# --- Tagged CBOR value types ---


@dataclass(frozen=True)
class _CborText:
    v: str


@dataclass(frozen=True)
class _CborBytes:
    v: bytes


@dataclass(frozen=True)
class _CborNull:
    pass


@dataclass(frozen=True)
class _CborArray:
    v: Tuple["_CborValue", ...]


@dataclass(frozen=True)
class _CborMap:
    v: Tuple[Tuple[str, "_CborValue"], ...]


_CborValue = Union[_CborText, _CborBytes, _CborNull, _CborArray, _CborMap]


def _cbor_text(v: str) -> _CborValue:
    return _CborText(v)


def _cbor_bytes(v: bytes) -> _CborValue:
    return _CborBytes(bytes(v))


def _cbor_null() -> _CborValue:
    return _CborNull()


def _cbor_array(items: List[_CborValue]) -> _CborValue:
    return _CborArray(tuple(items))


def _cbor_map(pairs: List[Tuple[str, _CborValue]]) -> _CborValue:
    return _CborMap(tuple(pairs))


# --- Low-level primitives ---


def _encode_uint(major: int, n: int) -> bytes:
    if n < 0:
        raise TypeError(f"_encode_uint: out of range: {n}")
    if n <= 23:
        return bytes(((major << 5) | n,))
    if n <= 0xFF:
        return bytes(((major << 5) | 24, n))
    if n <= 0xFFFF:
        return bytes(((major << 5) | 25,)) + n.to_bytes(2, "big")
    if n <= 0xFFFFFFFF:
        return bytes(((major << 5) | 26,)) + n.to_bytes(4, "big")
    if n > (1 << 64) - 1:
        raise TypeError(f"_encode_uint: exceeds 64-bit unsigned: {n}")
    return bytes(((major << 5) | 27,)) + n.to_bytes(8, "big")


def _encode_text(s: str) -> bytes:
    b = s.encode("utf-8")
    return _encode_uint(3, len(b)) + b


def _encode_bytes(b: bytes) -> bytes:
    return _encode_uint(2, len(b)) + b


_CBOR_NULL_BYTE = bytes((0xF6,))


def _encode_cbor(val: _CborValue) -> bytes:
    if isinstance(val, _CborText):
        return _encode_text(val.v)
    if isinstance(val, _CborBytes):
        return _encode_bytes(val.v)
    if isinstance(val, _CborNull):
        return _CBOR_NULL_BYTE
    if isinstance(val, _CborArray):
        head = _encode_uint(4, len(val.v))
        return head + b"".join(_encode_cbor(item) for item in val.v)
    if isinstance(val, _CborMap):
        pairs = [(_encode_text(k), _encode_cbor(v)) for k, v in val.v]
        pairs.sort(key=lambda kv: kv[0])
        head = _encode_uint(5, len(pairs))
        return head + b"".join(k + v for k, v in pairs)
    raise TypeError(
        f"_encode_cbor: unsupported tagged value type {type(val).__name__}"
    )


# --- Pre-image builders ---


def _hex_to_bytes(value: Union[str, bytes, bytearray]) -> bytes:
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if isinstance(value, str):
        cleaned = value[2:] if value.startswith("0x") else value
        return bytes.fromhex(cleaned)
    raise TypeError(f"expected bytes or hex str, got {type(value).__name__}")


def _hex_or_null_to_cbor(hex_or_none: Any) -> _CborValue:
    if hex_or_none is None:
        return _cbor_null()
    return _cbor_bytes(_hex_to_bytes(hex_or_none))


def _text_or_null_to_cbor(s_or_none: Any) -> _CborValue:
    if s_or_none is None:
        return _cbor_null()
    return _cbor_text(s_or_none)


def _model_to_cbor(m: Dict[str, Any]) -> _CborValue:
    return _cbor_map(
        [
            ("hash", _hex_or_null_to_cbor(m["hash"])),
            ("name", _cbor_text(m["name"])),
            ("version", _cbor_text(m["version"])),
        ]
    )


def _capability_to_cbor(c: Dict[str, Any]) -> _CborValue:
    return _cbor_map(
        [
            ("severity", _cbor_text(c["severity"])),
            ("taxonomyId", _cbor_text(c["taxonomyId"])),
        ]
    )


def _observation_to_cbor(o: Dict[str, Any]) -> _CborValue:
    return _cbor_map(
        [
            ("artifactRef", _text_or_null_to_cbor(o["artifactRef"])),
            ("occurredAt", _cbor_text(o["occurredAt"])),
            ("promptHash", _cbor_bytes(_hex_to_bytes(o["promptHash"]))),
            ("responseHash", _cbor_bytes(_hex_to_bytes(o["responseHash"]))),
        ]
    )


def _tee_to_cbor(t: Any) -> _CborValue:
    if t is None:
        return _cbor_null()
    return _cbor_map(
        [
            ("evidence", _cbor_bytes(_hex_to_bytes(t["evidence"]))),
            ("tier", _cbor_text(t["tier"])),
        ]
    )


def _observer_to_cbor(o: Dict[str, Any]) -> _CborValue:
    return _cbor_map(
        [
            ("context", _cbor_text(o["context"])),
            ("ss58", _cbor_text(o["ss58"])),
            ("teeAttestation", _tee_to_cbor(o["teeAttestation"])),
        ]
    )


def canonical_cbor_pre_image(record: Dict[str, Any]) -> bytes:
    """Build canonical CBOR bytes for an `ai_capability_observation_v1` record.

    Mirrors `canonicalCborPreImage` in the TS encoder. The output is the
    bytes the cert-daemon committee signs and downstream verifiers
    reproduce locally.
    """
    return _encode_cbor(
        _cbor_array(
            [
                _cbor_text(SCHEMA_VERSION),
                _model_to_cbor(record["model"]),
                _capability_to_cbor(record["capability"]),
                _observation_to_cbor(record["observation"]),
                _observer_to_cbor(record["observer"]),
            ]
        )
    )


def canonical_content_hash(record: Dict[str, Any]) -> str:
    """SHA-256 hex of the canonical CBOR pre-image."""
    return hashlib.sha256(canonical_cbor_pre_image(record)).hexdigest()


# --- Validator ---


def _err(code: str, message: str, field: str = "") -> Dict[str, Any]:
    out: Dict[str, Any] = {"ok": False, "code": code, "message": message}
    if field:
        out["field"] = field
    return out


def _is_plain_object(x: Any) -> bool:
    return isinstance(x, dict)


def _validate_string(
    raw: Dict[str, Any], key: str, field_path: str
) -> Dict[str, Any]:
    if key not in raw:
        return _err("MISSING_FIELD", f"{field_path} is required", field_path)
    v = raw[key]
    if not isinstance(v, str):
        return _err("WRONG_TYPE", f"{field_path} must be a string", field_path)
    return {"ok": True, "value": v}


def _validate_hex64(
    raw: Dict[str, Any], key: str, field_path: str
) -> Dict[str, Any]:
    r = _validate_string(raw, key, field_path)
    if not r["ok"]:
        return r
    v = r["value"]
    if not _HEX64_RE.match(v):
        return _err(
            "HEX_FORMAT",
            f"{field_path} must be 64 lowercase hex chars, got length {len(v)}",
            field_path,
        )
    return r


def _validate_model(raw: Any) -> Dict[str, Any]:
    if not _is_plain_object(raw):
        return _err("WRONG_TYPE", "model must be a JSON object", "model")
    name_res = _validate_string(raw, "name", "model.name")
    if not name_res["ok"]:
        return name_res
    if not (1 <= len(name_res["value"]) <= 128):
        return _err(
            "MODEL_NAME_FORMAT",
            "model.name must be 1-128 chars",
            "model.name",
        )
    version_res = _validate_string(raw, "version", "model.version")
    if not version_res["ok"]:
        return version_res
    if "hash" not in raw:
        return _err("MISSING_FIELD", "model.hash is required", "model.hash")
    hash_raw = raw["hash"]
    if hash_raw is None:
        hash_v = None
    elif not isinstance(hash_raw, str):
        return _err(
            "WRONG_TYPE",
            "model.hash must be a string or null",
            "model.hash",
        )
    elif not _HEX64_RE.match(hash_raw):
        return _err(
            "HEX_FORMAT",
            f"model.hash must be 64 lowercase hex chars, got length {len(hash_raw)}",
            "model.hash",
        )
    else:
        hash_v = hash_raw
    return {
        "ok": True,
        "value": {
            "name": name_res["value"],
            "version": version_res["value"],
            "hash": hash_v,
        },
    }


def _validate_capability(raw: Any) -> Dict[str, Any]:
    if not _is_plain_object(raw):
        return _err(
            "WRONG_TYPE", "capability must be a JSON object", "capability"
        )
    tax_res = _validate_string(raw, "taxonomyId", "capability.taxonomyId")
    if not tax_res["ok"]:
        return tax_res
    if not _TAXONOMY_ID_RE.match(tax_res["value"]):
        return _err(
            "TAXONOMY_ID_FORMAT",
            "capability.taxonomyId must match [A-Z0-9_-]{1,64}",
            "capability.taxonomyId",
        )
    sev_res = _validate_string(raw, "severity", "capability.severity")
    if not sev_res["ok"]:
        return sev_res
    if sev_res["value"] not in _SEVERITY_SET:
        return _err(
            "SEVERITY_INVALID",
            f"capability.severity must be one of {list(SEVERITIES)}, got "
            f"\"{sev_res['value']}\"",
            "capability.severity",
        )
    return {
        "ok": True,
        "value": {
            "taxonomyId": tax_res["value"],
            "severity": sev_res["value"],
        },
    }


def _validate_observation(raw: Any) -> Dict[str, Any]:
    if not _is_plain_object(raw):
        return _err(
            "WRONG_TYPE",
            "observation must be a JSON object",
            "observation",
        )
    prompt_res = _validate_hex64(raw, "promptHash", "observation.promptHash")
    if not prompt_res["ok"]:
        return prompt_res
    response_res = _validate_hex64(
        raw, "responseHash", "observation.responseHash"
    )
    if not response_res["ok"]:
        return response_res
    if "artifactRef" not in raw:
        return _err(
            "MISSING_FIELD",
            "observation.artifactRef is required",
            "observation.artifactRef",
        )
    ref_raw = raw["artifactRef"]
    if ref_raw is None:
        artifact_ref = None
    elif not isinstance(ref_raw, str):
        return _err(
            "WRONG_TYPE",
            "observation.artifactRef must be a string or null",
            "observation.artifactRef",
        )
    elif not (1 <= len(ref_raw) <= 2048):
        return _err(
            "WRONG_TYPE",
            "observation.artifactRef must be 1-2048 chars when non-null",
            "observation.artifactRef",
        )
    else:
        artifact_ref = ref_raw
    occ_res = _validate_string(raw, "occurredAt", "observation.occurredAt")
    if not occ_res["ok"]:
        return occ_res
    if not _OCCURRED_AT_RE.match(occ_res["value"]):
        return _err(
            "OCCURRED_AT_INVALID",
            "observation.occurredAt must be ISO 8601 UTC (suffix Z)",
            "observation.occurredAt",
        )
    return {
        "ok": True,
        "value": {
            "promptHash": prompt_res["value"],
            "responseHash": response_res["value"],
            "artifactRef": artifact_ref,
            "occurredAt": occ_res["value"],
        },
    }


def _validate_tee(raw: Any) -> Dict[str, Any]:
    if not _is_plain_object(raw):
        return _err(
            "WRONG_TYPE",
            "observer.teeAttestation must be a JSON object or null",
            "observer.teeAttestation",
        )
    tier_res = _validate_string(raw, "tier", "observer.teeAttestation.tier")
    if not tier_res["ok"]:
        return tier_res
    if tier_res["value"] not in _TEE_TIER_SET:
        return _err(
            "TEE_TIER_INVALID",
            f"observer.teeAttestation.tier must be one of {list(TEE_TIERS)}, "
            f"got \"{tier_res['value']}\"",
            "observer.teeAttestation.tier",
        )
    ev_res = _validate_string(
        raw, "evidence", "observer.teeAttestation.evidence"
    )
    if not ev_res["ok"]:
        return ev_res
    ev = ev_res["value"]
    if len(ev) == 0 or len(ev) % 2 != 0 or not _HEX_EVIDENCE_RE.match(ev):
        return _err(
            "HEX_FORMAT",
            "observer.teeAttestation.evidence must be non-empty lowercase hex "
            "with even length",
            "observer.teeAttestation.evidence",
        )
    return {
        "ok": True,
        "value": {"tier": tier_res["value"], "evidence": ev},
    }


def _validate_observer(raw: Any) -> Dict[str, Any]:
    if not _is_plain_object(raw):
        return _err("WRONG_TYPE", "observer must be a JSON object", "observer")
    ss58_res = _validate_string(raw, "ss58", "observer.ss58")
    if not ss58_res["ok"]:
        return ss58_res
    if not _SS58_RE.match(ss58_res["value"]):
        return _err(
            "SS58_FORMAT",
            "observer.ss58 must be a base58 SS58 address",
            "observer.ss58",
        )
    ctx_res = _validate_string(raw, "context", "observer.context")
    if not ctx_res["ok"]:
        return ctx_res
    if len(ctx_res["value"]) > MAX_CONTEXT_LEN:
        return _err(
            "CONTEXT_TOO_LONG",
            f"observer.context must be <= {MAX_CONTEXT_LEN} chars, got "
            f"{len(ctx_res['value'])}",
            "observer.context",
        )
    if "teeAttestation" not in raw:
        return _err(
            "MISSING_FIELD",
            "observer.teeAttestation is required (use null when absent)",
            "observer.teeAttestation",
        )
    if raw["teeAttestation"] is None:
        tee = None
    else:
        tee_res = _validate_tee(raw["teeAttestation"])
        if not tee_res["ok"]:
            return tee_res
        tee = tee_res["value"]
    return {
        "ok": True,
        "value": {
            "ss58": ss58_res["value"],
            "context": ctx_res["value"],
            "teeAttestation": tee,
        },
    }


def validate_ai_capability_observation_v1(raw: Any) -> Dict[str, Any]:
    """Validate a parsed JSON object against `ai_capability_observation_v1`.

    Returns:
        On success:
            {"ok": True, "record": <typed dict>, "contentHash": <hex>,
             "schemaHash": <hex>, "preImage": <bytes>}
        On failure:
            {"ok": False, "code": <code>, "message": <message>,
             "field"?: <field>}
    """
    if not _is_plain_object(raw):
        return _err("WRONG_TYPE", "expected JSON object at root")
    if "schemaVersion" not in raw:
        return _err(
            "MISSING_FIELD", "schemaVersion is required", "schemaVersion"
        )
    if not isinstance(raw["schemaVersion"], str):
        return _err(
            "WRONG_TYPE",
            "schemaVersion must be a string",
            "schemaVersion",
        )
    if raw["schemaVersion"] != SCHEMA_VERSION:
        return _err(
            "WRONG_SCHEMA_VERSION",
            f'schemaVersion must be "{SCHEMA_VERSION}", got "{raw["schemaVersion"]}"',
            "schemaVersion",
        )
    if "model" not in raw:
        return _err("MISSING_FIELD", "model is required", "model")
    model_res = _validate_model(raw["model"])
    if not model_res["ok"]:
        return model_res
    if "capability" not in raw:
        return _err("MISSING_FIELD", "capability is required", "capability")
    cap_res = _validate_capability(raw["capability"])
    if not cap_res["ok"]:
        return cap_res
    if "observation" not in raw:
        return _err("MISSING_FIELD", "observation is required", "observation")
    obs_res = _validate_observation(raw["observation"])
    if not obs_res["ok"]:
        return obs_res
    if "observer" not in raw:
        return _err("MISSING_FIELD", "observer is required", "observer")
    observer_res = _validate_observer(raw["observer"])
    if not observer_res["ok"]:
        return observer_res

    record = {
        "schemaVersion": SCHEMA_VERSION,
        "model": model_res["value"],
        "capability": cap_res["value"],
        "observation": obs_res["value"],
        "observer": observer_res["value"],
    }
    pre_image = canonical_cbor_pre_image(record)
    content_hash = hashlib.sha256(pre_image).hexdigest()
    return {
        "ok": True,
        "record": record,
        "contentHash": content_hash,
        "schemaHash": SCHEMA_HASH_HEX,
        "preImage": pre_image,
    }
