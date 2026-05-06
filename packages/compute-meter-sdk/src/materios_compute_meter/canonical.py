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
