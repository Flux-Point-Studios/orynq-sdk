---
"@fluxpointstudios/orynq-sdk-midnight-prover": minor
---

`verifyMerkleProof`, `verifySpanInclusion` and `computeSpanHash` are now the
process-trace implementations: span inclusion recomputes every event hash, and
a Merkle proof must use the leaf index its path encodes.
`generateMerkleInclusionProof` builds its proof with process-trace.

The simulation `SelectiveDisclosureProver` gains
`verifyDisclosure(proof, options)`, which verifies the Merkle path in the proof
bytes and reports what the proof binds; `verifyProof` takes the same options
and returns its `valid`. A full disclosure must hash to the public span hash,
and the result holds its span and events as committed. A proof made with
`includeEventData: false` or `includeSpanData: false` discloses data nothing
binds, so it is reported `unbound` instead of passing on unchecked data.
`DefaultMidnightProver.verify` returns the reason in `errors`.
