# @fluxpointstudios/orynq-sdk-attestor

## 0.2.0

### Minor Changes

- ab2e261: Fail closed for unavailable hardware attestation verification. Nitro and SEV-SNP
  return a typed verification-unavailable result with all checks false; unsupported
  backends use the same result. Document the current verification capabilities.

  `evaluatePolicy()` fails each requested check it cannot run: allowed signer
  keys, revocation checking, a minimum firmware version without a reported
  dotted-numeric version, and a minimum SVN for a TEE that reports none.

## 0.1.1

### Patch Changes

- Updated dependencies [ffa932e]
  - @fluxpointstudios/orynq-sdk-core@0.3.2
