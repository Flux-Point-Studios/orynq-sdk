/**
 * @fluxpointstudios/orynq-sdk-anchors-materios
 *
 * Materios blockchain support for the Orynq SDK.
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
export { submitReceipt, getReceipt, isCertified, prepareBlobData, queryMotraBalance, uploadBlobs, submitCertifiedReceipt } from "./receipt.js";

// Polling / waiting
export { waitForCertification, waitForAnchor, computeCheckpointLeaf, waitForMotra, getCertificationStatus } from "./polling.js";

// Verification
export { verifyReceipt } from "./verify.js";

// Hex utilities
export { stripPrefix, ensureHex, zeroHash, isZeroHash } from "./hex.js";

// Merkle tree utilities
export { merkleRoot, merkleInclusionProof, verifyMerkleProof } from "./merkle.js";

// Schemas — canonical encoders + validators for receipt-class semantic roots.
// Discriminator hash `SCHEMA_HASH_HEX` is the value caller passes as
// `schemaHash` to `submitReceipt` for the matching receipt class.
export {
  SCHEMA_VERSION as AI_CAPABILITY_OBSERVATION_V1_SCHEMA_VERSION,
  SCHEMA_HASH_HEX as AI_CAPABILITY_OBSERVATION_V1_SCHEMA_HASH_HEX,
  TEE_TIERS,
  SEVERITIES,
  MAX_CONTEXT_LEN as AI_CAPABILITY_OBSERVATION_V1_MAX_CONTEXT_LEN,
  canonicalCborPreImage as canonicalCborPreImageAiCapabilityObservationV1,
  canonicalContentHash as canonicalContentHashAiCapabilityObservationV1,
  validateAiCapabilityObservationV1,
} from "./schemas/ai_capability_observation_v1.js";
export type {
  AiCapabilityObservationV1,
  ModelV1,
  CapabilityV1,
  ObservationV1,
  TeeAttestationV1,
  ObserverV1,
  TeeTier,
  Severity,
} from "./schemas/ai_capability_observation_v1.js";

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
  // Merkle types
  MerkleProof,
  MerkleProofSibling,
  // Certification status types
  CertificationStatusCode,
  CertificationStatusResult,
  // Blob gateway types
  BlobGatewayConfig,
  BlobUploadResult,
  // Batch metadata types
  BatchMetadata,
  // Certified receipt types
  CertifiedReceiptOptions,
  CertifiedReceiptResult,
} from "./types.js";
