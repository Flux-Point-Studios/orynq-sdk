# @fluxpointstudios/orynq-sdk-payer-materios-x402

Materios-native sr25519 x402 payer + api-key passthrough for the Materios
billing gateway.

This package closes the client-side x402 loop for Materios billing. The
gateway 402 middleware
([services/blob-gateway/src/middleware/billing-402.ts][gw]) emits an
`X-402-Payment-Required` header on requests that lack sufficient
`pallet-billing::Balances`; this package generates the matching
`x-402-payment-signature` + `x-402-payer-ss58` headers the client returns
on the retry.

[gw]: ../../services/blob-gateway/src/middleware/billing-402.ts

## Install

```bash
pnpm add @fluxpointstudios/orynq-sdk-payer-materios-x402
```

## Quick start

### Self-pay (sr25519)

The caller signs the canonical materios-x402 preimage with their own
sr25519 key. The gateway debits `pallet-billing::Balances` for the SS58
that signed.

```ts
import {
  createMateriosPayer,
  parseMateriosPaymentRequired,
  unpackPaymentProofHeaders,
} from "@fluxpointstudios/orynq-sdk-payer-materios-x402";

const payer = createMateriosPayer({
  // mnemonic, raw `0x<64-hex>` seed, or `//Alice` dev derivation
  signerUri: process.env.MATERIOS_SIGNER_URI!,
});

// Original request returns 402:
const response = await fetch(url, originalOpts);
if (response.status === 402) {
  const payload = parseMateriosPaymentRequired(
    response.headers.get("X-402-Payment-Required")!,
  );
  const proof = await payer.pay({
    protocol: "x402",
    chain: "materios:preprod",
    asset: "MATRA",
    amountUnits: payload.pricing.amount,
    payTo: payload.recipient,
    raw: payload,
  });
  const headers = unpackPaymentProofHeaders(proof.signature);
  // Retry the original request with the headers attached:
  await fetch(url, {
    ...originalOpts,
    headers: { ...originalOpts.headers, ...headers },
  });
}
```

### API-key (FPS-sponsored)

If you have an FPS-issued `matra_…` Bearer token, you don't sign — the
api-key already authorizes the FPS treasury to sponsor your request. If
the gateway still 402s while a valid api-key is attached, the treasury or
your per-key cap is exhausted; `pay()` throws with an actionable message.

```ts
const payer = createMateriosPayer({ apiKey: process.env.MATRA_API_KEY! });
// Attach `Authorization: Bearer ${apiKey}` to your requests as usual.
// On 402, `payer.pay(...)` throws — surface the message to the user.
```

## Wire-format contract

The canonical preimage signed by the self-pay path is **v1** and matches
the layout documented in [`src/preimage.ts`](./src/preimage.ts) and
byte-pinned by [`src/__tests__/preimage.test.ts`](./src/__tests__/preimage.test.ts):

```
canonical_preimage = concat(
  utf8("materios-x402-v1"),               // 16-byte domain separator
  u32_le(len(endpointClass)) || utf8(endpointClass),
  u128_le(BigInt(pricing.amount)),
  bytes32(payload.nonce),                 // 32 raw bytes from "0x<64-hex>"
  u64_le(payload.expires)
)
```

The signed message is `blake2_256(canonical_preimage)`. Verifiers MUST
mirror this layout byte-for-byte; bumping the domain separator (e.g.
`materios-x402-v2`) is the canonical way to roll the format without risk
of cross-version replay.

## Provenance

- Phase 2.A part 4 of the prepaid-balance pipeline. Design ref:
  `/home/deci/work/phase-2-prepaid-balance-design.md`.
- Pairs with:
  - `pallet-billing` (Materios runtime, PRs #19/#20/#21)
  - gateway 402 middleware (orynq-sdk PRs #43, #44)

## License

MIT.
