/**
 * @summary Signer implementations re-exports for @fluxpointstudios/poi-sdk-payer-evm-x402.
 *
 * This file re-exports all signer implementations for convenient access.
 * Choose the appropriate signer based on your environment:
 *
 * - ViemSigner: Browser/Node.js with private key or wallet connector
 * - EvmKmsSigner: Production server-side with AWS KMS (requires @aws-sdk/client-kms)
 *
 * Used by:
 * - Application code importing signers from the package
 * - EvmX402Payer for payment signing
 */

// Viem-based signer for browser and Node.js
export { ViemSigner, type ViemSignerConfig } from "./viem-signer.js";

// AWS KMS signer for production deployments
export {
  EvmKmsSigner,
  type EvmKmsSignerConfig,
  // Legacy exports for backward compatibility
  KmsSigner,
  type KmsSignerConfig,
} from "./kms-signer.js";
