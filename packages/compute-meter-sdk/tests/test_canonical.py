"""Tests for canonical CBOR serialization.

Canonical CBOR with sorted keys is the on-the-wire form schema #1 expects;
two records with the same logical content MUST produce identical bytes,
regardless of dict insertion order.
"""
from __future__ import annotations

from materios_compute_meter.canonical import (
    canonical_cbor,
    canonical_digest,
)


def test_canonical_cbor_sorts_keys_deterministically() -> None:
    a = {"b": 2, "a": 1, "c": 3}
    b = {"a": 1, "c": 3, "b": 2}
    assert canonical_cbor(a) == canonical_cbor(b)


def test_canonical_cbor_handles_nested_dicts() -> None:
    a = {"outer": {"y": 2, "x": 1}, "first": True}
    b = {"first": True, "outer": {"x": 1, "y": 2}}
    assert canonical_cbor(a) == canonical_cbor(b)


def test_canonical_cbor_handles_lists_in_order() -> None:
    # Lists must NOT be sorted — order is meaningful.
    assert canonical_cbor([3, 1, 2]) != canonical_cbor([1, 2, 3])
    assert canonical_cbor([3, 1, 2]) == canonical_cbor([3, 1, 2])


def test_canonical_cbor_returns_bytes() -> None:
    out = canonical_cbor({"hello": "world"})
    assert isinstance(out, bytes)
    assert len(out) > 0


def test_canonical_digest_is_sha256_of_cbor() -> None:
    import hashlib

    payload = {"a": 1, "b": 2}
    expected = hashlib.sha256(canonical_cbor(payload)).digest()
    assert canonical_digest(payload) == expected
    assert len(canonical_digest(payload)) == 32


def test_canonical_digest_is_stable_across_dict_orderings() -> None:
    a = {"b": 2, "a": 1}
    b = {"a": 1, "b": 2}
    assert canonical_digest(a) == canonical_digest(b)


def test_canonical_cbor_rejects_unhashable_or_unsupported_types() -> None:
    """Pure-CBOR primitives only: dict, list, tuple, str, bytes, int, float, bool, None.
    We forbid arbitrary objects in the canonical form so signers can't drift
    based on a custom __cbor__ encoder."""
    import pytest

    class Custom:
        pass

    with pytest.raises(Exception):
        canonical_cbor({"key": Custom()})
