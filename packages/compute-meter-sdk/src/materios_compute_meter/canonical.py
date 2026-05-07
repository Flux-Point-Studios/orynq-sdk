"""Canonical CBOR serialization with sorted map keys.

This is the on-the-wire form a `MeteringRecord` takes when its hash is
signed. The chosen rules:

  * Map (dict) keys are sorted lexicographically by their UTF-8 string form.
  * Lists / tuples are NOT sorted — order is meaningful.
  * Only built-in primitives are allowed: dict, list, tuple, str, bytes,
    int, float, bool, None. Custom classes are rejected with TypeError so
    the canonical form cannot drift on a per-caller __cbor__ hook.
  * cbor2 < 6 is pinned (per `project_aegis_publisher_deploy.md` cbor2 dep
    pin gotcha).

This matches schema #1's "canonical CBOR with sorted keys" expectation.
"""
from __future__ import annotations

import hashlib
from typing import Any

import cbor2

_ALLOWED_TYPES = (dict, list, tuple, str, bytes, int, float, bool, type(None))


def _validate_primitive(obj: Any) -> None:
    """Recursive type guard. Raises TypeError on the first foreign type."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if not isinstance(k, str):
                raise TypeError(
                    f"canonical_cbor: dict keys must be str, got {type(k).__name__}"
                )
            _validate_primitive(v)
        return
    if isinstance(obj, (list, tuple)):
        for item in obj:
            _validate_primitive(item)
        return
    if isinstance(obj, _ALLOWED_TYPES):
        return
    raise TypeError(
        f"canonical_cbor: unsupported type {type(obj).__name__}; only "
        "dict/list/tuple/str/bytes/int/float/bool/None are allowed"
    )


def _sort_recursive(obj: Any) -> Any:
    """Return a copy of `obj` where every nested dict has its keys sorted.
    Keeps lists / tuples in their original order."""
    if isinstance(obj, dict):
        return {k: _sort_recursive(obj[k]) for k in sorted(obj.keys())}
    if isinstance(obj, list):
        return [_sort_recursive(x) for x in obj]
    if isinstance(obj, tuple):
        return tuple(_sort_recursive(x) for x in obj)
    return obj


def canonical_cbor(obj: Any) -> bytes:
    """Serialize `obj` to CBOR with sorted map keys.

    Args:
        obj: A primitive-only Python value (dict / list / tuple / str / bytes /
            int / float / bool / None, recursively).

    Returns:
        The canonical CBOR-encoded bytes.

    Raises:
        TypeError: if `obj` (or any nested value) is not a supported primitive.
    """
    _validate_primitive(obj)
    sorted_obj = _sort_recursive(obj)
    # cbor2.dumps with canonical=True also sorts maps, but only at a single
    # level for some encoder versions. We pre-sort recursively to guarantee
    # determinism across cbor2 versions in the [5.4, 6) range.
    return cbor2.dumps(sorted_obj, canonical=True)


def canonical_digest(obj: Any) -> bytes:
    """Return sha256(canonical_cbor(obj)) as raw 32 bytes.

    This is the value a worker actually signs.
    """
    return hashlib.sha256(canonical_cbor(obj)).digest()


# ===========================================================================
# compute_metering_v2 — Wave 1+2 hardware-bounded + observer-co-signed schema
# ===========================================================================
#
# v2 adds two trust layers on top of v1: a fleet-operator-signed `hardware_spec`
# and an optional independent-observer co-signature. See the matching TS file
# at `services/blob-gateway/src/schemas/compute_metering_v2.ts` for the full
# schema description and signature pre-image specification.
#
# --- Why a hand-rolled encoder for v2 ---
#
# `cbor2(canonical=True)` SHORTENS floats: 1.5 becomes a 3-byte float16, not
# a 9-byte float64. The TS encoder at @polkadot's `DataView.setFloat64` does
# NOT shorten — it always emits 8 bytes. If we use cbor2 here we'll silently
# diverge from TS by 6 bytes per float and every cross-language signature
# verification on a non-trivially-valued field will fail.
#
# v2 therefore ships a hand-rolled encoder that mirrors the TS encoder
# byte-for-byte: definite-length, RFC 8949 §4.2.1 sorted map keys, shortest
# integer head, ALWAYS 8-byte float64, byte-strings (major 2) for pubkeys
# and signatures.
#
# v1's `canonical_cbor` continues to work for the v1 record shape. v2's
# helpers are SEPARATE — `canonical_cbor_for_worker_sig` /
# `canonical_cbor_for_fleet_op_sig` — and never call into the v1 path.

import struct
from dataclasses import dataclass
from typing import List, Tuple, Union

# --- v2 schema constants (mirror TS exports) ---

SCHEMA_VERSION_V2 = "compute_metering_v2"
SCHEMA_HASH_V2_HEX = hashlib.sha256(SCHEMA_VERSION_V2.encode("utf-8")).hexdigest()
FLEET_OP_TAG_V2 = "fleet_op_attestation_v1"

# --- Wave 3 Phase 2: compute_metering_v2.1 attestation evidence ---

SCHEMA_VERSION_V2_1 = "compute_metering_v2.1"
SCHEMA_HASH_V2_1_HEX = hashlib.sha256(
    SCHEMA_VERSION_V2_1.encode("utf-8")
).hexdigest()

# Discriminant order — PINNED across TS + Python + the parallel pallet enum.
# Adding a new variant is a non-breaking change ONLY at the tail.
EVIDENCE_TYPES = (
    "amd_sev_snp",         # 0
    "intel_tdx",           # 1
    "arm_trustzone",       # 2
    "reproducible_build",  # 3
    "zkvm_execution",      # 4
)
EVIDENCE_TYPE_DISCRIMINANT = {t: i for i, t in enumerate(EVIDENCE_TYPES)}


# --- Tagged value types for the canonical encoder ---


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


_CborValue = Union[_CborInt, _CborFloat, _CborText, _CborBytes, _CborArray, _CborMap]


def _v2_cbor_int(v: int) -> _CborValue:
    # Reject bool early: in Python `True is 1` and `int(True) == 1` would
    # silently coerce a boolean to the integer encoding path. We want a
    # caller passing `True` for a metric to fail loudly.
    if isinstance(v, bool) or not isinstance(v, int):
        raise TypeError(f"_v2_cbor_int: not an int: {type(v).__name__}")
    return _CborInt(v)


def _v2_cbor_float(v: float) -> _CborValue:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise TypeError(f"_v2_cbor_float: not a number: {type(v).__name__}")
    return _CborFloat(float(v))


def _v2_cbor_text(v: str) -> _CborValue:
    return _CborText(v)


def _v2_cbor_bytes(v: bytes) -> _CborValue:
    return _CborBytes(bytes(v))


def _v2_cbor_array(v: List[_CborValue]) -> _CborValue:
    return _CborArray(tuple(v))


def _v2_cbor_map(pairs: List[Tuple[str, _CborValue]]) -> _CborValue:
    return _CborMap(tuple(pairs))


# --- low-level primitives ---


def _v2_encode_uint(major: int, n: int) -> bytes:
    """Shortest CBOR head per RFC 8949 §3.1. `n` must be a non-negative int."""
    if n < 0:
        raise TypeError(f"_v2_encode_uint: out of range: {n}")
    if n <= 23:
        return bytes(((major << 5) | n,))
    if n <= 0xFF:
        return bytes(((major << 5) | 24, n))
    if n <= 0xFFFF:
        return bytes(((major << 5) | 25,)) + n.to_bytes(2, "big")
    if n <= 0xFFFFFFFF:
        return bytes(((major << 5) | 26,)) + n.to_bytes(4, "big")
    if n > (1 << 64) - 1:
        raise TypeError(f"_v2_encode_uint: exceeds 64-bit unsigned: {n}")
    return bytes(((major << 5) | 27,)) + n.to_bytes(8, "big")


def _v2_encode_int(n: int) -> bytes:
    if not isinstance(n, int) or isinstance(n, bool):
        # `bool` is a subclass of `int` in Python — exclude it explicitly so a
        # caller can't accidentally encode `True` as the integer 1.
        raise TypeError(f"_v2_encode_int: not an int: {type(n).__name__}")
    if n >= 0:
        return _v2_encode_uint(0, n)
    return _v2_encode_uint(1, -1 - n)


def _v2_encode_float64(n: float) -> bytes:
    """Always 8-byte float64 (major 7, additional 27, 8-byte BE).

    NEVER shortens to f32/f16 — cross-language byte-equality with the TS
    encoder requires this. NaN/Infinity rejected up front.
    """
    if not isinstance(n, (int, float)) or isinstance(n, bool):
        raise TypeError(f"_v2_encode_float64: not a number: {type(n).__name__}")
    f = float(n)
    if f != f:  # NaN
        raise TypeError("_v2_encode_float64: NaN not permitted")
    if f in (float("inf"), float("-inf")):
        raise TypeError("_v2_encode_float64: Infinity not permitted")
    return bytes(((7 << 5) | 27,)) + struct.pack(">d", f)


def _v2_encode_text(s: str) -> bytes:
    b = s.encode("utf-8")
    return _v2_encode_uint(3, len(b)) + b


def _v2_encode_bytes(b: bytes) -> bytes:
    return _v2_encode_uint(2, len(b)) + b


def _v2_encode_cbor(val: _CborValue) -> bytes:
    """Encode a tagged CBOR value to canonical bytes."""
    if isinstance(val, _CborInt):
        return _v2_encode_int(val.v)
    if isinstance(val, _CborFloat):
        return _v2_encode_float64(val.v)
    if isinstance(val, _CborText):
        return _v2_encode_text(val.v)
    if isinstance(val, _CborBytes):
        return _v2_encode_bytes(val.v)
    if isinstance(val, _CborArray):
        head = _v2_encode_uint(4, len(val.v))
        return head + b"".join(_v2_encode_cbor(item) for item in val.v)
    if isinstance(val, _CborMap):
        # Encode keys + values, then sort by encoded-key bytes per RFC 8949
        # §4.2.1. All-ASCII keys make this equivalent to a string lex sort,
        # but we sort on the actual encoded bytes for correctness.
        pairs = [(_v2_encode_text(k), _v2_encode_cbor(v)) for k, v in val.v]
        pairs.sort(key=lambda kv: kv[0])
        head = _v2_encode_uint(5, len(pairs))
        return head + b"".join(k + v for k, v in pairs)
    raise TypeError(
        f"_v2_encode_cbor: unsupported tagged value type {type(val).__name__}"
    )


# --- pre-image builders (mirror TS canonicalCborForFleetOpSig / forWorkerSig) ---


def _v2_metrics_to_cbor(metrics: dict) -> _CborValue:
    """Build the metrics sub-map as canonical CBOR.

    Each field's CBOR type is fixed by the schema, NOT by the runtime Python
    type. This mirrors the TS encoder, which dodges
    `Number.isInteger(0.0) === true` by tagging types up front. We do the
    equivalent here by always routing the float-typed fields through
    `_v2_cbor_float` and the int-typed fields through `_v2_cbor_int`.
    """
    return _v2_cbor_map(
        [
            ("cpu_seconds", _v2_cbor_float(metrics["cpu_seconds"])),
            ("disk_gb_hours", _v2_cbor_float(metrics["disk_gb_hours"])),
            ("gpu_seconds", _v2_cbor_float(metrics["gpu_seconds"])),
            ("net_bytes_in", _v2_cbor_int(metrics["net_bytes_in"])),
            ("net_bytes_out", _v2_cbor_int(metrics["net_bytes_out"])),
            ("ram_gb_hours", _v2_cbor_float(metrics["ram_gb_hours"])),
        ]
    )


def _v2_hex_to_bytes(value) -> bytes:
    """Coerce hex-string OR raw-bytes input to raw bytes.

    Worker-side SDK passes raw bytes (32-byte sr25519 pubkey); gateway-side
    passes hex strings (wire-decoded). Same canonical output either way.
    """
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if isinstance(value, str):
        return bytes.fromhex(value.removeprefix("0x"))
    raise TypeError(f"expected bytes or hex str, got {type(value).__name__}")


def _v2_hardware_spec_no_sig_to_cbor(spec: dict) -> _CborValue:
    """`hardware_spec` map MINUS `fleet_operator_signature`.

    Pubkey is encoded as raw bytes (32) — the TS schema docs spec the
    pre-image as bytes, not hex.
    """
    return _v2_cbor_map(
        [
            ("cpu_cores", _v2_cbor_int(spec["cpu_cores"])),
            (
                "fleet_operator_pubkey",
                _v2_cbor_bytes(_v2_hex_to_bytes(spec["fleet_operator_pubkey"])),
            ),
            ("gpu_count", _v2_cbor_int(spec["gpu_count"])),
            ("gpu_type", _v2_cbor_text(spec["gpu_type"])),
            ("issued_ms", _v2_cbor_int(spec["issued_ms"])),
            ("ram_gb", _v2_cbor_int(spec["ram_gb"])),
        ]
    )


def _v2_hardware_spec_full_to_cbor(spec: dict) -> _CborValue:
    """Full `hardware_spec` including the fleet-op signature (bytes-64)."""
    return _v2_cbor_map(
        [
            ("cpu_cores", _v2_cbor_int(spec["cpu_cores"])),
            (
                "fleet_operator_pubkey",
                _v2_cbor_bytes(_v2_hex_to_bytes(spec["fleet_operator_pubkey"])),
            ),
            (
                "fleet_operator_signature",
                _v2_cbor_bytes(_v2_hex_to_bytes(spec["fleet_operator_signature"])),
            ),
            ("gpu_count", _v2_cbor_int(spec["gpu_count"])),
            ("gpu_type", _v2_cbor_text(spec["gpu_type"])),
            ("issued_ms", _v2_cbor_int(spec["issued_ms"])),
            ("ram_gb", _v2_cbor_int(spec["ram_gb"])),
        ]
    )


def canonical_cbor_for_fleet_op_sig(record: dict) -> bytes:
    """Build canonical CBOR bytes for the fleet-op-attestation pre-image.

        [ "fleet_op_attestation_v1", worker_id, hardware_spec_no_sig, issued_ms ]

    Mirrors the TS `canonicalCborForFleetOpSig`. Output bytes are guaranteed
    byte-identical across the two languages.

    Args:
        record: A dict with at least `worker_id` (str) and `hardware_spec`
            (dict containing `cpu_cores`, `ram_gb`, `gpu_type`, `gpu_count`,
            `fleet_operator_pubkey` (hex64), `fleet_operator_signature`
            (hex128 — IGNORED for this pre-image), `issued_ms`).

    Returns:
        Canonical CBOR-encoded bytes, deterministic per RFC 8949 §4.2.1.
    """
    if "worker_id" not in record:
        raise KeyError("canonical_cbor_for_fleet_op_sig: missing 'worker_id'")
    if "hardware_spec" not in record:
        raise KeyError("canonical_cbor_for_fleet_op_sig: missing 'hardware_spec'")
    spec = record["hardware_spec"]
    return _v2_encode_cbor(
        _v2_cbor_array(
            [
                _v2_cbor_text(FLEET_OP_TAG_V2),
                _v2_cbor_text(record["worker_id"]),
                _v2_hardware_spec_no_sig_to_cbor(spec),
                _v2_cbor_int(spec["issued_ms"]),
            ]
        )
    )


def canonical_cbor_for_worker_sig(
    record: dict,
    attestation_evidence=None,
) -> bytes:
    """Build canonical CBOR bytes for the worker-signature pre-image.

    v2 (default — no `attestation_evidence`):
        [ "compute_metering_v2", worker_id, tenant_id, period_start_ms,
          period_end_ms, metrics, hardware_spec_full, worker_pubkey_bytes ]

    v2.1 (when `attestation_evidence` is non-empty):
        [ "compute_metering_v2.1", worker_id, tenant_id, period_start_ms,
          period_end_ms, metrics, hardware_spec_full, worker_pubkey_bytes,
          attestation_evidence_array ]   # 9th element, sorted by EvidenceType

    Backwards compat: when `attestation_evidence` is omitted, None, or an
    empty list, the schema literal stays `compute_metering_v2` and the bytes
    are byte-identical to today's v2 — full backwards compatibility (PINNED).

    The observer signature, when present, signs THESE EXACT BYTES under the
    observer pubkey — never re-encode for the observer.

    Args:
        record: A dict with all required v2 fields. `worker_signature` is
            ignored; `observer` is ignored. `worker_pubkey` is hex64.
        attestation_evidence: Optional list of evidence-entry dicts, each
            with shape {"evidence_type": str, "nonce": hex64,
            "payload": dict}. Sorted by EvidenceType discriminant before
            encoding. Backwards-compatible default is None.

    Returns:
        Canonical CBOR-encoded bytes, deterministic per RFC 8949 §4.2.1.
    """
    # Allow the caller to pass evidence inline as `record["attestation_evidence"]`
    # (matches the wire JSON shape) — that overload exists so the worker SDK
    # doesn't have to split fields across two args.
    if attestation_evidence is None:
        attestation_evidence = record.get("attestation_evidence")
    has_evidence = bool(attestation_evidence)
    required = (
        "worker_id",
        "tenant_id",
        "period_start_ms",
        "period_end_ms",
        "metrics",
        "hardware_spec",
        "worker_pubkey",
    )
    for k in required:
        if k not in record:
            raise KeyError(f"canonical_cbor_for_worker_sig: missing '{k}'")

    elements = [
        _v2_cbor_text(SCHEMA_VERSION_V2_1 if has_evidence else SCHEMA_VERSION_V2),
        _v2_cbor_text(record["worker_id"]),
        _v2_cbor_text(record["tenant_id"]),
        _v2_cbor_int(record["period_start_ms"]),
        _v2_cbor_int(record["period_end_ms"]),
        _v2_metrics_to_cbor(record["metrics"]),
        _v2_hardware_spec_full_to_cbor(record["hardware_spec"]),
        _v2_cbor_bytes(_v2_hex_to_bytes(record["worker_pubkey"])),
    ]
    if has_evidence:
        elements.append(_v2_evidence_array_to_cbor(attestation_evidence))
    return _v2_encode_cbor(_v2_cbor_array(elements))


# Observer signs the EXACT SAME bytes as the worker (per the v2 spec — observer
# is an independent witness over the same record body). Exposed as an alias for
# call-site clarity; do NOT diverge — gateway verifies both sigs against the
# same pre-image.
canonical_cbor_for_observer_sig = canonical_cbor_for_worker_sig


def canonical_content_hash_v2(record: dict, attestation_evidence=None) -> str:
    """SHA-256 hex of the worker-signature pre-image. The upstream
    `content_hash` for the v2 / v2.1 sponsored-receipt anchor.

    `attestation_evidence` is an optional list — when present and non-empty,
    the v2.1 pre-image is used (extended by one CBOR array element). When
    None or empty, the v2 pre-image is used (byte-identical to today's v2).
    """
    return hashlib.sha256(
        canonical_cbor_for_worker_sig(record, attestation_evidence)
    ).hexdigest()


# ---------------------------------------------------------------------------
# Wave 3 Phase 2 — attestation_evidence canonical CBOR
#
# The mirror of the TS-side `evidenceArrayToCborValue` /
# `attestationEvidenceHash` / `deriveEvidenceNonce` / `*_b64` payload encoder.
# Pattern documented in services/blob-gateway/src/schemas/compute_metering_v2.ts.
# Cross-language byte equality is enforced by the
# `tests/test_v2_1_cross_lang.py` harness.
# ---------------------------------------------------------------------------

import re

_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
_BASE64_RE = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")


def _v2_decode_b64_strict(s: str) -> bytes:
    """Strict RFC 4648 §4 base64 decoder.

    `s` must use the standard alphabet (no URL-safe variant) with padding.
    Mirrors the TS `decodeBase64Strict` rule: regex pre-check then standard
    base64 decode. Throws `TypeError` (not `ValueError`) so that bad-payload
    errors are uniform with the rest of the encoder's surface.
    """
    import base64

    if not isinstance(s, str) or not _BASE64_RE.match(s):
        raise TypeError(
            f"evidence payload: value of *_b64 key must be RFC 4648 base64, "
            f'got "{s[:32] if isinstance(s, str) else type(s).__name__}..."'
        )
    return base64.b64decode(s, validate=True)


def _v2_payload_value_to_cbor(value, key_context=None):
    """Recursively convert a JSON-shaped Python value to a tagged CBOR value.

    The rules MUST match the TS `payloadJsonToCborValue` exactly:

      * dict        -> CBOR map (sorted on encode)
      * list/tuple  -> CBOR array
      * str         -> CBOR text  (default), OR
      * str under a key ending in `_b64` -> CBOR bytes (decoded base64)
      * int (not bool) -> CBOR int
      * float       -> CBOR float64 (8 bytes, never shortened)
      * bool        -> REJECTED (Python's `True is 1` quirk)
      * None        -> REJECTED
    """
    if value is None:
        raise TypeError("evidence payload: None is not permitted")
    if isinstance(value, bool):
        raise TypeError("evidence payload: bool is not permitted")
    if isinstance(value, int):
        return _v2_cbor_int(value)
    if isinstance(value, float):
        if value != value:  # NaN
            raise TypeError("evidence payload: NaN not permitted")
        if value in (float("inf"), float("-inf")):
            raise TypeError("evidence payload: Infinity not permitted")
        return _v2_cbor_float(value)
    if isinstance(value, str):
        if isinstance(key_context, str) and key_context.endswith("_b64"):
            return _v2_cbor_bytes(_v2_decode_b64_strict(value))
        return _v2_cbor_text(value)
    if isinstance(value, (list, tuple)):
        # No key context for array elements (the `_b64` rule binds to the
        # immediate parent dict key).
        return _v2_cbor_array([_v2_payload_value_to_cbor(v, None) for v in value])
    if isinstance(value, dict):
        pairs = []
        for k in value.keys():
            if not isinstance(k, str):
                raise TypeError(
                    f"evidence payload: map keys must be str, got {type(k).__name__}"
                )
            pairs.append((k, _v2_payload_value_to_cbor(value[k], k)))
        return _v2_cbor_map(pairs)
    raise TypeError(
        f"evidence payload: unsupported value type {type(value).__name__} "
        "(must be str/int/float/list/dict)"
    )


def _v2_evidence_entry_to_cbor(entry: dict):
    """Build the canonical-CBOR-tagged form of one evidence entry.

    Entry shape (wire JSON):
        {"evidence_type": str, "nonce": hex64, "payload": dict}

    Encodes to a CBOR map with three keys: evidence_type (text), nonce
    (32 bytes), payload (canonical-CBOR sub-map). Map keys are sorted on
    encode, matching the v2 metrics-map sort.
    """
    if not isinstance(entry, dict):
        raise TypeError(
            f"evidence entry: must be a dict, got {type(entry).__name__}"
        )
    et = entry.get("evidence_type")
    if et not in EVIDENCE_TYPES:
        raise TypeError(
            f'evidence entry: unknown evidence_type "{et}" '
            f"(allowed: {EVIDENCE_TYPES})"
        )
    nonce = entry.get("nonce")
    if not isinstance(nonce, str) or not _HEX64_RE.match(nonce):
        raise TypeError(
            f"evidence entry: nonce must be 64-char lowercase hex, got '{nonce}'"
        )
    payload = entry.get("payload")
    if not isinstance(payload, dict):
        raise TypeError("evidence entry: payload must be a JSON object (dict)")
    return _v2_cbor_map(
        [
            ("evidence_type", _v2_cbor_text(et)),
            ("nonce", _v2_cbor_bytes(bytes.fromhex(nonce))),
            ("payload", _v2_payload_value_to_cbor(payload)),
        ]
    )


def _v2_evidence_array_to_cbor(entries):
    """Convert a list of evidence-entry dicts into a CBOR array (sorted)."""
    if not isinstance(entries, (list, tuple)):
        raise TypeError(
            f"attestation_evidence must be a list, got {type(entries).__name__}"
        )
    sorted_entries = sorted(
        entries,
        key=lambda e: EVIDENCE_TYPE_DISCRIMINANT[e["evidence_type"]],
    )
    return _v2_cbor_array(
        [_v2_evidence_entry_to_cbor(e) for e in sorted_entries]
    )


def derive_evidence_nonce(content_hash_hex: str, evidence_type: str) -> str:
    """Compute nonce = sha256(content_hash_bytes || utf8(evidence_type)).

    Mirrors the TS `deriveEvidenceNonce`. Returns 64-char lowercase hex.
    """
    cleaned = (
        content_hash_hex[2:]
        if content_hash_hex.startswith("0x")
        else content_hash_hex
    )
    if not _HEX64_RE.match(cleaned):
        raise TypeError(
            f"derive_evidence_nonce: content_hash must be 32 bytes "
            f"(64 hex chars), got '{content_hash_hex}'"
        )
    if evidence_type not in EVIDENCE_TYPES:
        raise TypeError(
            f"derive_evidence_nonce: unknown evidence_type '{evidence_type}'"
        )
    h = hashlib.sha256()
    h.update(bytes.fromhex(cleaned))
    h.update(evidence_type.encode("utf-8"))
    return h.hexdigest()


def attestation_evidence_hash(entries) -> str:
    """SHA-256 hex of the canonical-CBOR encoding of an evidence array.

    Empty-vec case: hash of CBOR-empty-array (single byte 0x80) — NOT zeros.
    The empty-vec value is pinned in tests:
        `76be8b528d0075f7aae98d6fa57a6d3c83ae480a8469e668d7b0af968995ac71`
    """
    cbor_bytes = _v2_encode_cbor(_v2_evidence_array_to_cbor(entries))
    return hashlib.sha256(cbor_bytes).hexdigest()


def canonical_cbor_for_evidence_payload(payload: dict) -> bytes:
    """Convenience: canonical CBOR bytes for a single evidence payload dict.

    Used by the gateway route for verifying the attestor's signature: the
    attestor signs canonical CBOR of the payload (NOT the full record), so
    SDK consumers and gateway verify against the same bytes.
    """
    if not isinstance(payload, dict):
        raise TypeError("payload must be a dict")
    return _v2_encode_cbor(_v2_payload_value_to_cbor(payload))
