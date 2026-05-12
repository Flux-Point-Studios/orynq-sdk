# @fluxpointstudios/orynq-sdk-payer-materios-x402

## 0.1.0 (2026-05-12)

Initial release — Phase 2.A part 4 of the Materios prepaid-balance pipeline.

### Surface

- `createMateriosPayer({ apiKey })` — api-key passthrough payer. The
  caller authorizes via `Authorization: Bearer matra_…`; `pay()` throws
  on 402 because the api-key path doesn't participate in the x402
  signature exchange (a 402 here means treasury or per-key cap is
  exhausted, not that auth was missing).
- `createMateriosPayer({ signerUri })` — sr25519 self-pay payer.
  Signs the canonical materios-x402 preimage with the caller's own
  keypair (mnemonic / raw seed / `//Alice` derivation). The gateway
  later debits `pallet-billing::Balances` for the signing SS58.
- `buildMateriosPayPreimage(payload)` — pure preimage builder, exported
  so downstream verifiers (Rust pallet, Python daemons, third-party
  TypeScript) can share the byte-for-byte wire-format contract.
- `parseMateriosPaymentRequired(headerValue)` — parse + validate a
  gateway-emitted `X-402-Payment-Required` JSON header.
- `verifyMateriosPaymentSignature(...)` — sr25519 signature verifier
  using the canonical preimage hash. Test helper + standalone verifier.

### Wire-format contract (v1)

Domain separator: `materios-x402-v1` (16-byte UTF-8 prefix). Layout
documented in `src/preimage.ts`; byte-pinned in
`src/__tests__/preimage.test.ts`. Rolling the format = bump the domain
separator (e.g. `v2`); old signatures naturally become invalid.

### Pipeline

Closes the client side of Phase 2.A:
- `pallet-billing` (Materios runtime, PRs #19/#20/#21) — on-chain state
- gateway 402 middleware (orynq-sdk PRs #43, #44) — emits the headers
- **this package** — generates the signed retry payload
