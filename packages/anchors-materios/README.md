# @fluxpointstudios/orynq-sdk-anchors-materios

Materios blockchain anchor support for the Orynq SDK. Submits and verifies data anchors on the Materios Substrate chain via the `OrinqReceipts` pallet, with full receipt lifecycle management: submission, certification, L1 anchoring, and chain-of-custody verification.

## Installation

```bash
npm install @fluxpointstudios/orynq-sdk-anchors-materios
```

> **⚠️ Upgrade from 0.3.1**: `0.3.1` shipped with a positional-argument bug
> that caused `submitReceipt` to land receipts on chain with `schema_hash =
> 0x00…00` and `base_root_sha256` in the wrong slot — silently. The
> on-chain transaction succeeded; cert-daemons rejected the receipt with
> `Merkle root mismatch`; receipts already submitted under 0.3.1 are
> unrecoverable. Upgrade to **`0.3.2` or later** to fix. See CHANGELOG.md
> for the full post-mortem.

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

## Connection and submission deadlines

`MateriosProvider` accepts optional `connectTimeoutMs` (default `30000`) and
`inclusionTimeoutMs` (default `120000`). Override one call with
`connect({ timeoutMs })`, `submitReceipt(provider, input, { timeoutMs })`, or
`submitAnchor(provider, entry, { timeoutMs })`. `submitCertifiedReceipt` forwards
`submissionOpts: { timeoutMs }` to its receipt submission. Existing polling
options retain their independent budgets. Legacy `timeout` and `retries` config
fields remain unused. Budgets must be positive, finite, and at most 2147483647 ms.

The submission budget includes receipt signing, dry-run, watching, confirmation,
and recovery. The last `min(30000, timeoutMs / 2)` milliseconds are reserved for
recovery, so a silent watch ends before the total budget. A disconnect ends the
watch immediately. Recovery opens an isolated connection to the same RPC URL,
checks its genesis hash, and reads the content-addressed record at a pinned block.
It never broadcasts a replacement transaction. Anchor recovery requires finalized
storage; receipt recovery, like normal receipt inclusion, does not promise finality.

| Error | Code | Retry contract |
| --- | --- | --- |
| `MateriosConnectionError` | `connect-timeout` / `connect-failed` | No submission was attempted by `connect`; retry connection. Includes `timeoutMs`. |
| `MateriosSubmissionError` | `not-landed` | `safeToResubmit === true`: preparation failed or timed out before broadcasting. |
| `MateriosSubmissionError` | `inclusion-unknown` | `safeToResubmit === false`: inspect storage and transaction state before resubmitting. |
| `MateriosSubmissionError` | `dispatch` | `safeToResubmit === false`: fix the reported dispatch or validity failure before deciding to retry. |

Submission errors include `id` (receipt or anchor ID). An empty storage read after
a dropped watch is **inclusion-unknown**: the transaction can still be pending in
a node's pool and land later. Unreadable storage, mismatched content, and a stalled
recovery connection also produce this error. A timed-out `signAndSend` may still
complete signing later; its outcome is unknown, never safe to blindly retry.

Normal successful results are unchanged. Recovery returns `reconciled: true` only
when storage matches the submitted payload. In that result, `blockHash` (and the
receipt's `blockNumber`) identifies the block where storage was observed, **not
necessarily the transaction's inclusion block**. A receipt's `txHash` identifies
the attempted transaction; the matching receipt may have been submitted earlier.
The certified-receipt orchestrator preserves `reconciled`.

SDK deadline timers and disconnect listeners are removed on every settled path.
Watch handles are unsubscribed, including handles delivered after settlement;
temporary recovery connections are closed. The caller still owns the original
provider and should call `disconnect()` when finished.

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

No API key needed. Requires a funded Materios account (minimum 1 MATRA at 6 decimals; the live faucet drips 1000 MATRA, well above the threshold). Uploads are signed with sr25519:

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

Every request is signed afresh, twice under one timestamp (`x-upload-ts`):

- `x-upload-sig-v2` over `materios-upload-v2|{METHOD}|{path}|{sha256 of the body bytes}|{contentHash}|{uploaderAddress}|{timestamp}`,
  where `path` is the path appended to `baseUrl` (e.g. `/blobs/<contentHash>/chunks/0`);
- `x-upload-sig` over `materios-upload-v1|{contentHash}|{uploaderAddress}|{timestamp}`,
  for gateways that predate v2.

The gateway accepts each signature once, so a captured request cannot be
replayed, and v2 means it cannot be resent with a different body.

## Configuration

### MateriosProvider

| Parameter    | Type     | Required | Description                                      |
|-------------|----------|----------|--------------------------------------------------|
| `rpcUrl`    | `string` | Yes      | WebSocket RPC URL (e.g. `ws://node:9945`)        |
| `signerUri` | `string` | Yes      | Signer URI (`//Alice` for dev, or seed phrase)   |
| `connectTimeoutMs` | `number` | No | Connection budget, default 30000 ms |
| `inclusionTimeoutMs` | `number` | No | Total submission budget, default 120000 ms |
| `timeout` | `number` | No | Legacy, unused |
| `retries` | `number` | No | Legacy, unused |

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
