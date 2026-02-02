/**
 * @summary Signers module entry point for Cardano key management implementations.
 *
 * This module exports signer implementations and interfaces for
 * cryptographic operations in Cardano payment flows.
 *
 * Available signers:
 * - MemorySigner: Development/testing only (in-memory key storage)
 * - KmsSigner: Production AWS KMS integration (stub - requires implementation)
 *
 * Usage:
 * ```typescript
 * import { MemorySigner, KmsSigner } from "@fluxpointstudios/poi-sdk-payer-cardano-node/signers";
 * import type { Signer } from "@fluxpointstudios/poi-sdk-payer-cardano-node/signers";
 *
 * // Development (WARNING: not for production!)
 * const devSigner = new MemorySigner("hex-private-key");
 *
 * // Production
 * const prodSigner = new KmsSigner({
 *   keyId: "alias/my-cardano-key",
 *   region: "us-east-1",
 * });
 * ```
 */

// Re-export Signer interface from core
export type { Signer, ChainId } from "./interface.js";

// Signer implementations
export { MemorySigner } from "./memory-signer.js";
export { KmsSigner, type KmsSignerConfig } from "./kms-signer.js";
