/**
 * @fluxpointstudios/orynq-sdk-anchors-materios
 *
 * Materios blockchain support for the Proof-of-Intent SDK.
 *
 * Provides the full lifecycle for anchoring data on the Materios chain:
 *   1. Submit a receipt  →  submitReceipt()
 *   2. Wait for cert     →  waitForCertification()
 *   3. Wait for anchor   →  waitForAnchor()
 *   4. Verify on-chain   →  verifyReceipt()
 *
 * Also supports direct anchor submission via submitAnchor() for
 * infrastructure services (cert daemon checkpoint workers).
 *
 * @example
 * ```ts
 * import {
 *   MateriosProvider,
 *   submitReceipt,
 *   waitForCertification,
 *   waitForAnchor,
 *   verifyReceipt,
 * } from "@fluxpointstudios/orynq-sdk-anchors-materios";
 *
 * const provider = new MateriosProvider({ rpcUrl, signerUri: "//Alice" });
 * await provider.connect();
 *
 * const result = await submitReceipt(provider, { contentHash, rootHash, manifestHash });
 * const cert   = await waitForCertification(provider, result.receiptId);
 * const anchor = await waitForAnchor(provider, cert);
 * const verify = await verifyReceipt(provider, result.receiptId);
 *
 * console.log(verify.status); // "FULLY_VERIFIED"
 * ```
 */

// Provider
export { MateriosProvider } from "./provider.js";

// Anchor submission (infrastructure)
export { submitAnchor } from "./submitter.js";

// Anchor querying
export { getAnchor, anchorExists } from "./verifier.js";

// Receipt submission and querying
export { submitReceipt, getReceipt, isCertified, prepareBlobData } from "./receipt.js";

// Polling / waiting
export { waitForCertification, waitForAnchor, computeCheckpointLeaf } from "./polling.js";

// Verification
export { verifyReceipt } from "./verify.js";

// Hex utilities
export { stripPrefix, ensureHex, zeroHash, isZeroHash } from "./hex.js";

// Types
export type {
  // Anchor types
  AnchorEntry,
  MateriosAnchorConfig,
  MateriosAnchorResult,
  AnchorRecord,
  // Receipt types
  ReceiptInput,
  ReceiptSubmitResult,
  ReceiptRecord,
  BlobManifest,
  // Polling types
  PollOptions,
  CertificationResult,
  AnchorMatchResult,
  // Verification types
  VerificationStatus,
  VerifyStep,
  VerifyResult,
} from "./types.js";
