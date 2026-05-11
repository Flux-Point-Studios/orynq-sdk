# @fluxpointstudios/orynq-sdk-anchors-materios

## Unreleased

### Changes

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
