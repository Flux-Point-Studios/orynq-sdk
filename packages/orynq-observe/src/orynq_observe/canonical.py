"""Canonical CBOR encoder for the ai_capability_observation_v1 schema.

Thin re-export over the canonical codec in
`orynq_sdk.schemas.ai_capability_observation_v1`. The SDK owns no encoder
bytes — every receipt the SDK signs is encoded by the same code path that
downstream verifiers (cert-daemon committee, anchor-worker) replay locally.

The canonical schema spec, pre-image rules (RFC 8949 §4.2.1 sorted maps,
shortest-head ints, byte-strings for hashes/evidence, CBOR null for absent
sub-trees), and validator all live in the schema module.
"""
from __future__ import annotations

from typing import Any, Dict

from orynq_sdk.schemas.ai_capability_observation_v1 import (
    SCHEMA_HASH_HEX,
    SCHEMA_VERSION,
    SEVERITIES,
    TEE_TIERS,
    canonical_cbor_pre_image,
    canonical_content_hash,
)


def canonical_cbor(record: Dict[str, Any]) -> bytes:
    return canonical_cbor_pre_image(record)


__all__ = [
    "SCHEMA_VERSION",
    "SCHEMA_HASH_HEX",
    "SEVERITIES",
    "TEE_TIERS",
    "canonical_cbor",
    "canonical_content_hash",
]
