---
"@fluxpointstudios/orynq-sdk-attestor": patch
---

Fail closed for unavailable hardware attestation verification. Nitro and SEV-SNP
return a typed verification-unavailable result with all checks false; unsupported
backends use the same result. Document the current verification capabilities.
