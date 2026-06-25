# Anti-lie patterns for AI tool calls (issue #60)

Orynq cryptographically preserves whatever events the wrapper records. If the
wrapper *lies* about what a tool returned, the lie is faithfully preserved. The
`tool-receipt` event makes the most important class of events — calls to external
systems — **independently verifiable**: it proves "the tool actually returned this
response", not just "the agent says the tool returned this response".

Verifiers live in `@fluxpointstudios/orynq-sdk-tool-receipts`.

## Supported schemes

| Scheme | What it covers |
| --- | --- |
| `http-message-signatures` | RFC 9421 — any API that signs its responses |
| `stripe-webhook` | Stripe `Stripe-Signature` HMAC-SHA256 |
| `github-webhook` | GitHub `X-Hub-Signature-256` HMAC-SHA256 |
| `jws` | generic JWS/JWT (HS*, RS*, PS*, ES*, EdDSA) |

Symmetric secrets (webhooks, HS*) are supplied **out-of-band** at verification time
— never embedded in the trace. Asymmetric *public* keys may be embedded in
`receipt.params.publicKey`.

> **Trust note:** an embedded public key only proves the payload was signed by
> *that* key. For authenticity, bind `signer` to a key you trust via the verify
> context (`keys` / `resolveKey`) rather than trusting the embedded key.

## Recording a receipt

```ts
import { addToolReceipt, hashToolPayload } from "@fluxpointstudios/orynq-sdk-tool-receipts";

await addToolReceipt(run, span.id, {
  toolId: "stripe.charges.create",
  request: { hash: await hashToolPayload(requestBody) },
  response: { hash: await hashToolPayload(responseBody), payload: responseBody },
  receipt: {
    scheme: "stripe-webhook",
    signer: "acct_123",
    signature: stripeSignatureHeader, // "t=...,v1=..."
    signedPayload: rawWebhookBody,
  },
});
```

## Verifying

```ts
import { verifyTrace } from "@fluxpointstudios/orynq-sdk-tool-receipts";

const result = await verifyTrace(bundle, {
  keys: { acct_123: process.env.STRIPE_WEBHOOK_SECRET! },
});
result.valid;                       // includes tool-receipt verification
result.checks.toolReceiptsValid;    // false if any receipt fails
result.toolReceipts.results;        // per-receipt verdicts
```

## Signing-proxy pattern (for tools that don't sign natively)

Wrap an unsigned tool in a TEE/HSM-signed envelope. Same trust pattern as Materios
witness phones (TEE-attested observations of external state).

```ts
import { generateKeyPairSync } from "node:crypto";
import { createSigningProxy, addToolReceipt, hashToolPayload } from "@fluxpointstudios/orynq-sdk-tool-receipts";

// In production the key lives in a TEE/HSM.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const proxy = createSigningProxy({
  signer: "tee://pricing-proxy",
  alg: "EdDSA",
  privateKey,
  publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
});

// The proxy observes the unsigned tool response and signs it.
const responseBody = await callUnsignedTool(req);
const receipt = proxy.sign(responseBody);

await addToolReceipt(run, span.id, {
  toolId: "internal.pricing",
  request: { hash: await hashToolPayload(req) },
  response: { hash: await hashToolPayload(responseBody), payload: responseBody },
  receipt,
});
```

The resulting `jws` receipt verifies with `verifyTrace` / `verifyToolReceipts` with
no extra secrets (the public key is embedded), so auditors get tool-call integrity
for free.
