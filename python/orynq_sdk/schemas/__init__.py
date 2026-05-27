"""Canonical schemas for receipt-class semantic roots.

Each submodule defines:
  * `SCHEMA_VERSION` — pinned literal.
  * `SCHEMA_HASH_HEX` — sha256(SCHEMA_VERSION), the upstream `schema_hash`
    discriminator the cert-daemon committee uses to dispatch verifiers.
  * `canonical_cbor_pre_image(record)` — deterministic CBOR bytes for the
    record (sha256 of these bytes is `contentHash`).
  * `canonical_content_hash(record)` — convenience: sha256 hex of the
    pre-image.
  * `validate_*` — wire-shape validator.
"""
from . import ai_capability_observation_v1

__all__ = ["ai_capability_observation_v1"]
