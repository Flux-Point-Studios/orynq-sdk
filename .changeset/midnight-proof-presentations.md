---
"@fluxpointstudios/orynq-sdk-midnight-prover": minor
"@fluxpointstudios/orynq-sdk-anchors-midnight": minor
---

Add an immutable proof-presentation contract with current-state gas estimates, bounded gas retries and headroom for concurrent insertions, local proving and wallet-supplied submission, and verification of its exact deployment and calls through authenticated execution and GRANDPA finality. Export the shared finalized-transaction verifier and identify the legacy ProofPublisher as a simulator. Preprod deployment and both circuits are rehearsed; no mainnet deployment is recorded. Bind posted-proof trust roots to the network genesis and reject malformed private digests with value-free errors.
