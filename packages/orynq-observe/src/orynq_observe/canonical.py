"""Canonical CBOR encoder for the ai_capability_observation_v1 schema.

The encoder mirrors the rules pinned by compute_metering_v2 across the
materios stack:

  * Definite-length, RFC 8949 §4.2.1 sorted map keys.
  * Shortest CBOR head for unsigned ints (major 0) and lengths.
  * float64 ALWAYS (8 bytes, never shortened) — TS DataView.setFloat64
    does not shorten, so we must not either.
  * byte-strings (major 2) for raw 32-byte / 64-byte fields.
  * `bool` is NEVER permitted (Python's `True is 1` quirk silently coerces
    to int 1 otherwise).
  * Map keys are sorted on encoded-key bytes (matches TS).

Cross-language byte-equality with the TS encoder in the matching
@fluxpointstudios/orynq-observe package is enforced by tests.
"""
from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass
from typing import Any, List, Optional, Tuple, Union


# Schema literal pinned for ai_capability_observation_v1. Hashing of this
# string yields the canonical schema hash propagated on chain as
# `submit_receipt_v2(schema_hash = ...)`.
SCHEMA_VERSION = "ai_capability_observation_v1"
SCHEMA_HASH_HEX = hashlib.sha256(SCHEMA_VERSION.encode("utf-8")).hexdigest()

# Severity discriminant order — PINNED. New severities go at the tail.
SEVERITIES = ("low", "medium", "high", "critical")
SEVERITY_DISCRIMINANT = {s: i for i, s in enumerate(SEVERITIES)}

# TEE attestation tier strings the runtime understands. Anything outside
# this set is permitted at the SDK boundary but flagged in tests so we
# notice schema drift.
KNOWN_TEE_TIERS = (
    "Acurast",
    "AMD_SEV_SNP",
    "Intel_TDX",
    "ARM_TrustZone",
    "ReproducibleBuild",
    "None",
)


# ---------------------------------------------------------------------------
# Tagged CBOR value types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _CborInt:
    v: int


@dataclass(frozen=True)
class _CborFloat:
    v: float


@dataclass(frozen=True)
class _CborText:
    v: str


@dataclass(frozen=True)
class _CborBytes:
    v: bytes


@dataclass(frozen=True)
class _CborArray:
    v: Tuple["_CborValue", ...]


@dataclass(frozen=True)
class _CborMap:
    """Ordered (key, value) pairs. Encoder sorts by encoded-key bytes."""

    v: Tuple[Tuple[str, "_CborValue"], ...]


@dataclass(frozen=True)
class _CborNull:
    pass


_CborValue = Union[
    _CborInt,
    _CborFloat,
    _CborText,
    _CborBytes,
    _CborArray,
    _CborMap,
    _CborNull,
]


def _cbor_int(v: int) -> _CborValue:
    if isinstance(v, bool) or not isinstance(v, int):
        raise TypeError(f"_cbor_int: not an int: {type(v).__name__}")
    return _CborInt(v)


def _cbor_text(v: str) -> _CborValue:
    if not isinstance(v, str):
        raise TypeError(f"_cbor_text: not a str: {type(v).__name__}")
    return _CborText(v)


def _cbor_bytes(v: bytes) -> _CborValue:
    if not isinstance(v, (bytes, bytearray)):
        raise TypeError(f"_cbor_bytes: not bytes: {type(v).__name__}")
    return _CborBytes(bytes(v))


def _cbor_array(items: List[_CborValue]) -> _CborValue:
    return _CborArray(tuple(items))


def _cbor_map(pairs: List[Tuple[str, _CborValue]]) -> _CborValue:
    return _CborMap(tuple(pairs))


def _cbor_null() -> _CborValue:
    return _CborNull()


# ---------------------------------------------------------------------------
# Low-level encoder primitives
# ---------------------------------------------------------------------------


def _encode_uint(major: int, n: int) -> bytes:
    """Shortest CBOR head per RFC 8949 §3.1. `n` must be a non-negative int."""
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


def _encode_int(n: int) -> bytes:
    if isinstance(n, bool) or not isinstance(n, int):
        raise TypeError(f"_encode_int: not an int: {type(n).__name__}")
    if n >= 0:
        return _encode_uint(0, n)
    return _encode_uint(1, -1 - n)


def _encode_float64(n: float) -> bytes:
    if isinstance(n, bool) or not isinstance(n, (int, float)):
        raise TypeError(f"_encode_float64: not a number: {type(n).__name__}")
    f = float(n)
    if f != f:
        raise TypeError("_encode_float64: NaN not permitted")
    if f in (float("inf"), float("-inf")):
        raise TypeError("_encode_float64: Infinity not permitted")
    return bytes(((7 << 5) | 27,)) + struct.pack(">d", f)


def _encode_text(s: str) -> bytes:
    b = s.encode("utf-8")
    return _encode_uint(3, len(b)) + b


def _encode_bytes(b: bytes) -> bytes:
    return _encode_uint(2, len(b)) + b


def _encode_null() -> bytes:
    # CBOR null = major 7, additional 22 → 0xF6.
    return bytes((0xF6,))


def _encode_cbor(val: _CborValue) -> bytes:
    if isinstance(val, _CborInt):
        return _encode_int(val.v)
    if isinstance(val, _CborFloat):
        return _encode_float64(val.v)
    if isinstance(val, _CborText):
        return _encode_text(val.v)
    if isinstance(val, _CborBytes):
        return _encode_bytes(val.v)
    if isinstance(val, _CborNull):
        return _encode_null()
    if isinstance(val, _CborArray):
        head = _encode_uint(4, len(val.v))
        return head + b"".join(_encode_cbor(item) for item in val.v)
    if isinstance(val, _CborMap):
        # Encode keys + values, then sort by encoded-key bytes per RFC 8949
        # §4.2.1. All-ASCII keys make this equivalent to a string lex sort.
        pairs = [(_encode_text(k), _encode_cbor(v)) for k, v in val.v]
        pairs.sort(key=lambda kv: kv[0])
        head = _encode_uint(5, len(pairs))
        return head + b"".join(k + v for k, v in pairs)
    raise TypeError(f"_encode_cbor: unsupported value: {type(val).__name__}")


# ---------------------------------------------------------------------------
# Helpers for the AI capability observation shape
# ---------------------------------------------------------------------------


_HEX_PATTERN = "0123456789abcdef"


def _coerce_hex_to_bytes(value: Any, *, length: int, field: str) -> bytes:
    """Accept raw bytes (length N) OR a 2N-char lowercase hex string."""
    if isinstance(value, (bytes, bytearray)):
        if len(value) != length:
            raise TypeError(
                f"{field} must be {length}-byte bytes, got {len(value)}"
            )
        return bytes(value)
    if isinstance(value, str):
        s = value.removeprefix("0x")
        if len(s) != length * 2:
            raise TypeError(
                f"{field} hex must be {length * 2} chars, got {len(s)}"
            )
        if any(c not in _HEX_PATTERN for c in s.lower()):
            raise TypeError(f"{field} hex contains non-hex characters")
        return bytes.fromhex(s)
    raise TypeError(
        f"{field} must be bytes or hex str, got {type(value).__name__}"
    )


def _model_to_cbor(model: dict) -> _CborValue:
    """`model` sub-map. `hash` is optional (Null when absent / None)."""
    if not isinstance(model, dict):
        raise TypeError(f"model must be dict, got {type(model).__name__}")
    for required in ("name", "version"):
        if required not in model:
            raise KeyError(f"model.{required} is required")
    name = model["name"]
    version = model["version"]
    if not isinstance(name, str) or not name:
        raise TypeError("model.name must be a non-empty string")
    if not isinstance(version, str) or not version:
        raise TypeError("model.version must be a non-empty string")

    model_hash = model.get("hash")
    if model_hash is None:
        hash_val: _CborValue = _cbor_null()
    else:
        # hash is 32-byte sha256 of the upstream model artifact identifier.
        # Allow hex-string in or raw bytes — canonicalize to bytes.
        hash_val = _cbor_bytes(
            _coerce_hex_to_bytes(model_hash, length=32, field="model.hash")
        )

    return _cbor_map(
        [
            ("hash", hash_val),
            ("name", _cbor_text(name)),
            ("version", _cbor_text(version)),
        ]
    )


def _capability_to_cbor(capability: dict) -> _CborValue:
    if not isinstance(capability, dict):
        raise TypeError(
            f"capability must be dict, got {type(capability).__name__}"
        )
    taxonomy_id = capability.get("taxonomyId")
    severity = capability.get("severity")
    if not isinstance(taxonomy_id, str) or not taxonomy_id:
        raise TypeError("capability.taxonomyId must be a non-empty string")
    if severity not in SEVERITIES:
        raise TypeError(
            f"capability.severity must be one of {SEVERITIES}, got {severity!r}"
        )
    return _cbor_map(
        [
            ("severity", _cbor_text(severity)),
            ("taxonomyId", _cbor_text(taxonomy_id)),
        ]
    )


def _observation_to_cbor(observation: dict) -> _CborValue:
    if not isinstance(observation, dict):
        raise TypeError(
            f"observation must be dict, got {type(observation).__name__}"
        )
    for required in ("promptHash", "responseHash", "occurredAt"):
        if required not in observation:
            raise KeyError(f"observation.{required} is required")
    prompt_hash = _coerce_hex_to_bytes(
        observation["promptHash"], length=32, field="observation.promptHash"
    )
    response_hash = _coerce_hex_to_bytes(
        observation["responseHash"], length=32, field="observation.responseHash"
    )
    occurred_at = observation["occurredAt"]
    if isinstance(occurred_at, bool) or not isinstance(occurred_at, int):
        raise TypeError(
            f"observation.occurredAt must be int (unix ms), got "
            f"{type(occurred_at).__name__}"
        )
    if occurred_at < 0:
        raise TypeError("observation.occurredAt must be >= 0")

    artifact_ref = observation.get("artifactRef")
    if artifact_ref is None:
        artifact_val: _CborValue = _cbor_null()
    elif isinstance(artifact_ref, str):
        if not artifact_ref:
            raise TypeError(
                "observation.artifactRef must be a non-empty string when set"
            )
        artifact_val = _cbor_text(artifact_ref)
    else:
        raise TypeError(
            f"observation.artifactRef must be str or None, got "
            f"{type(artifact_ref).__name__}"
        )

    return _cbor_map(
        [
            ("artifactRef", artifact_val),
            ("occurredAt", _cbor_int(occurred_at)),
            ("promptHash", _cbor_bytes(prompt_hash)),
            ("responseHash", _cbor_bytes(response_hash)),
        ]
    )


def _tee_attestation_to_cbor(tee: Optional[dict]) -> _CborValue:
    if tee is None:
        return _cbor_null()
    if not isinstance(tee, dict):
        raise TypeError(
            f"observer.teeAttestation must be dict or None, got "
            f"{type(tee).__name__}"
        )
    tier = tee.get("tier")
    evidence = tee.get("evidence")
    if not isinstance(tier, str) or not tier:
        raise TypeError(
            "observer.teeAttestation.tier must be a non-empty string"
        )
    if not isinstance(evidence, (bytes, bytearray, str)):
        raise TypeError(
            "observer.teeAttestation.evidence must be bytes or hex str"
        )
    # Evidence is opaque bytes — variable length. We encode as bytes (major 2)
    # to preserve byte-equality with the TS encoder. Accept either raw bytes
    # or a hex string with optional `0x` prefix.
    if isinstance(evidence, str):
        s = evidence.removeprefix("0x")
        try:
            ev_bytes = bytes.fromhex(s)
        except ValueError as e:
            raise TypeError(
                f"observer.teeAttestation.evidence hex is invalid: {e}"
            ) from e
    else:
        ev_bytes = bytes(evidence)

    return _cbor_map(
        [
            ("evidence", _cbor_bytes(ev_bytes)),
            ("tier", _cbor_text(tier)),
        ]
    )


def _observer_to_cbor(observer: dict) -> _CborValue:
    if not isinstance(observer, dict):
        raise TypeError(
            f"observer must be dict, got {type(observer).__name__}"
        )
    ss58 = observer.get("ss58")
    context = observer.get("context")
    if not isinstance(ss58, str) or not ss58:
        raise TypeError("observer.ss58 must be a non-empty string")
    if not isinstance(context, str):
        # Allow empty context but require str type for canonical clarity.
        raise TypeError("observer.context must be a string")
    tee = observer.get("teeAttestation")
    return _cbor_map(
        [
            ("context", _cbor_text(context)),
            ("ss58", _cbor_text(ss58)),
            ("teeAttestation", _tee_attestation_to_cbor(tee)),
        ]
    )


# ---------------------------------------------------------------------------
# Public encoder + hashing entry points
# ---------------------------------------------------------------------------


def canonical_cbor(record: dict) -> bytes:
    """Encode an ai_capability_observation_v1 record to canonical CBOR bytes.

    The wire / pre-image shape (mirrors TS):

        [
          "ai_capability_observation_v1",
          model           (map: hash | null, name, version),
          capability      (map: severity, taxonomyId),
          observation     (map: artifactRef | null, occurredAt, promptHash,
                           responseHash),
          observer        (map: context, ss58, teeAttestation | null),
        ]

    The schema literal at element 0 is the discriminant; downstream
    M-of-N committee signers wrap THIS exact byte string.

    Args:
        record: A dict matching the AI capability observation wire shape.

    Returns:
        Canonical CBOR-encoded bytes — deterministic, byte-equal across
        Python and TypeScript implementations.

    Raises:
        TypeError / KeyError: any structural / type violation.
    """
    if not isinstance(record, dict):
        raise TypeError(
            f"record must be dict, got {type(record).__name__}"
        )

    schema_version = record.get("schemaVersion")
    if schema_version != SCHEMA_VERSION:
        raise TypeError(
            f"schemaVersion must be {SCHEMA_VERSION!r}, got {schema_version!r}"
        )

    for required in ("model", "capability", "observation", "observer"):
        if required not in record:
            raise KeyError(f"record.{required} is required")

    elements: List[_CborValue] = [
        _cbor_text(SCHEMA_VERSION),
        _model_to_cbor(record["model"]),
        _capability_to_cbor(record["capability"]),
        _observation_to_cbor(record["observation"]),
        _observer_to_cbor(record["observer"]),
    ]
    return _encode_cbor(_cbor_array(elements))


def canonical_content_hash(record: dict) -> str:
    """SHA-256 hex of canonical_cbor(record).

    This is the `content_hash` propagated through the gateway to the
    sponsored-receipt-submitter and finally to
    `submit_receipt_v2(content_hash = ...)` on Materios.
    """
    return hashlib.sha256(canonical_cbor(record)).hexdigest()
