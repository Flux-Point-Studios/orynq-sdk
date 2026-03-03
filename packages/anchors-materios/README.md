# @fluxpointstudios/orynq-sdk-anchors-materios

Materios blockchain anchor support for the Orynq SDK. Submits and verifies data anchors on the Materios Substrate chain via the `OrinqReceipts` pallet, with full receipt lifecycle management: submission, certification, L1 anchoring, and chain-of-custody verification.

## Installation

```bash
npm install @fluxpointstudios/orynq-sdk-anchors-materios
```

Peer dependencies are included automatically:

- `@polkadot/api` ^14.0.0
- `@polkadot/keyring` ^13.0.0
- `@polkadot/util` ^13.0.0

Requires Node.js >= 18.

## Quick Start

```ts
import {
  MateriosProvider,
  submitReceipt,
  waitForCertification,
  waitForAnchor,
  verifyReceipt,
} from "@fluxpointstudios/orynq-sdk-anchors-materios";

// 1. Connect to the Materios chain
const provider = new MateriosProvider({
  rpcUrl: "ws://your-materios-node:9945",
  signerUri: "//Alice", // dev account, or a seed phrase
});
await provider.connect();

// 2. Submit a receipt on-chain
const result = await submitReceipt(provider, {
  contentHash: "0xabcdef...",
  rootHash: "0xabcdef...",
  manifestHash: "0x123456...",
});
console.log("Receipt ID:", result.receiptId);
console.log("Block:", result.blockNumber);

// 3. Wait for the cert daemon committee to attest availability
const cert = await waitForCertification(provider, result.receiptId, {
  onPoll: (n, ms) => console.log(`  poll #${n} (${ms}ms elapsed)`),
});
console.log("Certified:", cert.certHash);

// 4. Wait for the receipt to be batched into a Cardano L1 anchor
const anchor = await waitForAnchor(provider, cert);
console.log("Anchored:", anchor.anchorId);

// 5. Verify the full chain of custody (5 steps)
const verification = await verifyReceipt(provider, result.receiptId);
console.log("Status:", verification.status); // "FULLY_VERIFIED"

await provider.disconnect();
```

## One-Function Orchestrator

`submitCertifiedReceipt()` handles the entire flow in a single call: blob upload, receipt submission, certification wait, and optional anchor wait.

```ts
import {
  MateriosProvider,
  submitCertifiedReceipt,
} from "@fluxpointstudios/orynq-sdk-anchors-materios";

const provider = new MateriosProvider({
  rpcUrl: "ws://your-materios-node:9945",
  signerUri: "//Alice",
});
await provider.connect();

const content = Buffer.from("my data payload");

const result = await submitCertifiedReceipt(
  provider,
  {
    contentHash: "0xabcdef...",
    rootHash: "0xabcdef...",
    manifestHash: "0x123456...",
  },
  content,
  {
    blobGateway: {
      baseUrl: "https://your-gateway.example.com/blobs",
      apiKey: "your-api-key",
    },
    waitForAnchor: true, // set false to skip waiting for L1 anchor
  },
);

console.log("Receipt:", result.receiptId);
console.log("Cert hash:", result.certHash);
console.log("Anchor:", result.anchor?.anchorId);

await provider.disconnect();
```

## Blob Uploads

Blob data must be uploaded to the gateway before the cert daemon can attest availability. Two authentication methods are supported:

### API Key Auth

Highest rate limits. Pass `apiKey` in the gateway config:

```ts
import { prepareBlobData, uploadBlobs } from "@fluxpointstudios/orynq-sdk-anchors-materios";

const content = Buffer.from("my data payload");
const { manifest, chunks } = prepareBlobData(receiptId, content);

const result = await uploadBlobs(contentHash, manifest, chunks, {
  baseUrl: "https://your-gateway.example.com/blobs",
  apiKey: "your-api-key",
});

if (!result.success) throw new Error(result.error);
```

### Signature-Based Auth

No API key needed. Requires a funded Materios account (minimum 1T MATRA). Uploads are signed with sr25519:

```ts
import { Keyring } from "@polkadot/keyring";

const keyring = new Keyring({ type: "sr25519" });
const pair = keyring.addFromUri("//Alice");

const result = await uploadBlobs(contentHash, manifest, chunks, {
  baseUrl: "https://your-gateway.example.com/blobs",
  signerKeypair: {
    address: pair.address,
    sign: (message) => pair.sign(message),
  },
});
```

The signing string format is: `materios-upload-v1|{contentHash}|{uploaderAddress}|{timestamp}`.

## Configuration

### MateriosProvider

| Parameter    | Type     | Required | Description                                      |
|-------------|----------|----------|--------------------------------------------------|
| `rpcUrl`    | `string` | Yes      | WebSocket RPC URL (e.g. `ws://node:9945`)        |
| `signerUri` | `string` | Yes      | Signer URI (`//Alice` for dev, or seed phrase)   |
| `timeout`   | `number` | No       | Request timeout in milliseconds                   |
| `retries`   | `number` | No       | Number of retry attempts                          |

### BlobGatewayConfig

| Parameter       | Type     | Required | Description                                       |
|----------------|----------|----------|---------------------------------------------------|
| `baseUrl`      | `string` | Yes      | Gateway base URL                                  |
| `apiKey`       | `string` | No       | API key for authenticated uploads                 |
| `signerKeypair`| `object` | No       | `{ address, sign }` for sr25519 signature auth    |

Provide either `apiKey` or `signerKeypair` (not both).

### PollOptions

| Parameter    | Type       | Default   | Description                          |
|-------------|------------|-----------|--------------------------------------|
| `intervalMs`| `number`   | `6000`    | Polling interval (~1 Substrate block)|
| `timeoutMs` | `number`   | `600000`  | Maximum wait time (10 minutes)       |
| `onPoll`    | `function` | -         | Callback `(attempt, elapsed) => void`|

## API Reference

### Receipt Lifecycle

| Function                   | Description                                                        |
|---------------------------|--------------------------------------------------------------------|
| `submitReceipt(provider, input)` | Submit a receipt on-chain. Includes dry-run pre-flight check. |
| `waitForCertification(provider, receiptId, opts?)` | Poll until the cert daemon attests availability. |
| `waitForAnchor(provider, certResult, opts?)` | Poll until the receipt is batched into an L1 anchor. |
| `verifyReceipt(provider, receiptId, opts?)` | Run 5-step chain-of-custody verification. |
| `submitCertifiedReceipt(provider, input, content, opts)` | One-function orchestrator: upload, submit, certify, anchor. |

### Receipt Queries

| Function                          | Description                                       |
|----------------------------------|---------------------------------------------------|
| `getReceipt(provider, receiptId)` | Query a receipt from on-chain storage.            |
| `isCertified(provider, receiptId)`| Check if `availability_cert_hash` is set.         |
| `getCertificationStatus(provider, receiptId, gateway?)` | Detailed certification status with blob check. |

### Blob Operations

| Function                                     | Description                                    |
|---------------------------------------------|------------------------------------------------|
| `prepareBlobData(receiptId, content, chunkSize?)` | Create manifest and chunks from raw content. |
| `uploadBlobs(contentHash, manifest, chunks, gateway)` | Upload manifest + chunks to the gateway. |

### MOTRA Fee Token

| Function                                   | Description                                      |
|-------------------------------------------|--------------------------------------------------|
| `queryMotraBalance(provider, address?)`    | Query MOTRA balance for an account.              |
| `waitForMotra(provider, minBalance?, opts?)` | Wait until MOTRA balance reaches minimum.      |

### Merkle Tree

| Function                                   | Description                                       |
|-------------------------------------------|---------------------------------------------------|
| `merkleRoot(leaves)`                       | Compute Merkle root from leaf hashes.             |
| `merkleInclusionProof(leaves, targetIndex)`| Generate inclusion proof for a specific leaf.     |
| `verifyMerkleProof(leaf, proof, root)`     | Verify a Merkle inclusion proof.                  |

### Infrastructure

| Function                           | Description                                          |
|-----------------------------------|------------------------------------------------------|
| `submitAnchor(provider, ...)`      | Submit an anchor (used by checkpoint workers).       |
| `getAnchor(provider, anchorId)`    | Query an anchor from on-chain storage.               |
| `anchorExists(provider, anchorId)` | Check if an anchor exists on-chain.                  |

### Hex Utilities

| Function          | Description                                      |
|------------------|--------------------------------------------------|
| `stripPrefix(s)` | Remove `sha256:` or `0x` prefix from a hex string. |
| `ensureHex(s)`   | Ensure a hex string has a `0x` prefix.           |
| `zeroHash()`     | Returns the 32-byte zero hash.                   |
| `isZeroHash(h)`  | Check if a hash is all zeros.                    |

## Verification Steps

`verifyReceipt()` runs a 5-step pipeline and returns a `VerifyResult` with status:

| Step | Title                  | Description                                           |
|------|------------------------|-------------------------------------------------------|
| 1    | Receipt on-chain       | Receipt exists in `orinqReceipts.receipts` storage    |
| 2    | Availability certified | `availability_cert_hash` is non-zero                  |
| 3    | Checkpoint leaf        | Leaf hash computed from chain ID + receipt ID + cert hash |
| 4    | Anchor found           | Matching anchor found in recent blocks (exact or Merkle) |
| 5    | Root hash verified     | Anchor root matches expected leaf or Merkle inclusion  |

Status values: `FULLY_VERIFIED`, `PARTIALLY_VERIFIED`, `NOT_VERIFIED`.

## License

MIT - Flux Point Studios
