---
"@fluxpointstudios/orynq-sdk-payer-evm-direct": patch
---

The `./signers` subpath now resolves. The export map has named
`dist/signers/index.{js,cjs}` since 0.2.0, but the build produced only the
package root, so importing
`@fluxpointstudios/orynq-sdk-payer-evm-direct/signers` failed with
`ERR_MODULE_NOT_FOUND`, and `ViemSigner`, `EvmKmsSigner` and `KmsSigner` could
not be reached from npm. The build now emits that entry.
