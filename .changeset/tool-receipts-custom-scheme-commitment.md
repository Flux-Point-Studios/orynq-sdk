---
"@fluxpointstudios/orynq-sdk-tool-receipts": patch
---

A receipt scheme registered through `verifiers` can now verify. The response
commitment came only from the built-in scheme table, so every other scheme
ended in `response-not-bound` even when its signature covered the response. A
`ToolReceiptSchemeVerifier` may now carry its own `responseCommitment`, which is
compared against `response.hash` the way the built-in commitments are. A custom
scheme without one still fails with `response-not-bound`, and the built-in
schemes are unchanged. The commitment is read only as the verifier's own
property, so a polluted `Object.prototype` cannot supply one.
