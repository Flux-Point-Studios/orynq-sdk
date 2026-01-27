/**
 * @summary Protocol-neutral payment request and proof types for dual-protocol commerce.
 *
 * This file defines the core payment primitives used across both Flux and x402 protocols.
 * All monetary amounts are represented as strings to prevent JavaScript precision issues
 * with large numbers (beyond Number.MAX_SAFE_INTEGER).
 *
 * Used by:
 * - Payer implementations to process payment requests
 * - API middleware to parse and validate payment headers
 * - Budget tracking to record and verify payments
 */

// ---------------------------------------------------------------------------
// Chain Identifier
// ---------------------------------------------------------------------------

/**
 * CAIP-2 chain identifier - the canonical internal format for chain references.
 *
 * @example "eip155:8453" (Base mainnet)
 * @example "eip155:84532" (Base Sepolia)
 * @example "cardano:mainnet"
 * @example "cardano:preprod"
 *
 * @see https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md
 */
export type ChainId = string;

// ---------------------------------------------------------------------------
// Payment Request
// ---------------------------------------------------------------------------

/**
 * Split payment output configuration.
 * Defines a single recipient in a multi-output payment.
 */
export interface SplitOutput {
  /** Optional role identifier for this split (e.g., "platform", "creator", "referrer") */
  role?: string;
  /** Recipient address in chain-native format */
  to: string;
  /** Asset identifier; defaults to the main request asset if omitted */
  asset?: string;
  /** Amount in atomic units as STRING (never number!) */
  amountUnits: string;
}

/**
 * Split payment configuration for multi-output transactions.
 */
export interface PaymentSplits {
  /**
   * Split mode determines how split amounts relate to the main amountUnits:
   * - "inclusive": splits are subtracted from amountUnits (total paid = amountUnits)
   * - "additional": splits are added on top of amountUnits (total paid = amountUnits + sum(splits))
   */
  mode: "inclusive" | "additional";
  /** Array of output configurations */
  outputs: SplitOutput[];
}

/**
 * Facilitator information for delegated payment processing.
 */
export interface PaymentFacilitator {
  /** Provider identifier (e.g., "flux", "coinbase", "custom") */
  provider: string;
  /** Optional facilitator API URL */
  url?: string;
}

/**
 * Unified payment request structure supporting both Flux and x402 protocols.
 *
 * CRITICAL: All amounts are strings to prevent JavaScript precision issues.
 * JavaScript numbers lose precision above 2^53-1 (9,007,199,254,740,991),
 * which is easily exceeded by atomic units (e.g., 1 ADA = 1,000,000 lovelace).
 */
export interface PaymentRequest {
  /** Protocol identifier */
  protocol: "flux" | "x402";

  /** Protocol version (optional, defaults to latest) */
  version?: string;

  /**
   * Unique invoice identifier for idempotency and tracking.
   * Used to prevent duplicate payments for the same request.
   */
  invoiceId?: string;

  /** CAIP-2 chain identifier */
  chain: ChainId;

  /**
   * Asset identifier:
   * - Native assets: "ADA", "ETH", etc.
   * - ERC-20/CIP-68: contract address or policy.assetHex
   * - Special: "USDC" resolves to chain-specific contract
   */
  asset: string;

  /**
   * Payment amount in atomic/smallest units as STRING.
   * Examples:
   * - ADA: lovelace (1 ADA = "1000000")
   * - ETH: wei (1 ETH = "1000000000000000000")
   * - USDC: 6 decimals (1 USDC = "1000000")
   */
  amountUnits: string;

  /** Number of decimal places for display purposes */
  decimals?: number;

  /** Primary recipient address in chain-native format */
  payTo: string;

  /** Payment timeout in seconds from request creation */
  timeoutSeconds?: number;

  /** Split payment configuration for multi-output transactions */
  splits?: PaymentSplits;

  /** Partner/referrer identifier for attribution */
  partner?: string;

  /** Facilitator for delegated payment processing */
  facilitator?: PaymentFacilitator;

  /**
   * Raw protocol-specific data for advanced use cases.
   * Contains the original header/payload before normalization.
   */
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Payment Proof
// ---------------------------------------------------------------------------

/**
 * Cardano transaction hash proof.
 * Used after transaction is submitted to the network.
 */
export interface CardanoTxHashProof {
  kind: "cardano-txhash";
  /** 64-character hex-encoded transaction hash */
  txHash: string;
}

/**
 * Cardano signed CBOR proof.
 * Used for pre-submission verification or offline signing flows.
 */
export interface CardanoSignedCborProof {
  kind: "cardano-signed-cbor";
  /** Hex-encoded CBOR of the signed transaction */
  cborHex: string;
}

/**
 * EVM transaction hash proof.
 * Used after transaction is submitted to the network.
 */
export interface EvmTxHashProof {
  kind: "evm-txhash";
  /** 66-character hex-encoded transaction hash (0x prefix) */
  txHash: string;
}

/**
 * x402 signature-based proof.
 * Used for cryptographic proof without on-chain transaction.
 */
export interface X402SignatureProof {
  kind: "x402-signature";
  /** Cryptographic signature proving payment authorization */
  signature: string;
  /** Optional payload that was signed */
  payload?: string;
}

/**
 * Union type of all supported payment proof kinds.
 * Discriminated union on the "kind" field.
 */
export type PaymentProof =
  | CardanoTxHashProof
  | CardanoSignedCborProof
  | EvmTxHashProof
  | X402SignatureProof;

// ---------------------------------------------------------------------------
// Payment Attempt
// ---------------------------------------------------------------------------

/**
 * A complete payment attempt including request, proof, and idempotency key.
 * Used for submission to payment verification endpoints.
 */
export interface PaymentAttempt {
  /** The original payment request */
  request: PaymentRequest;
  /** Proof of payment (transaction hash, signature, etc.) */
  proof: PaymentProof;
  /**
   * Idempotency key for duplicate detection.
   * Typically derived from hash of (method, url, body).
   */
  idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// Payment Status
// ---------------------------------------------------------------------------

/**
 * Status of a payment through its lifecycle.
 */
export type PaymentStatusValue =
  | "pending" // Payment initiated but not yet submitted
  | "submitted" // Transaction submitted to network
  | "confirmed" // Transaction confirmed on-chain
  | "consumed" // Payment has been used/claimed
  | "expired" // Payment timeout exceeded
  | "failed"; // Payment failed (see error field)

/**
 * Payment status response from verification endpoints.
 */
export interface PaymentStatus {
  /** Invoice identifier for the payment */
  invoiceId: string;
  /** Current status of the payment */
  status: PaymentStatusValue;
  /** Transaction hash if submitted */
  txHash?: string;
  /** Error message if failed */
  error?: string;
  /** ISO 8601 timestamp when payment was settled */
  settledAt?: string;
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Type guard to check if a proof is a Cardano transaction hash.
 */
export function isCardanoTxHashProof(
  proof: PaymentProof
): proof is CardanoTxHashProof {
  return proof.kind === "cardano-txhash";
}

/**
 * Type guard to check if a proof is Cardano signed CBOR.
 */
export function isCardanoSignedCborProof(
  proof: PaymentProof
): proof is CardanoSignedCborProof {
  return proof.kind === "cardano-signed-cbor";
}

/**
 * Type guard to check if a proof is an EVM transaction hash.
 */
export function isEvmTxHashProof(proof: PaymentProof): proof is EvmTxHashProof {
  return proof.kind === "evm-txhash";
}

/**
 * Type guard to check if a proof is an x402 signature.
 */
export function isX402SignatureProof(
  proof: PaymentProof
): proof is X402SignatureProof {
  return proof.kind === "x402-signature";
}

/**
 * Type guard to check if a proof is for Cardano (either kind).
 */
export function isCardanoProof(
  proof: PaymentProof
): proof is CardanoTxHashProof | CardanoSignedCborProof {
  return proof.kind === "cardano-txhash" || proof.kind === "cardano-signed-cbor";
}

/**
 * Type guard to check if a proof is for EVM chains.
 */
export function isEvmProof(
  proof: PaymentProof
): proof is EvmTxHashProof | X402SignatureProof {
  return proof.kind === "evm-txhash" || proof.kind === "x402-signature";
}
