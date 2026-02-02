/**
 * Location: packages/hydra-batcher/src/tx/index.ts
 *
 * Transaction building module exports.
 *
 * This module exports:
 * - L2 transaction building utilities for Hydra commitment transactions
 * - L1 settlement service for anchoring final state to Cardano mainnet
 *
 * Used by:
 * - index.ts (main package entry point)
 * - batcher.ts (for building commitment transactions and settling to L1)
 * - head-manager.ts (for triggering settlement during fanout)
 */

// L2 Transaction Building
export {
  L2TransactionBuilder,
  computeBatchMerkleRoot,
  buildCommitmentTransaction,
  buildInitialCommitmentTransaction,
  type L2TransactionBuildResult,
  type CommitmentTxOptions,
} from "./l2-tx-builder.js";

// L1 Settlement
export {
  L1SettlementService,
  createMockAnchorProvider,
  settleAndConfirm,
  type L1SettlementConfig,
  type AnchorProvider,
  type SettlementMetadata,
  type MockAnchorProviderOptions,
  type WaitOptions,
} from "./l1-settlement.js";
