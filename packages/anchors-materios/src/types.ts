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
