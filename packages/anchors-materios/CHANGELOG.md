# @fluxpointstudios/orynq-sdk-anchors-materios

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
