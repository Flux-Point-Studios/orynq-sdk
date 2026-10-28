---
"@fluxpointstudios/orynq-sdk-midnight-prover": patch
---

`verifyMerkleProof`, `verifySpanInclusion` and `computeSpanHash` are now the
process-trace implementations: span inclusion recomputes every event hash, and
a Merkle proof must use the leaf index its path encodes.
`generateMerkleInclusionProof` builds its proof with process-trace. The
simulation `SelectiveDisclosureProver.verifyProof` verifies the Merkle path in
the proof bytes and checks disclosed data with `verifySpanInclusion`; a
disclosed span must come with its events.
