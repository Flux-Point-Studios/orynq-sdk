# @fluxpointstudios/orynq-sdk-anchors-materios

## 0.7.0

### Minor Changes

- 14bb540: `verifyMerkleProof(leaf, proof, root, leafCount)` requires the tree's leaf count
  from an authenticated source and the leaf's `index`, which
  `merkleInclusionProof` now returns in the proof. The siblings must follow
  exactly the path for that index in a tree of that many leaves, so the root or an
  internal node no longer passes as a leaf, except the root of a one-leaf tree.
  Every hash must be lowercase SHA-256 hex, with or without `0x`, and malformed
  input returns false instead of throwing. anchors-materios re-exports both
  functions.
- 655c2df: Bound connection readiness and receipt/anchor submission with optional timeouts, and make the retry contract exact. A node refusal (1010/1011/1014) or a failure before broadcast is `not-landed`, keeping the node's message verbatim and the original error as `cause`; anchors are now signed before they are sent. The pool alone judges validity: a dry-run applies on the best block's own state and reported `exhaustsResources` whenever the runtime filled that block with mandatory weight, so its validity verdict no longer stops a receipt. After a lost watch, storage is re-read once per block until the deadline before reporting `inclusion-unknown`, which carries the transaction hash, signer, nonce, mortality end, last head read and cause. The new `resolveInclusion()` settles such an error from finalized storage as `landed` or `not-landed`. A stored record with the same payload is success (`reconciled: true`) and is checked before broadcasting, so a retry never pays for a duplicate. `waitForCertification` survives a dropped or stalled connection within its budget, and `submitCertifiedReceipt` reports a failed wait after the receipt landed as `MateriosCertificationError` carrying the submit result. An unresponsive connection is replaced before the next submission, `disconnect()` aborts a pending `connect()` without rethrowing, and connection errors keep their cause.

  **Migration (breaking):** a pool refusal now rejects with a `MateriosSubmissionError` whose `err.code` is the string `"not-landed"`. The node's numeric code (e.g. `1014`) moved to `err.cause.code`, and `err.message` still carries the node's text verbatim. Callers that test `err.code === 1014` must switch to `err.message` or `err.cause.code`, or to `err.safeToResubmit`. Keepers should follow the retry contract in the README:

  - `not-landed`: resubmit with the same id.
  - `inclusion-unknown`: call `resolveInclusion`.
  - `dispatch`: fix the cause.
  - `MateriosCertificationError`: never resubmit.

### Patch Changes

- Updated dependencies [14bb540]
  - @fluxpointstudios/orynq-sdk-core@0.4.0

## 0.6.2

### Patch Changes

- `submitCertifiedReceipt` now submits a blob receipt's base root as the Merkle root of the uploaded chunk hashes. A blob receipt is one with no `schemaHash`, or an all-zero one. That Merkle root is the only root the certifying committee accepts for a blob. Two cases were never certified before: a caller passing its trace's own root, as the README example and the orynq-mcp submit tool do, and content over 256 KiB with the default root. Receipt classes named by a `schemaHash` keep the root they pass.

## 0.6.1

### Patch Changes

- Share receipt checkpoint primitives between the SDK and hosted anchoring: strict SCALE receipt decoding, certificate format detection, deterministic census batches, shape-bound Merkle paths and bounded member snapshots. Materios uses the shared Merkle implementation from `@fluxpointstudios/orynq-sdk-core`.

## 0.6.0

### Minor Changes

- 41f315b: Signed blob uploads (`signerKeypair`) now carry a `materios-upload-v2` signature (`x-upload-sig-v2`) under `x-upload-ts`, in place of the v1 `x-upload-sig`. v2 covers the HTTP method, the request path and the SHA-256 of the exact body bytes, so a captured upload can no longer be resent with a different body. The Materios gateway accepts each signature once, and every request is signed afresh. v1 is no longer sent because it covers only the content hash, so a copy lifted from a request could carry any body. This version needs a gateway that verifies v2; the Materios preprod gateway does. No public API changes.

## 0.5.0

### Minor Changes

- 3cd6027: Expose canonical CBOR helpers + `AiCapabilityObservationV1` type for downstream observe SDK. New named exports from the package entry point:

  - `canonicalCborPreImageAiCapabilityObservationV1`
  - `canonicalContentHashAiCapabilityObservationV1`
  - `validateAiCapabilityObservationV1`
  - `AI_CAPABILITY_OBSERVATION_V1_SCHEMA_HASH_HEX`
  - `AI_CAPABILITY_OBSERVATION_V1_SCHEMA_VERSION`
  - `AI_CAPABILITY_OBSERVATION_V1_MAX_CONTEXT_LEN`
  - `SEVERITIES`, `TEE_TIERS`
  - types: `AiCapabilityObservationV1`, `ModelV1`, `CapabilityV1`, `ObservationV1`, `TeeAttestationV1`, `ObserverV1`, `TeeTier`, `Severity`

  Additive — no existing API is removed or renamed.

## 0.3.2 (2026-05-12)

### Data-integrity fix — **upgrade required, 0.3.1 deprecated**

- **`submitReceipt` positional args now match live runtime metadata.** Prior
  to this release the SDK passed `schemaHash` in the wrong positional slot.
  Against the current Materios preprod runtime (which added `Option<>`
  wrappers and reordered fields in `OrinqReceipts::submit_receipt_v2`), the
  result was that **every receipt landed on chain with `schema_hash =
0x00…00`** (the legacy zero-bytes value) AND `base_root_sha256` decoded
  into the wrong slot, so cert-daemons rejected the receipt with
  `Merkle root mismatch` and the receipt could never be certified. No
  exception was raised by the SDK — the on-chain transaction succeeded.
  The corruption was silent.

  This is the recurrence of the SDK↔runtime arg-drift bug originally fixed
  in materios `pallet-orinq-receipts` task #115; the runtime evolved (added
  `Option<>` slots), so the SDK side needed re-alignment.

  **Impact:** every receipt submitted via 0.3.1 (or any earlier 0.3.x)
  against current preprod was silently broken. Receipts already on chain
  are unrecoverable — they are committed with the wrong `schema_hash` and
  `base_root_sha256` slots. New submissions on 0.3.2 will be correct.

  Live-evidence: 8 such receipts on preprod 2026-05-12 from our own internal
  trace-anchor pipeline (gemtek drain importing a pre-rebuild dist/), all
  rejected by all 3 internal cert-daemons within the same hour.

  **0.3.1 has been deprecated on npm with a pointer to this release.**

  Implementation: positional args are now pinned against
  `api.tx.orinqReceipts.submitReceipt.meta` at SDK call time; `null` is
  passed for `Option<>` slots the caller does not populate. See commit
  `d0f2ac4 fix(anchors-materios): align submitReceipt args with live
runtime metadata` (PR #40).

### Changes (carried over from unreleased prior to cut)

- **feat:** `ReceiptInput.schemaHash` (optional 32-byte hex). When set, threads
  the discriminator through to the on-chain `submit_receipt_v2` extrinsic
  instead of hardcoding the legacy zero-bytes value. Required for receipt
  classes whose `base_root_sha256` is a semantic root rather than the
  chunk-Merkle (`compute_metering_v2`, `compute_metering_v2_1`,
  `orynq_trace_v1`). Omitting the field preserves the prior on-chain
  behaviour (legacy / chunk-Merkle dispatch). Paired with operator-kit
  PRs #18 / #19 / #20 (cert-daemon schema-aware verifier).

### Behaviour changes

- **`submitCertifiedReceipt` now honors a caller-supplied `input.receiptId`
  consistently between the blob-storage path and the on-chain submit.**
  Prior to this release, `prepareBlobData` was always called with a derived
  `receiptId = sha256(contentHash)` even if the caller passed
  `input.receiptId`, while the on-chain submit used the caller-supplied
  value. The two could diverge — the gateway stored the manifest under the
  derived id, the chain recorded the caller's id, cert-daemon's manifest
  lookup (keyed by on-chain receiptId) then failed. Now both paths use the
  same `effectiveReceiptId` (caller-supplied if present, derived otherwise).
  No-op for callers that didn't pass `input.receiptId` (most of them); the
  bug only surfaced when callers explicitly overrode `receiptId`.

### Validation

- **Hex-format guards at the SDK boundary.** `contentHash`, `rootHash`,
  `manifestHash`, and `schemaHash` are now validated as exactly 32 hex
  bytes (64 chars, with optional `0x` prefix) before the extrinsic is
  built. Throws an explicit `Error` with the field name. Previously these
  flowed through `toBytes32` which silently padded short input and
  silently truncated long input — both producing a different on-chain
  value than the caller intended. The schemaHash guard already shipped
  in 0.3.x; this release extends the same check to the other three fields.

## 0.3.x

(earlier releases — see git history)
