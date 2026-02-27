/**
 * @summary Signer implementations re-exports for @fluxpointstudios/orynq-sdk-payer-evm-direct.
 *
 * This file re-exports all signer implementations for convenient access.
 * Choose the appropriate signer based on your environment:
 *
 * - ViemSigner: Browser/Node.js with private key or wallet connector
 * - EvmKmsSigner: Production server-side with AWS KMS (requires @aws-sdk/client-kms)
 *
 * Used by:
 * - Application code importing signers from the package
 * - ViemPayer for transaction signing
 */

// Viem-based signer for browser and Node.js
export { ViemSigner, type ViemSignerConfig } from "./viem-signer.js";

// AWS KMS signer for production deployments
export {
  EvmKmsSigner,
  type EvmKmsSignerConfig,
  // Legacy exports
  KmsSigner,
  type KmsSignerConfig,
} from "./kms-signer.js";
