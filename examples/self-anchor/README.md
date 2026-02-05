# Self-Hosted Anchoring Example

This example shows how to anchor AI process traces to Cardano using your own wallet, without going through the Flux Point Studios API.

## Prerequisites

- Node.js 18+
- A Cardano wallet with some ADA (mainnet or preprod testnet)
- A Blockfrost API key (free at https://blockfrost.io)

## Installation

```bash
npm install @fluxpointstudios/poi-sdk-process-trace \
            @fluxpointstudios/poi-sdk-anchors-cardano \
            lucid-cardano
```

## Usage

### 1. Instrument Your AI Agent

```typescript
import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
  createManifest,
} from "@fluxpointstudios/poi-sdk-process-trace";

// Start a trace for your AI session
const run = await createTrace({
  agentId: "my-claude-agent",
  metadata: { model: "claude-3", sessionId: "abc123" },
});

// Track a span (logical unit of work)
const span = addSpan(run, { name: "code-review" });

// Record events as your agent works
await addEvent(run, span.id, {
  kind: "observation",
  content: "User requested code review for auth.ts",
  visibility: "public",
});

await addEvent(run, span.id, {
  kind: "decision",
  content: "Will check for security vulnerabilities first",
  visibility: "public",
});

await addEvent(run, span.id, {
  kind: "command",
  command: "read_file",
  args: { path: "src/auth.ts" },
  visibility: "private", // Keep file contents private
});

await addEvent(run, span.id, {
  kind: "output",
  content: "Found 2 potential issues: SQL injection on line 45, missing input validation on line 78",
  visibility: "public",
});

// Close the span
await closeSpan(run, span.id);

// Finalize the trace - this computes all cryptographic hashes
const bundle = await finalizeTrace(run);

console.log("Root Hash:", bundle.rootHash);
console.log("Manifest Hash:", bundle.manifestHash);
console.log("Merkle Root:", bundle.merkleRoot);
```

### 2. Build Anchor Metadata

```typescript
import {
  createAnchorEntryFromBundle,
  buildAnchorMetadata,
  serializeForCbor,
  POI_METADATA_LABEL,
} from "@fluxpointstudios/poi-sdk-anchors-cardano";

// Create anchor entry from the bundle
const entry = createAnchorEntryFromBundle(bundle, {
  storageUri: "ipfs://QmYourManifestCID", // Optional: where you stored the full trace
  agentId: "my-claude-agent",
});

// Build the metadata
const anchorResult = buildAnchorMetadata(entry);

// Serialize for CBOR (handles 64-byte string limit)
const cborMetadata = serializeForCbor(anchorResult);
```

### 3. Submit to Cardano (with Lucid)

```typescript
import { Lucid, Blockfrost } from "lucid-cardano";

// Initialize Lucid with your wallet
const lucid = await Lucid.new(
  new Blockfrost(
    "https://cardano-preprod.blockfrost.io/api/v0", // or mainnet
    "YOUR_BLOCKFROST_PROJECT_ID"
  ),
  "Preprod" // or "Mainnet"
);

// Load your wallet (seed phrase, private key, or browser wallet)
lucid.selectWalletFromSeed("your twelve word seed phrase here ...");

// Build and submit the transaction
const tx = await lucid
  .newTx()
  .attachMetadata(POI_METADATA_LABEL, cborMetadata[POI_METADATA_LABEL])
  .complete();

const signedTx = await tx.sign().complete();
const txHash = await signedTx.submit();

console.log("Anchor submitted! TxHash:", txHash);
console.log(`View on explorer: https://preprod.cardanoscan.io/transaction/${txHash}`);

// Wait for confirmation (optional)
await lucid.awaitTx(txHash);
console.log("Anchor confirmed on-chain!");
```

### 4. Verify an Anchor

```typescript
import {
  createBlockfrostProvider,
  verifyAnchor,
} from "@fluxpointstudios/poi-sdk-anchors-cardano";

const provider = createBlockfrostProvider({
  projectId: "YOUR_BLOCKFROST_PROJECT_ID",
  network: "preprod",
});

const result = await verifyAnchor(provider, txHash, bundle.rootHash);

if (result.verified) {
  console.log("Anchor verified!");
  console.log("On-chain data:", result.anchor);
} else {
  console.log("Verification failed:", result.error);
}
```

## Alternative: Using cardano-cli

If you prefer cardano-cli over Lucid:

```typescript
import { serializeForCardanoCli } from "@fluxpointstudios/poi-sdk-anchors-cardano";
import { writeFileSync } from "fs";

// Serialize metadata for cardano-cli
const cliJson = serializeForCardanoCli(anchorResult);
writeFileSync("metadata.json", cliJson);
```

Then use cardano-cli:

```bash
cardano-cli transaction build \
  --tx-in <UTXO> \
  --change-address <YOUR_ADDRESS> \
  --metadata-json-file metadata.json \
  --out-file tx.raw

cardano-cli transaction sign \
  --tx-body-file tx.raw \
  --signing-key-file payment.skey \
  --out-file tx.signed

cardano-cli transaction submit --tx-file tx.signed
```

## Cost

Each anchor transaction costs approximately:
- **Preprod testnet**: Free (get test ADA from the faucet)
- **Mainnet**: ~0.2-0.3 ADA (~$0.10-0.20 USD)

The cost is just the standard Cardano transaction fee - no additional service fees when self-hosting.

## Storage Options

The on-chain anchor only stores cryptographic hashes (~200 bytes). You should store the full trace data separately:

- **IPFS**: Decentralized, permanent storage
- **Arweave**: Permanent storage with one-time fee
- **Your own server**: Full control, but requires maintenance
- **Don't store**: If you only need the cryptographic proof, not the full trace

## Security Notes

- Never commit your seed phrase or private keys to git
- Use environment variables or a secrets manager
- For production, consider using a hardware wallet or custodial solution
- The SDK never transmits your private keys - all signing happens locally
