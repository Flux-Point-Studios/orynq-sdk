/**
 * @summary Chain verifier interface for payment proof verification.
 *
 * This file defines the ChainVerifier interface that all blockchain-specific
 * verifiers must implement. Verifiers are responsible for confirming that
 * payment proofs (transaction hashes, signatures, etc.) represent valid
 * payments with the expected amount and recipient.
 *
 * Used by:
 * - Express middleware (express.ts) to verify incoming payment proofs
 * - Fastify plugin (fastify.ts) to verify incoming payment proofs
 * - CardanoVerifier for Cardano blockchain verification
 * - EvmVerifier for EVM chain verification
 */

import type { ChainId, PaymentProof } from "@fluxpointstudios/orynq-sdk-core";

// ---------------------------------------------------------------------------
// Verification Result
// ---------------------------------------------------------------------------

/**
 * Result of payment proof verification.
 *
 * Verifiers return this structure to indicate whether a payment proof
 * was successfully verified, along with additional metadata about the
 * verified transaction.
 */
export interface VerificationResult {
  /**
   * Whether the payment was successfully verified.
   * true = payment confirmed with expected amount and recipient
   * false = verification failed (see error field)
   */
  verified: boolean;

  /**
   * Transaction hash of the verified payment.
   * Present when verification succeeded and a transaction was found.
   */
  txHash?: string;

  /**
   * Number of block confirmations for the transaction.
   * Higher values indicate more finality. Useful for determining
   * when it's safe to release goods/services.
   */
  confirmations?: number;

  /**
   * Error message when verification failed.
   * Describes why the payment could not be verified.
   */
  error?: string;

  /**
   * Block number where the transaction was included.
   * Useful for audit trails and dispute resolution.
   */
  blockNumber?: number;

  /**
   * ISO 8601 timestamp when the transaction was confirmed.
   */
  confirmedAt?: string;
}

// ---------------------------------------------------------------------------
// Chain Verifier Interface
// ---------------------------------------------------------------------------

/**
 * Interface for blockchain-specific payment verifiers.
 *
 * Implementations of this interface handle the chain-specific logic
 * for verifying that a payment proof represents a valid payment.
 * Each verifier declares which chains it supports and provides
 * a verify method to check payment proofs.
 *
 * @example
 * ```typescript
 * class MyVerifier implements ChainVerifier {
 *   readonly supportedChains: ChainId[] = ["eip155:1", "eip155:8453"];
 *
 *   async verify(proof, amount, recipient, chain): Promise<VerificationResult> {
 *     // Verify the payment on the blockchain
 *     return { verified: true, txHash: "0x..." };
 *   }
 * }
 * ```
 */
export interface ChainVerifier {
  /**
   * List of CAIP-2 chain IDs this verifier supports.
   *
   * @example ["cardano:mainnet", "cardano:preprod"]
   * @example ["eip155:8453", "eip155:84532"]
   */
  readonly supportedChains: ChainId[];

  /**
   * Verify a payment proof matches the expected payment details.
   *
   * This method should:
   * 1. Validate the proof format is correct
   * 2. Query the blockchain for the transaction
   * 3. Verify the transaction outputs match expected amount and recipient
   * 4. Return verification result with transaction details
   *
   * @param proof - Payment proof to verify (txHash, CBOR, signature, etc.)
   * @param expectedAmount - Expected payment amount in atomic units (as bigint)
   * @param expectedRecipient - Expected recipient address in chain-native format
   * @param chain - CAIP-2 chain identifier where payment should be verified
   * @returns Promise resolving to verification result
   *
   * @example
   * ```typescript
   * const result = await verifier.verify(
   *   { kind: "cardano-txhash", txHash: "abc123..." },
   *   BigInt("1000000"), // 1 ADA in lovelace
   *   "addr1qy...",
   *   "cardano:mainnet"
   * );
   * if (result.verified) {
   *   console.log("Payment confirmed:", result.txHash);
   * }
   * ```
   */
  verify(
    proof: PaymentProof,
    expectedAmount: bigint,
    expectedRecipient: string,
    chain: ChainId
  ): Promise<VerificationResult>;
}

// ---------------------------------------------------------------------------
// Verifier Registry
// ---------------------------------------------------------------------------

/**
 * Find a verifier that supports the given chain from a list of verifiers.
 *
 * @param verifiers - Array of available chain verifiers
 * @param chain - CAIP-2 chain identifier to find a verifier for
 * @returns The first verifier that supports the chain, or undefined
 */
export function findVerifier(
  verifiers: ChainVerifier[],
  chain: ChainId
): ChainVerifier | undefined {
  return verifiers.find((v) => v.supportedChains.includes(chain));
}

/**
 * Check if any verifier in the list supports the given chain.
 *
 * @param verifiers - Array of available chain verifiers
 * @param chain - CAIP-2 chain identifier to check
 * @returns true if at least one verifier supports the chain
 */
export function isChainSupported(
  verifiers: ChainVerifier[],
  chain: ChainId
): boolean {
  return findVerifier(verifiers, chain) !== undefined;
}

/**
 * Get all unique chains supported by the provided verifiers.
 *
 * @param verifiers - Array of available chain verifiers
 * @returns Array of unique CAIP-2 chain identifiers
 */
export function getSupportedChains(verifiers: ChainVerifier[]): ChainId[] {
  const chains = new Set<ChainId>();
  for (const verifier of verifiers) {
    for (const chain of verifier.supportedChains) {
      chains.add(chain);
    }
  }
  return Array.from(chains);
}
