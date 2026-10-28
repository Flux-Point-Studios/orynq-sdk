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

The submission budget covers every step below. The last `min(30000, timeoutMs / 2)`
milliseconds are reserved for recovery, so a silent watch ends before the total budget.

1. **Connection.** The provider's connection is replaced first if an earlier read or
   watch on it timed out, and awaited while it reconnects on its own.
2. **Signing.** Receipts and anchors are signed with `signAsync` before anything is
   sent, so a failure here never broadcasts.
3. **Storage check.** The record at the id is read: receipts at the best block,
   anchors at the finalized block. A record with the same payload returns success
   (`reconciled: true`) without broadcasting; a different payload is `dispatch`.
4. **Dry-run** (receipts only), when the node allows `system_dryRun`. A dispatch error it
   predicts stops the broadcast (`ReceiptAlreadyExists` with the same payload is
   success). Validity is left to the pool: the dry-run applies on the best block's own
   state, so it reports `exhaustsResources` whenever the runtime fills that block with
   mandatory weight, for a transaction the next block accepts.
5. **Broadcast and watch** until inclusion: a best block for receipts, a finalized
   block for anchors.
6. **Recovery** after a lost watch (disconnect, watch timeout, or a pool report of
   dropped, invalid, usurped or finality timeout): an isolated connection to the same
   RPC URL, checked against the genesis hash, re-reads storage once per new block
   until the deadline, best blocks for receipts and finalized blocks for anchors. It
   never broadcasts a replacement transaction.

### Retry contract

| Error | Code | Meaning | What to do |
| --- | --- | --- | --- |
| `MateriosSubmissionError` | `not-landed` | Nothing from this call was broadcast, or the node refused it: `1010` (invalid, e.g. cannot pay fees), `1011` (unknown validity) or `1014` (priority too low, e.g. another transaction holds the signer's nonce). `safeToResubmit === true`. | Resubmit with the **same** receipt or anchor id. |
| `MateriosSubmissionError` | `inclusion-unknown` | The transaction may have reached a node and may still land. `safeToResubmit === false`. | Settle it with `resolveInclusion(provider, error)`. Never treat one absent read as "did not land". |
| `MateriosSubmissionError` | `dispatch` | The runtime rejects the call (in the dry-run or in its block), or the id holds a different payload. `safeToResubmit === false`. | Fix the cause; resubmitting unchanged fails the same way. |
| `MateriosCertificationError` | | `submitCertifiedReceipt` stored the receipt, then waiting for certification or its anchor failed. `result` carries the submission result, `stage` says which wait failed. | Never resubmit; wait again with `waitForCertification`. |
| `MateriosConnectionError` | `connect-timeout` / `connect-failed` / `connect-aborted` / `read-timeout` | The connection did not open in time, failed (`cause` keeps the underlying error), was aborted by `disconnect()`, or a read stalled. Includes `timeoutMs`. | Retry the connection or the read. |

- A node refusal keeps the node's message verbatim (`1014: Priority is too low: ...`),
  so `/^1014: Priority is too low/` matchers keep working; `cause` is the original
  error. Every error built from an underlying failure keeps it as `cause`.
- "Already exists" with the same stored payload is success, for receipts and anchors,
  whoever stored it. Never retry with a fresh id: that can store the content twice.
- Submission errors carry `id` and, once the extrinsic is signed, `txHash`, `signer`,
  `nonce` and `mortalityEnd` (the last block number that can include it, or `null`
  for an immortal extrinsic). `inclusion-unknown` adds `lastHead`, the last block whose
  storage was read without finding the record, and `cause`, why the watch was lost.

### Settling an unknown inclusion

```ts
import {
  MateriosSubmissionError, resolveInclusion, submitReceipt, type ReceiptInput,
} from "@fluxpointstudios/orynq-sdk-anchors-materios";

/** The receipt id once `input` is on chain; rethrows what resubmitting cannot fix. */
async function landReceipt(input: ReceiptInput, attempts = 5): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await submitReceipt(provider, input)).receiptId;
    } catch (error) {
      if (!(error instanceof MateriosSubmissionError) || error.code === "dispatch" || attempt === attempts) throw error;
      if (error.code === "inclusion-unknown") {
        const resolution = await resolveInclusion(provider, error); // waits on finalized storage
        if (resolution.status === "landed") return resolution.id;
      }
      // not-landed: resubmit the same input, so the same receipt id, after a backoff
      await new Promise(resolve => setTimeout(resolve, 1_500 * attempt));
    }
  }
}
```

`resolveInclusion` polls finalized storage (`intervalMs` default `6000`, `timeoutMs`
default `600000`). It resolves `landed` once a finalized block holds the matching
record, and `not-landed` only once a finalized block without it is past the
extrinsic's `mortalityEnd` (`reason: "expired"`) or shows the signer's nonce above the
extrinsic's nonce (`reason: "nonce-consumed"`). A different stored payload rejects
with `dispatch`; no settlement by `timeoutMs` rejects with `inclusion-unknown` again.

### Results

Normal successful results are unchanged. `reconciled: true` marks a result proved
from storage rather than from the watch. Its `blockHash` (and a receipt's
`blockNumber`) is the block where storage was observed, **not necessarily the
transaction's inclusion block**. A receipt's `txHash` is the transaction this call
broadcast; it is absent when the storage check found the receipt before
broadcasting. The certified-receipt orchestrator preserves `reconciled`.

`waitForCertification` waits for a dropped connection to reconnect and replaces one
whose read stalls for 10 seconds, within its own budget; its timeout error keeps the
last failed read as `cause`.

SDK timers and listeners are removed on every settled path. Watch handles are
unsubscribed, including handles delivered after settlement; temporary connections
are closed. `disconnect()` aborts a `connect()` in flight, whose caller receives
`connect-aborted`. The caller still owns the provider and should call `disconnect()`
when finished.

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
| `submitReceipt(provider, input, opts?)` | Submit a receipt on-chain. Includes storage and dry-run pre-flight checks. |
| `resolveInclusion(provider, error, opts?)` | Settle an `inclusion-unknown` receipt or anchor from finalized storage. |
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
| `verifyMerkleProof(leaf, proof, root, leafCount)` | Verify that `leaf` is the leaf at `proof.index` of the tree of `leafCount` leaves under `root`; take the leaf count from an authenticated source. |

### Infrastructure

| Function                           | Description                                          |
|-----------------------------------|------------------------------------------------------|
| `submitAnchor(provider, entry, opts?)` | Submit an anchor (used by checkpoint workers).   |
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
