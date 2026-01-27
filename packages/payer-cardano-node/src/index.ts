/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-node/src/index.ts
 * @summary Main entry point for @poi-sdk/payer-cardano-node package.
 *
 * This package provides server-side Cardano payment functionality with
 * pluggable blockchain providers and secure signer abstractions.
 *
 * Key features:
 * - Implements Payer interface from @poi-sdk/core
 * - Multiple provider support (Blockfrost, Koios)
 * - Flexible signer abstraction (MemorySigner for dev, KmsSigner for prod)
 * - Split payment support
 * - Transaction confirmation awaiting
 *
 * Usage:
 * ```typescript
 * import {
 *   CardanoNodePayer,
 *   BlockfrostProvider,
 *   KmsSigner,
 * } from "@poi-sdk/payer-cardano-node";
 *
 * // Create provider
 * const provider = new BlockfrostProvider({
 *   projectId: "your-project-id",
 *   network: "mainnet",
 * });
 *
 * // Create signer (use KmsSigner for production!)
 * const signer = new KmsSigner({
 *   keyId: "alias/my-cardano-key",
 *   region: "us-east-1",
 * });
 *
 * // Create payer
 * const payer = new CardanoNodePayer({
 *   signer,
 *   provider,
 * });
 *
 * // Execute payment
 * const proof = await payer.pay(paymentRequest);
 * ```
 *
 * Subpath exports:
 * - @poi-sdk/payer-cardano-node/signers - Signer implementations
 * - @poi-sdk/payer-cardano-node/providers - Provider implementations
 */

// ---------------------------------------------------------------------------
// Main Exports
// ---------------------------------------------------------------------------

// Node Payer
export {
  CardanoNodePayer,
  type CardanoNodePayerConfig,
} from "./node-payer.js";

// Transaction Builder
export {
  buildPaymentTx,
  calculateTotalAmount,
  buildOutputs,
  selectUtxos,
  estimateMinAda,
  calculateFee,
  isValidCardanoAddress,
  validateCardanoAddress,
  type BuildTxParams,
  type BuiltTx,
  type TxOutput,
} from "./tx-builder.js";

// ---------------------------------------------------------------------------
// Signers (re-export for convenience)
// ---------------------------------------------------------------------------

export {
  MemorySigner,
  KmsSigner,
  type KmsSignerConfig,
} from "./signers/index.js";

// Re-export Signer interface
export type { Signer, ChainId } from "./signers/index.js";

// ---------------------------------------------------------------------------
// Providers (re-export for convenience)
// ---------------------------------------------------------------------------

export {
  BlockfrostProvider,
  KoiosProvider,
  type BlockfrostConfig,
  type KoiosConfig,
} from "./providers/index.js";

// Re-export provider interfaces
export type {
  CardanoProvider,
  UTxO,
  ProtocolParameters,
} from "./providers/index.js";
