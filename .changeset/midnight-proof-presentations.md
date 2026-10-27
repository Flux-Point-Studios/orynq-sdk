---
"@fluxpointstudios/orynq-sdk-midnight-prover": minor
"@fluxpointstudios/orynq-sdk-anchors-midnight": minor
---

Add an immutable proof-presentation contract with current-state gas estimates, bounded transcript-refusal retries (JSON-RPC 1010/custom 104, including gas exhaustion) and headroom for concurrent insertions, local proving and wallet-supplied submission, and verification of its exact deployment and calls through authenticated execution and GRANDPA finality. Export the shared finalized-transaction verifier and identify the legacy ProofPublisher as a simulator. Preprod deployment and both circuits are rehearsed; no mainnet deployment is recorded. Export the shared typed/legacy node-refusal decoder and retain numeric refusal codes in redacted source errors. Bind posted-proof trust roots to an allowlisted network genesis and both transactions’ encoded network ids and reject malformed private digests with value-free errors.
