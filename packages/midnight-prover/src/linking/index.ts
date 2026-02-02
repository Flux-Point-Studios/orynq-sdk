/**
 * @fileoverview Linking module exports for cross-chain operations.
 *
 * Location: packages/midnight-prover/src/linking/index.ts
 *
 * Summary:
 * This file exports all linking-related classes and utilities for:
 * - Publishing proofs to the Midnight network
 * - Creating cross-chain links between Midnight proofs and Cardano anchors
 * - Verifying cross-chain relationships
 *
 * Usage:
 * ```typescript
 * import {
 *   ProofPublisher,
 *   CardanoAnchorLinker,
 *   createProofPublisher,
 *   createCardanoAnchorLinker,
 * } from "@fluxpointstudios/poi-sdk-midnight-prover";
 *
 * const publisher = createProofPublisher({ maxRetries: 3 });
 * const linker = createCardanoAnchorLinker({ debug: true });
 * ```
 *
 * Related files:
 * - proof-publication.ts: Proof publishing to Midnight
 * - cardano-anchor-link.ts: Cross-chain linking utilities
 */

// =============================================================================
// PROOF PUBLICATION
// =============================================================================

export type {
  ProofStatus,
  ProofStatusInfo,
  ProofPublisherOptions,
} from "./proof-publication.js";

export {
  ProofPublisher,
  createProofPublisher,
} from "./proof-publication.js";

// =============================================================================
// CROSS-CHAIN LINKING
// =============================================================================

export type {
  CrossChainLink,
  LinkVerificationResult,
  CardanoAnchorLinkerOptions,
} from "./cardano-anchor-link.js";

export {
  CardanoAnchorLinker,
  createCardanoAnchorLinker,
} from "./cardano-anchor-link.js";
