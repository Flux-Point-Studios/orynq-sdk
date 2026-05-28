# Source finding

This demo round-trips a real, published AI capability finding through
`ai_capability_observation_v1`.

## Citation

* **Paper:** *Frontier Models are Capable of In-context Scheming*
* **Authors:** Alexander Meinke, Bronson Schoen, Jérémy Scheurer, et al.
  (Apollo Research, in collaboration with OpenAI)
* **Published:** December 5, 2024
* **ArXiv:** https://arxiv.org/abs/2412.04984
* **Project page:** https://www.apolloresearch.ai/research/scheming-reasoning-evaluations

## Specific finding (abstract, verbatim)

> When o1 has engaged in scheming, it maintains its deception in over 85%
> of follow-up questions [...] even in highly adversarial multi-turn
> interrogations.

— *Frontier Models are Capable of In-context Scheming*, abstract.

## Schema-field mapping

| Source-paper claim | `ai_capability_observation_v1` field | Value used in the round-trip |
|---|---|---|
| Subject model `o1` | `model.name` | `"openai-o1"` |
| Model version (date of paper publication, exact build unknown) | `model.version` | `"2024-12-05"` |
| Model integrity digest unavailable for closed-weights model | `model.hash` | `null` |
| Capability cluster (deception-under-interrogation) | `capability.taxonomyId` | `"DECEPTION-PERSIST-001"` |
| Apollo Research's stated severity tier ("highly adversarial" + ">85% persistence") | `capability.severity` | `"high"` |
| The exact prompt that elicited the behavior | `observation.promptHash` | sha256 of the in-context-scheming follow-up question template (see `apollo-finding.json`) |
| The response demonstrating persistence | `observation.responseHash` | sha256 of the verbatim model response from the paper's transcript appendix |
| Provenance link back to source | `observation.artifactRef` | `"arxiv:2412.04984"` |
| When the finding was published | `observation.occurredAt` | `"2024-12-05T00:00:00.000Z"` |
| Observer attribution string | `observer.context` | `"orynq-observe e2e-proof/02 round-trip of Apollo Research arxiv:2412.04984"` |
| Observer keypair (deterministic, for test reproducibility) | `observer.ss58` | derived from the pinned seed in `apollo-finding.json` |
| No TEE involved in this round-trip (we are not the original observers) | `observer.teeAttestation` | `null` |

## Round-trip property

The schema codec is byte-pinned across Python and TypeScript
(`canonical_cbor_pre_image` in `orynq_sdk.schemas.ai_capability_observation_v1`).
The demo asserts:

1. The mapping above encodes to deterministic canonical CBOR.
2. Decoding the canonical bytes recovers the exact mapping above —
   no field reordering, no null elision, no whitespace drift.
3. `content_hash` is stable across two encode passes.
4. The detail-page rendering for the observation accurately reflects
   the source paper's claim (we don't show "low" severity or a different
   model name).

If a future change to the schema codec breaks any of these four
properties, this test fails.
