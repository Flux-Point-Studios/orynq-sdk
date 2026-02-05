# Orynq SDK (poi-sdk)

Cryptographic AI process tracing and blockchain anchoring. Create tamper-proof, verifiable records of AI agent actions.

**Orynq** provides cryptographic receipts for AI—proving exactly what an AI did, when it did it, and in what order. Anchors are stored on the Cardano blockchain and can be verified by anyone.

## Features

### AI Process Tracing
- **Cryptographic Hash Chains** - Rolling hashes prove event ordering
- **Merkle Trees** - Efficient proofs for selective disclosure
- **Privacy Controls** - Mark events as public or private
- **Multi-Span Support** - Track nested operations and tool calls

### Blockchain Anchoring
- **Self-Hosted Anchoring** - Use your own wallet, no API fees (~0.2 ADA per anchor)
- **Anchor-as-a-Service** - Managed API with pay-per-use or subscription plans
- **Independent Verification** - Anyone can verify anchors using only the txHash
- **Cardano Native** - Stored under metadata label 2222

### Payment Protocol (for Anchor-as-a-Service)
- **x402 Protocol** - Coinbase standard for EVM chains
- **Flux Protocol** - Native Cardano payments
- **Auto-Pay Client** - Automatic payment handling with budget controls

## Quick Start

### Option 1: Self-Hosted Anchoring (No API Fees)

Use your own Cardano wallet to anchor directly to the blockchain.

```bash
npm install @fluxpointstudios/poi-sdk-process-trace \
            @fluxpointstudios/poi-sdk-anchors-cardano \
            lucid-cardano
```

```typescript
import {
  createTrace, addSpan, addEvent, closeSpan, finalizeTrace,
} from "@fluxpointstudios/poi-sdk-process-trace";
import {
  createAnchorEntryFromBundle, buildAnchorMetadata, serializeForCbor, POI_METADATA_LABEL,
} from "@fluxpointstudios/poi-sdk-anchors-cardano";
import { Lucid, Blockfrost } from "lucid-cardano";

// 1. Instrument your AI agent
const run = await createTrace({ agentId: "my-agent" });
const span = addSpan(run, { name: "code-review" });

await addEvent(run, span.id, {
  kind: "observation",
  content: "User requested security audit",
  visibility: "public",
});

await addEvent(run, span.id, {
  kind: "decision",
  content: "Will check for injection vulnerabilities",
  visibility: "public",
});

await closeSpan(run, span.id);
const bundle = await finalizeTrace(run);

console.log("Root Hash:", bundle.rootHash);
console.log("Merkle Root:", bundle.merkleRoot);

// 2. Build anchor metadata
const entry = createAnchorEntryFromBundle(bundle);
const metadata = serializeForCbor(buildAnchorMetadata(entry));

// 3. Submit with your own wallet
const lucid = await Lucid.new(
  new Blockfrost("https://cardano-mainnet.blockfrost.io/api/v0", process.env.BLOCKFROST_KEY),
  "Mainnet"
);
lucid.selectWalletFromSeed(process.env.WALLET_SEED);

const tx = await lucid.newTx()
  .attachMetadata(POI_METADATA_LABEL, metadata[POI_METADATA_LABEL])
  .complete();

const txHash = await tx.sign().complete().then(t => t.submit());
console.log("Anchored:", `https://cardanoscan.io/transaction/${txHash}`);
```

**Cost:** ~0.2-0.3 ADA per anchor (~$0.10-0.20 USD)

**Full example:** [examples/self-anchor](./examples/self-anchor)

### Option 2: Anchor-as-a-Service API

Use the managed API with automatic payment handling.

```bash
npm install @fluxpointstudios/poi-sdk-client \
            @fluxpointstudios/poi-sdk-payer-cardano-cip30
```

```typescript
import { PoiClient } from '@fluxpointstudios/poi-sdk-client';
import { createCip30Payer } from '@fluxpointstudios/poi-sdk-payer-cardano-cip30';

const payer = await createCip30Payer(window.cardano.nami);
const client = new PoiClient({
  payer,
  autoPay: true,
  budget: { maxPerRequest: '5000000' }, // 5 ADA max
});

const response = await client.fetch(
  'https://api-v3.fluxpointstudios.com/anchors/process-trace',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  }
);

const { txHash } = await response.json();
```

---

## Verification

Anyone can verify an anchor independently:

```typescript
import { createBlockfrostProvider, verifyAnchor } from "@fluxpointstudios/poi-sdk-anchors-cardano";

const provider = createBlockfrostProvider({
  projectId: process.env.BLOCKFROST_KEY,
  network: "mainnet",
});

const result = await verifyAnchor(provider, txHash, expectedRootHash);
console.log("Verified:", result.verified);
```

Or verify manually via Blockfrost:

```bash
curl -H "project_id: $BLOCKFROST_KEY" \
  "https://cardano-mainnet.blockfrost.io/api/v0/txs/{txHash}/metadata"
```

---

## Packages

### AI Process Tracing & Anchoring

| Package | Description |
|---------|-------------|
| `@fluxpointstudios/poi-sdk-process-trace` | Cryptographic process trace builder with hash chains and Merkle trees |
| `@fluxpointstudios/poi-sdk-anchors-cardano` | Cardano anchor builder, serializer, and verifier |

### Payment Protocol (for Anchor-as-a-Service)

| Package | Description |
|---------|-------------|
| `@fluxpointstudios/poi-sdk-core` | Protocol-neutral types and utilities |
| `@fluxpointstudios/poi-sdk-client` | Auto-pay HTTP client with budget tracking |
| `@fluxpointstudios/poi-sdk-payer-cardano-cip30` | CIP-30 browser wallet payer |
| `@fluxpointstudios/poi-sdk-payer-cardano-node` | Server-side Cardano payer |
| `@fluxpointstudios/poi-sdk-payer-evm-x402` | EIP-3009 gasless EVM payer |
| `@fluxpointstudios/poi-sdk-payer-evm-direct` | Direct ERC-20 transfer payer |
| `@fluxpointstudios/poi-sdk-server-middleware` | Express/Fastify payment middleware |
| `@fluxpointstudios/poi-sdk-gateway` | x402 ↔ Flux protocol bridge |
| `@fluxpointstudios/poi-sdk-cli` | Command-line interface |

### Python

```bash
pip install poi-sdk
```

---

## On-Chain Data Format

Anchors are stored under Cardano metadata **label 2222**:

```json
{
  "schema": "poi-anchor-v1",
  "anchors": [{
    "type": "process-trace",
    "version": "1.0",
    "rootHash": "sha256:abc123...",
    "manifestHash": "sha256:def456...",
    "merkleRoot": "sha256:789abc...",
    "timestamp": "2026-02-05T12:00:00Z",
    "itemCount": 47
  }]
}
```

**Privacy:** Only cryptographic hashes are stored on-chain. Raw prompts, responses, and sensitive data are **never** written to the blockchain.

---

## Documentation

- **Full Docs:** [docs.fluxpointstudios.com/proof-of-inference/poi-sdk](https://docs.fluxpointstudios.com/proof-of-inference/poi-sdk)
- **Live Demo:** [fluxpointstudios.com/orynq](https://fluxpointstudios.com/orynq)
- **Self-Anchor Example:** [examples/self-anchor](./examples/self-anchor)

---

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Type checking
pnpm typecheck
```

---

## Support

- **Discord:** [discord.gg/MfYUMnfrJM](https://discord.gg/MfYUMnfrJM)
- **Twitter:** [@fluxpointstudio](https://twitter.com/fluxpointstudio)
- **Email:** support@fluxpointstudios.com

## License

[MIT](LICENSE)
