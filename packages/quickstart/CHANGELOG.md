# @fluxpointstudios/orynq-sdk-quickstart

## 0.2.0

### Minor Changes

- f1a5107: New package `@fluxpointstudios/orynq-sdk-quickstart` — sub-5-minute solo-dev DX (#175). Ships an `orynq` CLI (`init`, `trace`, `whoami`, `status`) plus a one-call `bootstrapAndTrace()` API that auto-generates an sr25519 identity, faucet-drips test MATRA, builds + submits a sample chain-anchored trace, and prints clickable explorer URLs. Measured 167.9s end-to-end on Materios preprod (Gemtek hardware) — well under the 5-minute bar. Additive — existing API surface is unchanged.
