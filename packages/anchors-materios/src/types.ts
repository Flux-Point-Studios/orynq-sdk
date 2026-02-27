/**
 * Type definitions for Materios blockchain anchoring.
 *
 * Unlike Cardano (which uses tx metadata label 2222), Materios uses
 * Substrate extrinsics directly — no metadata labels.
 */

/** Reuse the AnchorEntry type from the anchors-cardano package for API compatibility */
export interface AnchorEntry {
  type: "process-trace" | "proof-of-intent" | "custom";
  version: "1.0";
  rootHash: string;
  manifestHash: string;
  merkleRoot?: string;
  itemCount?: number;
  timestamp: string;
  agentId?: string;
  storageUri?: string;
}

/** Configuration for the Materios anchor provider */
export interface MateriosAnchorConfig {
  /** WebSocket RPC URL for Materios node */
  rpcUrl: string;
  /** Signer URI (e.g. "//Alice" for dev, or seed phrase) */
  signerUri: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Number of retry attempts */
  retries?: number;
}

/** Result of anchor submission to Materios */
export interface MateriosAnchorResult {
  /** Block hash containing the anchor extrinsic */
  blockHash: string;
  /** Extrinsic index within the block */
  extrinsicIndex?: number;
  /** Anchor ID (H256 key in storage) */
  anchorId: string;
  /** Content hash */
  contentHash: string;
  /** Root hash */
  rootHash: string;
  /** Manifest hash */
  manifestHash: string;
}

/** On-chain anchor record */
export interface AnchorRecord {
  anchorId: string;
  contentHash: string;
  rootHash: string;
  manifestHash: string;
  submitter: string;
  blockNumber: number;
}

// ---------------------------------------------------------------------------
// Receipt types
// ---------------------------------------------------------------------------

/** Input for submitting a receipt to the Materios chain. */
export interface ReceiptInput {
  /** SHA-256 content hash of the data being anchored */
  contentHash: string;
  /** Base root hash (SHA-256 Merkle root of the data tree) */
  rootHash: string;
  /** Manifest hash describing the data layout */
  manifestHash: string;
  /** Optional pre-computed receipt ID. If omitted, derived from contentHash. */
  receiptId?: string;
}

/** Result of a receipt submission. */
export interface ReceiptSubmitResult {
  /** Receipt ID (H256) stored on-chain */
  receiptId: string;
  /** Block hash containing the extrinsic */
  blockHash: string;
  /** Block number */
  blockNumber: number;
}

/** On-chain receipt record. */
export interface ReceiptRecord {
  receiptId: string;
  contentHash: string;
  /** Zero hash if not yet certified */
  availabilityCertHash: string;
  submitter: string;
}

// ---------------------------------------------------------------------------
// Polling types
// ---------------------------------------------------------------------------

/** Options for polling functions. */
export interface PollOptions {
  /** Polling interval in ms (default: 6000 — ~1 Substrate block) */
  intervalMs?: number;
  /** Maximum wait time in ms (default: 600000 — 10 minutes) */
  timeoutMs?: number;
  /** Called on each poll attempt */
  onPoll?: (attempt: number, elapsed: number) => void;
}

/** Result after certification is confirmed. */
export interface CertificationResult {
  receiptId: string;
  /** The availability cert hash set by the attester committee */
  certHash: string;
  /** SHA-256 checkpoint leaf = H("materios-checkpoint-v1" || chainId || receiptId || certHash) */
  leafHash: string;
  /** Genesis hash of the chain */
  chainId: string;
}

/** Result when an anchor matching the receipt's leaf is found. */
export interface AnchorMatchResult {
  /** Anchor ID (H256) */
  anchorId: string;
  /** Merkle root stored in the anchor */
  rootHash: string;
  /** Block hash containing the anchor */
  blockHash: string;
  /** True if rootHash === leafHash (single-leaf batch) */
  exactMatch: boolean;
}

// ---------------------------------------------------------------------------
// Verification types
// ---------------------------------------------------------------------------

/** Verification status for a receipt's chain of custody. */
export type VerificationStatus =
  | "FULLY_VERIFIED"
  | "PARTIALLY_VERIFIED"
  | "NOT_VERIFIED";

/** One step in the verification pipeline. */
export interface VerifyStep {
  step: number;
  title: string;
  passed: boolean;
  details: Record<string, string>;
}

/** Full verification result. */
export interface VerifyResult {
  status: VerificationStatus;
  receipt: ReceiptRecord | null;
  certHash: string | null;
  leafHash: string | null;
  anchor: AnchorMatchResult | null;
  chainId: string;
  steps: VerifyStep[];
}

// ---------------------------------------------------------------------------
// Blob provisioning types
// ---------------------------------------------------------------------------

/** Manifest for blob data stored alongside a receipt. */
export interface BlobManifest {
  receipt_id: string;
  content_hash: string;
  total_size: number;
  chunk_count: number;
  chunks: Array<{
    index: number;
    sha256: string;
    size: number;
    path: string;
    url?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Merkle types
// ---------------------------------------------------------------------------

export interface MerkleProofSibling {
  hash: string;
  position: "L" | "R";
}

export interface MerkleProof {
  siblings: MerkleProofSibling[];
}

// ---------------------------------------------------------------------------
// Certification status types
// ---------------------------------------------------------------------------

export type CertificationStatusCode =
  | "RECEIPT_NOT_FOUND"
  | "PENDING_NO_BLOBS"
  | "PENDING_VERIFICATION"
  | "CERTIFIED";

export interface CertificationStatusResult {
  receiptId: string;
  status: CertificationStatusCode;
  certHash?: string;
  blobsUploaded?: boolean;
  details?: string;
}

// ---------------------------------------------------------------------------
// Blob gateway types
// ---------------------------------------------------------------------------

export interface BlobGatewayConfig {
  baseUrl: string;
  apiKey?: string;
}

export interface BlobUploadResult {
  success: boolean;
  storageLocatorHash?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Batch metadata types (off-chain, via blob gateway)
// ---------------------------------------------------------------------------

export interface BatchMetadata {
  anchorId: string;
  rootHash: string;
  leafCount: number;
  leafHashes: string[];
  blockRangeStart: number;
  blockRangeEnd: number;
  submitter: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Certified receipt types
// ---------------------------------------------------------------------------

export interface CertifiedReceiptOptions {
  blobGateway: BlobGatewayConfig;
  waitForAnchor?: boolean;
  certificationPollOpts?: PollOptions;
  anchorPollOpts?: PollOptions & { scanWindow?: number };
}

export interface CertifiedReceiptResult {
  receiptId: string;
  blockHash: string;
  blockNumber: number;
  certHash?: string;
  leafHash?: string;
  anchor?: AnchorMatchResult;
}
