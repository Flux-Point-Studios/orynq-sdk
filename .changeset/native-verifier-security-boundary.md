---
"@fluxpointstudios/orynq-sdk-midnight-prover": minor
---

Distinguish unavailable or misconfigured native verification from completed invalid-proof verdicts with `NativeVerifierConfigurationError`, including CLI exit 2. Remove the unused caller verification clock from newly generated envelopes and native requests; the proved deadline and verifier's own clock remain authoritative. Update the native binary together with this SDK release.

Enforce reviewed verifier-key and initial-state SHA-256 pins during circuit compilation and release packing, and compile official circuit identities into the native verifier. Update the native rustls dependency and gate native CI with an explicit advisory policy.
