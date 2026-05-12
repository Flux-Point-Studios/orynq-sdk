# @fluxpointstudios/orynq-sdk-payer-materios-x402

## 0.1.1 (2026-05-12)

PR #45 security-review polish (task #228). Five LOW-severity fixes to
tighten payload validation and API consistency. Wire-format unchanged
(domain separator still `materios-x402-v1`); existing 0.1.0 signatures
remain valid.

> npm history note: 0.1.0 was tagged in git but never published to npm.
> 0.1.1 is the first version published to the registry. There is no
> 0.1.0 release on npm to upgrade from.

### Fixes

- **L1 (`verifyMateriosPaymentSignature`)** — now runs `validatePayload`
  on the payload before computing the preimage. A downstream verifier
  that wires this function as their only check used to skip the
  freshness / nonce-shape / token / decimals / endpointClass /
  amount-range gates entirely; now those reject before any signature
  work happens.
- **L2 (`MateriosApiKeyPayer.getBalance`)** — was silently returning
  `0n` while `MateriosSelfPayPayer.getBalance` threw. Both paths now
  throw with the same descriptive shape (api-key path can't read FPS
  treasury balance; self-pay path doesn't ship a `@polkadot/api`
  client). Consistent surface for budget-tracker callers.
- **L3 (`validatePayload` pricing.token + pricing.decimals)** — now
  rejects anything other than `{ token: "MATRA", decimals: 15 }`. MATRA
  is the only billable asset; locking these client-side prevents a
  malformed 402 from generating a signature the gateway would later
  reject anyway.
- **L4 (`validatePayload` endpointClass)** — rejects empty strings and
  enforces `/^[a-z0-9_]+$/` canonical-form to match the gateway-side
  classifier. Stops stray casing / punctuation from silently
  invalidating the preimage's endpointClass binding.
- **L5 (`validatePayload` pricing.amount === 0n)** — defensive
  client-side guard. The gateway never emits zero-charge 402 in
  production, but a structurally malformed 402 now surfaces immediately
  rather than producing a no-op debit signature.

### Tests

- Added 5 new validation tests (one per fix) in
  `src/__tests__/payer.test.ts`. Existing 29 tests continue to pass
  unchanged; total = 34.

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
