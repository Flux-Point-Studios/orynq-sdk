# Orynq SDK

[![npm version](https://img.shields.io/npm/v/@fluxpointstudios/orynq-sdk-process-trace?label=process-trace)](https://www.npmjs.com/package/@fluxpointstudios/orynq-sdk-process-trace)
[![npm version](https://img.shields.io/npm/v/@fluxpointstudios/orynq-sdk-anchors-cardano?label=anchors-cardano)](https://www.npmjs.com/package/@fluxpointstudios/orynq-sdk-anchors-cardano)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Flux-Point-Studios/orynq-sdk?style=social)](https://github.com/Flux-Point-Studios/orynq-sdk)
[![Built for](https://img.shields.io/badge/Built%20for-EU%20AI%20Act%20%C2%B7%20NIST%20AI%20RMF%20%C2%B7%20ISO%2042001-success)](https://fluxpointstudios.com/materios/sdk)

> Orynq is a cryptographic AI process tracing SDK. Capture every span, event, decision, and tool call in your AI agent's execution as a rolling-hash chain, bundle into a Merkle tree, and anchor the root to Cardano L1 (metadata label 2222) or the Materios partner chain — for tamper-evident, third-party-verifiable proof of inference.

## What is Orynq?

Orynq is an open-source SDK that turns ordinary AI agent runs into cryptographic audit trails. As your agent executes, Orynq's `process-trace` library records each event — observations, decisions, tool calls, span open/close — into a **rolling SHA-256 hash chain**, so any retroactive edit breaks every downstream hash. At trace close, events are bundled into a **Merkle tree** whose root is a single 32-byte commitment representing the entire run.

That Merkle root is then **anchored to a public blockchain**: either Cardano L1 directly (under transaction metadata label `2222`) for maximum decentralization, or the **Materios partner chain** for higher-throughput receipts with committee certification and periodic L1 checkpointing. Once anchored, the trace is tamper-evident and verifiable by any third party with only the transaction hash — no vendor login, no API key, no operator cooperation required.

Orynq supports **selective disclosure**: you can publish per-event Merkle proofs to prove a specific decision happened without revealing the rest of the trace. Prompts, responses, and PII are never written on-chain — only cryptographic commitments.

## Why this matters

If a regulator or court audited your AI system in five years, what verifiable evidence could you produce to prove how a decision was made, who governed it, and that neither the data nor the model was altered over time? Application logs are not an audit trail — they are a database your team controls. Vendor observability dashboards (LangSmith, Langfuse, Datadog) require trust in the vendor and an active subscription; if the vendor or your account goes dark, the evidence goes with it.

Orynq is designed to be the artifact you hand a regulator or counterparty. It is aligned with **EU AI Act Article 12** (automatic logging and traceability of high-risk AI systems over their lifetime), **NIST AI RMF** GOVERN-1.4 and MEASURE-2 (tamper-evident records for inventory and trustworthy-AI evaluation), and **ISO/IEC 42001** A.6.2 and A.7.4 (record maintenance of AI decisions and evidenced governance).

## How Orynq compares

|                                  | **Orynq**                              | LangSmith / Langfuse                | EQTY                              | Datadog LLM Observability         |
| -------------------------------- | -------------------------------------- | ----------------------------------- | --------------------------------- | --------------------------------- |
| **Who can verify?**              | Anyone with `txHash` (public L1)       | Vendor + customer (login required)  | Vendor-attested                   | Vendor + customer (login required)|
| **Tamper-evidence**              | Cryptographic (rolling hash + Merkle)  | Vendor-attested only                | Vendor-attested                   | Vendor-attested only              |
| **Survives operator going dark** | Yes — root lives on Cardano L1         | No                                  | No                                | No                                |
| **Selective disclosure**         | Per-event Merkle proofs                | Dashboard-limited                   | Limited                           | Dashboard-limited                 |
| **Model-state proof**            | `manifestHash` pinned per inference    | Vendor-recorded (trust required)    | Vendor-recorded (trust required)  | None                              |
| **5-year cost**                  | ~0.2–0.3 ADA per anchor (one-time)     | ~$30k+/yr seat                      | Enterprise contract               | ~$30k+/yr seat                    |

---

## Quickstart — first trace in under 5 minutes

The fastest path from `npm install` to a chain-anchored trace, measured end-to-end on Materios preprod (Gemtek hardware, 2026-05-14):

```bash
npm install --global @fluxpointstudios/orynq-sdk-quickstart
orynq trace
```

That's it. The CLI auto-generates a fresh sr25519 identity, faucet-drips test MATRA, builds a one-event sample trace, uploads it to the blob gateway, submits the on-chain receipt, and prints a clickable explorer URL:

```
$ orynq trace
[+  0.0s] identity created 5DAX5EwUmLm7osAh7V28ZV68bEHGkakhrZ5nKWmxvLAKjpgd
[+ 26.8s] faucet dripped 1001000000 units (tx 0x943b38af...)
[+ 37.7s] waiting for MOTRA fee currency to generate (~10-30s)...
[+ 38.0s] MOTRA ready
[+ 38.0s] trace built — runId 89d889ed rootHash 9f537487c4d3
[+ 44.6s] receipt submitted — receiptId 0x1ba8b400a132 block 0xd3d2240a04
[+167.9s] certified

First trace anchored on Materios (167.9s)

View your trace:
  blob status   https://materios.fluxpointstudios.com/blobs/blobs/1ba8b400a132.../status
  chain block   https://polkadot.js.org/apps/?rpc=wss%3A%2F%2F.../#/explorer/query/0xd3d2240a04...
  chain info    https://materios.fluxpointstudios.com/chain-info
  health        https://materios.fluxpointstudios.com/health
```

The identity persists at `~/.orynq/config.json` so subsequent `orynq trace` runs reuse the same address. To upgrade from the preprod free-tier identity to a production Materios-anchored identity, see `docs/identity-upgrade.md`.

### Python

```bash
pip install orynq-sdk
orynq init       # generate identity + faucet drip
```

Python parity for the on-chain submit step is queued for v0.2.1 (#176) — the trace primitives (`orynq_sdk.trace`) already produce byte-for-byte identical bundles, so `orynq init` + the Node `orynq trace` is the recommended bootstrap today.

### Programmatic API

```typescript
import { bootstrapAndTrace } from "@fluxpointstudios/orynq-sdk-quickstart";

const result = await bootstrapAndTrace({
  // All defaults point at Materios preprod. Set any subset to override.
  agentId: "my-agent",
  summary: "anchored from my CI pipeline",
});

console.log("Trace URL:", result.urls.blobStatus);
console.log("Cert hash:", result.certHash);
```

## Features

### AI Process Tracing
- **Cryptographic Hash Chains** - Rolling hashes prove event ordering
- **Merkle Trees** - Efficient proofs for selective disclosure
- **Privacy Controls** - Mark events as public or private
- **Multi-Span Support** - Track nested operations and tool calls

### Blockchain Anchoring
- **Solo-Dev Quickstart** - One command (`orynq trace`) from install to chain-anchored receipt
- **Self-Hosted Anchoring** - Use your own wallet, no API fees (~0.2 ADA per anchor)
- **Anchor-as-a-Service** - Managed API with pay-per-use or subscription plans
- **Independent Verification** - Anyone can verify anchors using only the txHash
- **Cardano Native** - Stored under metadata label 2222
- **Materios Partner Chain** - High-throughput receipts with committee certification and Cardano L1 anchoring

### Payment Protocol (for Anchor-as-a-Service)
- **x402 Protocol** - Coinbase standard for EVM chains
- **Flux Protocol** - Native Cardano payments
- **Auto-Pay Client** - Automatic payment handling with budget controls

## Three deployment paths

Orynq is deliberately **un-opinionated about who pays for and submits the transaction**. Pick the trust model and operational profile that fits your stack:

1. [**Self-host (own wallet)**](#option-1-self-hosted-anchoring-no-api-fees) — submit anchors directly from your own Cardano wallet. No API fees, no third-party dependency. Recommended for teams with existing Cardano infrastructure.
2. [**Materios partner chain**](#option-2-materios-partner-chain) — high-throughput receipts with committee certification and periodic Cardano L1 anchoring. Use when you need sub-second receipt finality and many traces per minute.
3. [**Anchor-as-a-Service (managed)**](#option-3-anchor-as-a-service-api) — call a managed HTTPS endpoint and pay per anchor via x402 (EVM) or Flux (Cardano). Zero infrastructure on your side.

## Advanced usage

### Option 1: Self-Hosted Anchoring (No API Fees)

Use your own Cardano wallet to anchor directly to the blockchain.

```bash
npm install @fluxpointstudios/orynq-sdk-process-trace \
            @fluxpointstudios/orynq-sdk-anchors-cardano \
            lucid-cardano
```

```typescript
import {
  createTrace, addSpan, addEvent, closeSpan, finalizeTrace,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import {
  createAnchorEntryFromBundle, buildAnchorMetadata, serializeForCbor, POI_METADATA_LABEL,
} from "@fluxpointstudios/orynq-sdk-anchors-cardano";
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

### Option 2: Materios Partner Chain

Anchor high-throughput data on the Materios Partner Chain with automatic committee certification and Cardano L1 anchoring.

```bash
npm install @fluxpointstudios/orynq-sdk-anchors-materios
```

```typescript
import {
  MateriosProvider,
  submitCertifiedReceipt,
} from "@fluxpointstudios/orynq-sdk-anchors-materios";

const provider = new MateriosProvider({
  rpcUrl: "wss://materios.fluxpointstudios.com/rpc",
  signerUri: "//Alice", // or BIP39 mnemonic
});
await provider.connect();

// One function: upload blobs → submit receipt → wait for certification
const result = await submitCertifiedReceipt(provider, {
  contentHash: bundle.rootHash,
  rootHash: bundle.rootHash,
  manifestHash: bundle.manifestHash,
}, content, {
  blobGateway: {
    baseUrl: "https://materios.fluxpointstudios.com/blobs",
    // Option A: API key (higher rate limits)
    apiKey: process.env.BLOB_GATEWAY_API_KEY,
    // Option B: sr25519 signature (no API key needed, just a funded account)
    // signerKeypair: { address, sign },
  },
});

console.log("Receipt ID:", result.receiptId);
console.log("Certified:", !!result.certHash);
```

**Full example:** [examples/materios-e2e](./examples/materios-e2e)

### Option 3: Anchor-as-a-Service API

Use the managed API with automatic payment handling.

```bash
npm install @fluxpointstudios/orynq-sdk-client \
            @fluxpointstudios/orynq-sdk-payer-cardano-cip30
```

```typescript
import { PoiClient } from '@fluxpointstudios/orynq-sdk-client';
import { createCip30Payer } from '@fluxpointstudios/orynq-sdk-payer-cardano-cip30';

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
import { createBlockfrostProvider, verifyAnchor } from "@fluxpointstudios/orynq-sdk-anchors-cardano";

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
| `@fluxpointstudios/orynq-sdk-quickstart` | Solo-dev DX: `orynq init` / `orynq trace` CLI + one-call `bootstrapAndTrace()` API |
| `@fluxpointstudios/orynq-sdk-process-trace` | Cryptographic process trace builder with hash chains and Merkle trees |
| `@fluxpointstudios/orynq-sdk-anchors-cardano` | Cardano anchor builder, serializer, and verifier |
| `@fluxpointstudios/orynq-sdk-anchors-materios` | Materios chain receipts, certification, blob uploads, and verification |

### Payment Protocol (for Anchor-as-a-Service)

| Package | Description |
|---------|-------------|
| `@fluxpointstudios/orynq-sdk-core` | Protocol-neutral types and utilities |
| `@fluxpointstudios/orynq-sdk-client` | Auto-pay HTTP client with budget tracking |
| `@fluxpointstudios/orynq-sdk-payer-cardano-cip30` | CIP-30 browser wallet payer |
| `@fluxpointstudios/orynq-sdk-payer-cardano-node` | Server-side Cardano payer |
| `@fluxpointstudios/orynq-sdk-payer-evm-x402` | EIP-3009 gasless EVM payer |
| `@fluxpointstudios/orynq-sdk-payer-evm-direct` | Direct ERC-20 transfer payer |
| `@fluxpointstudios/orynq-sdk-server-middleware` | Express/Fastify payment middleware |
| `@fluxpointstudios/orynq-sdk-gateway` | x402 ↔ Flux protocol bridge |
| `@fluxpointstudios/orynq-sdk-cli` | Command-line interface |

### Python

```bash
pip install orynq-sdk
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

## Open standards work

Orynq is built in the open and we are actively proposing primitives we believe every AI audit-trail format should standardize on. Discussion and contributions welcome on the following tracking issues:

- [#58 — Governance-attestation event kind](https://github.com/Flux-Point-Studios/orynq-sdk/issues/58): a standard `governance-attestation` event for recording approvals, sign-offs, and policy decisions inline with execution traces.
- [#59 — Pre-execution manifest pinning](https://github.com/Flux-Point-Studios/orynq-sdk/issues/59): enforcing that the model/prompt/tool manifest is hashed and pinned *before* the run starts, so the model-state proof cannot be backfilled.
- [#60 — Verifiable tool-call receipts](https://github.com/Flux-Point-Studios/orynq-sdk/issues/60): receipts that cryptographically link a tool invocation to its result, so external side effects can be audited the same way as in-process events.
- [#61 — Long-term durable off-chain trace storage](https://github.com/Flux-Point-Studios/orynq-sdk/issues/61): durable storage patterns for the full trace body (the on-chain anchor only commits to the root) over 5–10 year retention windows.

---

## Documentation

- **Full Docs:** [docs.fluxpointstudios.com/proof-of-inference/orynq-sdk](https://docs.fluxpointstudios.com/proof-of-inference/orynq-sdk)
- **SDK Page:** [fluxpointstudios.com/materios/sdk](https://fluxpointstudios.com/materios/sdk)
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
