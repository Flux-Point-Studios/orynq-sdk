---
"@fluxpointstudios/orynq-sdk-attestor": minor
---

Fail closed for unavailable hardware attestation verification. Nitro and SEV-SNP
return a typed verification-unavailable result with all checks false; unsupported
backends use the same result. Document the current verification capabilities.

`evaluatePolicy()` fails each requested check it cannot run: allowed signer
keys, revocation checking, a minimum firmware version without a reported
dotted-numeric version, and a minimum SVN for a TEE that reports none.
