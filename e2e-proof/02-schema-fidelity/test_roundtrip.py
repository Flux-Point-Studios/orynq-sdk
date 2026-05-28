"""Demo 2 — schema-fidelity round-trip.

We take a real published AI capability finding (Apollo Research's
`Frontier Models are Capable of In-context Scheming`, arxiv:2412.04984)
and verify it round-trips through `ai_capability_observation_v1` with
no semantic loss.

Properties asserted:

  P1. The mapping in `apollo-finding.json` validates against the schema's
      runtime validator without errors.
  P2. Two independent canonical-CBOR encodes of the same record produce
      byte-identical output.
  P3. The pinned `content_hash` and pre-image length match the values
      computed from the fixture. If a future codec change drifts either
      value, this test fails loudly.
  P4. `add_evidence(prompt=..., response=...)` over the source-paper's
      prompt + response strings produces the same `promptHash` /
      `responseHash` as the pinned fixture. This protects against the
      hashing primitive silently changing under us.
  P5. The schema fields the detail-page renderer surfaces (model name,
      severity, capability taxonomy id, observer context) match the
      source-paper claim — we do not show a different model or severity.
"""
from __future__ import annotations

import json
from pathlib import Path

from orynq_observe import Observation
from orynq_observe.canonical import (
    SCHEMA_VERSION,
    canonical_cbor,
    canonical_content_hash,
)

HERE = Path(__file__).parent
FIXTURE = HERE / "apollo-finding.json"

# Pinned across language ports. If the canonical encoder changes its
# output for this exact record, both numbers below MUST be updated and
# the change announced as a breaking schema bump.
PINNED_CONTENT_HASH = (
    "958f925baa9d69ec38d9bc8f0102b8d5b6ad817c3459e7dcf41c2ca53338b3dd"
)
PINNED_PRE_IMAGE_LEN = 434


def _load_fixture() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_p1_fixture_validates_against_schema():
    """The mapping doc parses through the canonical encoder cleanly."""
    fix = _load_fixture()
    record = fix["record"]
    assert record["schemaVersion"] == SCHEMA_VERSION
    # Round-tripping through the encoder is itself the runtime validator.
    canonical_cbor(record)
    canonical_content_hash(record)


def test_p2_canonical_cbor_is_deterministic():
    fix = _load_fixture()
    record = fix["record"]
    a = canonical_cbor(record)
    b = canonical_cbor(record)
    assert a == b
    assert isinstance(a, bytes)
    assert len(a) > 0


def test_p3_pinned_content_hash_and_pre_image_length():
    """Detect any drift in the byte-pinned encoder output."""
    fix = _load_fixture()
    record = fix["record"]
    pre_image = canonical_cbor(record)
    assert (
        len(pre_image) == PINNED_PRE_IMAGE_LEN
    ), (
        f"pre-image length drifted: expected {PINNED_PRE_IMAGE_LEN}, "
        f"got {len(pre_image)}"
    )
    digest = canonical_content_hash(record)
    assert digest == PINNED_CONTENT_HASH, (
        f"content_hash drifted from pinned fixture: expected "
        f"{PINNED_CONTENT_HASH}, got {digest}"
    )


def test_p4_evidence_hashes_match_pinned_fixture():
    """sha256(prompt) and sha256(response) match what's in the fixture."""
    fix = _load_fixture()
    prompt = fix["_test_prompt_text"]
    response = fix["_test_response_text"]

    obs = Observation(
        model_name=fix["record"]["model"]["name"],
        model_version=fix["record"]["model"]["version"],
        taxonomy_id=fix["record"]["capability"]["taxonomyId"],
        severity=fix["record"]["capability"]["severity"],
        observer_context=fix["record"]["observer"]["context"],
        occurred_at=fix["record"]["observation"]["occurredAt"],
    ).add_evidence(prompt=prompt, response=response)

    rebuilt = obs.to_record(observer_ss58=fix["record"]["observer"]["ss58"])
    rebuilt["observation"]["artifactRef"] = fix["record"]["observation"][
        "artifactRef"
    ]
    assert (
        rebuilt["observation"]["promptHash"]
        == fix["record"]["observation"]["promptHash"]
    )
    assert (
        rebuilt["observation"]["responseHash"]
        == fix["record"]["observation"]["responseHash"]
    )
    # The rebuilt record must encode to the SAME content_hash.
    assert canonical_content_hash(rebuilt) == PINNED_CONTENT_HASH


def test_p5_renderer_facing_fields_reflect_source_paper():
    """Sanity check that the schema fields a detail page would show
    actually carry the source paper's claim."""
    fix = _load_fixture()
    src = fix["_source"]
    rec = fix["record"]

    # Model name + severity must match the paper's subject + tier.
    assert "o1" in rec["model"]["name"], rec["model"]["name"]
    assert rec["capability"]["severity"] == "high"

    # The artifact ref carries the citation back to the paper.
    assert rec["observation"]["artifactRef"] == "arxiv:2412.04984"
    assert src["arxiv"].endswith("2412.04984")

    # The observer context names the source explicitly.
    assert "Apollo Research" in rec["observer"]["context"]
    assert "2412.04984" in rec["observer"]["context"]


def test_p6_observer_keypair_derives_to_fixture_ss58():
    """The deterministic seed in the fixture produces the SS58 the
    record was hashed under."""
    from orynq_observe.keypair import ObserverKeypair

    fix = _load_fixture()
    kp = ObserverKeypair.from_seed_hex(fix["_test_observer_seed"])
    assert kp.ss58_address == fix["_test_observer_ss58"]
    assert kp.ss58_address == fix["record"]["observer"]["ss58"]
