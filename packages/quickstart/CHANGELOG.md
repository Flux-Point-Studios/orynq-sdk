# @fluxpointstudios/orynq-sdk-quickstart

## 0.4.1

### Patch Changes

- `orynq trace` receipts are now certified by the Materios committee. Each receipt's blob is uploaded under its content hash, where the gateway's locator looks it up, instead of under the receipt ID. The receipt's on-chain root is now the Merkle root of the uploaded chunk hashes, which the committee checks; before, it was the trace's own root hash. Earlier receipts could never be certified. The blob-status link now points at the content hash.

## 0.3.0

### Minor Changes

- d08a00e: Add the read-only `verify_midnight_anchor` MCP tool and the `orynq verify midnight`, `orynq keys init midnight`, and `orynq anchor midnight` CLI commands. These prerelease surfaces require the optional anchors-midnight peer, which remains private and unavailable on npm until the D-10 release gate opens. Use a built orynq-sdk source checkout as documented in each package README; npm-only installs report this requirement without breaking other tools or commands. No Midnight submitter is published.

  Keep private Midnight minor releases from forcing major releases of MCP and quickstart.

## 0.2.1

### Patch Changes

- Updated dependencies [41f315b]
  - @fluxpointstudios/orynq-sdk-anchors-materios@0.6.0

## 0.2.0

### Minor Changes

- f1a5107: New package `@fluxpointstudios/orynq-sdk-quickstart` — sub-5-minute solo-dev DX (#175). Ships an `orynq` CLI (`init`, `trace`, `whoami`, `status`) plus a one-call `bootstrapAndTrace()` API that auto-generates an sr25519 identity, faucet-drips test MATRA, builds + submits a sample chain-anchored trace, and prints clickable explorer URLs. Measured 167.9s end-to-end on Materios preprod (Gemtek hardware) — well under the 5-minute bar. Additive — existing API surface is unchanged.

### Patch Changes

- Updated dependencies [48f2049]
- Updated dependencies [48f2049]
- Updated dependencies [3cd6027]
- Updated dependencies [2efef73]
- Updated dependencies [48f2049]
  - @fluxpointstudios/orynq-sdk-process-trace@0.3.0
  - @fluxpointstudios/orynq-sdk-anchors-materios@0.5.0
