/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-evm-x402/src/signers/index.ts
 * @summary Signer implementations re-exports for @poi-sdk/payer-evm-x402.
 *
 * This file re-exports all signer implementations for convenient access.
 * Choose the appropriate signer based on your environment:
 *
 * - ViemSigner: Browser/Node.js with private key or wallet connector
 * - KmsSigner: Production server-side with AWS KMS (stub, requires implementation)
 *
 * Used by:
 * - Application code importing signers from the package
 * - EvmX402Payer for payment signing
 */

export { ViemSigner, type ViemSignerConfig } from "./viem-signer.js";
export { KmsSigner, type KmsSignerConfig } from "./kms-signer.js";
