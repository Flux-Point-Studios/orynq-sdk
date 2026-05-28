# @orynq/observe

SDK for publishing attested AI model capability observations to chain-anchored receipts.

TypeScript / Node.js companion to the Python [`orynq-observe`](../orynq-observe) package.
The canonical CBOR encoder is byte-pinned between the two so a record signed by
either runtime verifies on the gateway and on chain.

## Quickstart — 5 minutes to first receipt

```bash
# 1. Install
npm install @orynq/observe

# 2. Generate an observer keyfile
npx orynq-observe keygen --out ./observer.json
# → { "scheme": "sr25519-observer", "public_hex": "...", "ss58_address": "5..." }

# 3. Get a sponsored gateway token (preprod is free for researchers — ask in
#    Discord or open an issue). Set OBSERVE_API_KEY=matra_xxx

# 4. Submit
npx orynq-observe submit \
    --model claude-opus-4-7 \
    --model-version 20260201 \
    --taxonomy AUTO-MONEY-001 \
    --severity high \
    --observer-context "independent red-team session" \
    --prompt-file prompt.txt \
    --response-file response.txt \
    --wallet ./observer.json \
    --network preprod \
    --api-key "$OBSERVE_API_KEY" \
    --wait-for-anchor 90
```

## Library usage

```typescript
import { Observation } from "@orynq/observe";

const obs = new Observation({
  modelName: "claude-opus-4-7",
  modelVersion: "20260201",
  taxonomyId: "AUTO-MONEY-001",
  severity: "high",
  observerContext: "independent red-team session, internal docs",
});
obs.addEvidence({ prompt, response });
obs.addArtifact("/path/to/transcript.json");
obs.attestTee({ tier: "Acurast", evidence: "..." });

const receipt = await obs.submit({
  wallet: "./observer.json",
  network: "preprod",
  apiKey: process.env.OBSERVE_API_KEY!,
});
console.log(receipt.materiosTx, receipt.cardanoAnchorTx);
```

## What the SDK does — and what it does NOT do

The SDK:

* Builds the canonical wire shape for `ai_capability_observation_v1`.
* Hashes prompt + response bytes locally (only the 32-byte digests go on chain).
* Signs the canonical CBOR pre-image with an sr25519 observer key
  (`@polkadot/util-crypto`).
* POSTs the envelope to the Materios blob gateway with the observer signature.
* Recomputes content_hash locally and refuses to trust a server-substituted value.
* Polls for the materios_tx + cardano_anchor_tx via `receipt.refresh(...)`.

The SDK does NOT:

* Compute the cert-daemon's M-of-N committee signatures.
* Submit `submit_receipt_v2` directly to Materios.
* Carry plaintext prompts / responses on chain.

## Schema

```typescript
{
  schemaVersion: "ai_capability_observation_v1",
  model: { name, version, hash | null },
  capability: { taxonomyId, severity: "low"|"medium"|"high"|"critical" },
  observation: {
    promptHash,       // sha256 of utf-8 prompt bytes (32 bytes, hex)
    responseHash,     // sha256 of utf-8 response bytes (32 bytes, hex)
    artifactRef | null, // opaque ref or "blob:<sha256>"
    occurredAt        // unix ms
  },
  observer: {
    ss58,
    context,
    teeAttestation: { tier, evidence } | null
  }
}
```

## Development

```bash
cd packages/orynq-observe-js
pnpm install
pnpm test
pnpm build
```

The cross-language byte-pin test invokes the sibling Python encoder to
verify byte-equality. If you don't have the Python package installed it
auto-skips; install it via the sibling pyproject to run that suite.

## License

MIT.
