# Demo 2 — Schema fidelity

Take a real, published AI capability finding and prove the
`ai_capability_observation_v1` schema can carry the claim without
semantic loss.

## Source

* *Frontier Models are Capable of In-context Scheming*
  Meinke A., Schoen B., Scheurer J. et al., Apollo Research, 2024-12-05
* https://arxiv.org/abs/2412.04984
* Specific claim from the abstract:
  > "When o1 has engaged in scheming, it maintains its deception in
  > over 85% of follow-up questions, even in highly adversarial
  > multi-turn interrogations."

The full mapping from claim → schema fields is in
[`source-finding.md`](./source-finding.md). The pinned record itself
sits in [`apollo-finding.json`](./apollo-finding.json).

## What is proven

The test suite asserts six properties:

| # | Property |
|---|---|
| P1 | The mapped record validates against the canonical schema validator |
| P2 | Canonical CBOR encoding is deterministic across two passes |
| P3 | Pre-image length AND `content_hash` match pinned values — guards against silent codec drift |
| P4 | sha256 of the source-paper's prompt + response text reproduces the pinned `promptHash` / `responseHash` |
| P5 | Detail-page-facing fields (model name, severity, taxonomyId, observer context) actually carry the source-paper claim |
| P6 | The fixture's deterministic seed derives to the SS58 address the record was hashed under |

If any of these fails, the schema has drifted from what the source paper
needs and the failure must be addressed before merge.

## Why these matter (and Goodhart)

It is trivial to publish a *schema* whose codec is stable. It is harder
to publish one that:

* Carries the source-paper's claim in fields a downstream UI will
  actually render (P5).
* Refuses to silently drop the citation back to the source (P5 again —
  `artifactRef = "arxiv:2412.04984"` is checked explicitly).
* Produces the same `content_hash` whether you build the record from
  the JSON fixture or from the original prompt+response text via the
  Python builder (P4).

The combination is what makes the schema useful as a public substrate
for AI capability claims, not just a hash sink.

## Run

```bash
pip install -e packages/orynq-observe
pytest e2e-proof/02-schema-fidelity/test_roundtrip.py -v
```

No network. No FPS endpoint. Pure local round-trip.

## Cross-language equivalence

The TypeScript port of the same encoder lives at
`packages/anchors-materios/src/schemas/ai_capability_observation_v1.ts`,
and the cross-language byte-equality of the codec is enforced by
`python/tests/test_ai_capability_observation_v1_cross_lang.py`. That
existing test guarantees the byte values pinned here are reproducible
from the TS encoder as well — any third party with either runtime can
re-derive the same `content_hash`.
