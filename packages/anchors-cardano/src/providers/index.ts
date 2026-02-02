/**
 * @fileoverview Provider exports for Cardano anchor verification.
 *
 * Location: packages/anchors-cardano/src/providers/index.ts
 *
 * This module re-exports all Cardano blockchain data providers for
 * anchor verification. Each provider implements the AnchorChainProvider
 * interface, allowing interchangeable use with the verification functions.
 *
 * Available providers:
 * - Blockfrost: Hosted Cardano API service (recommended for most use cases)
 * - Koios: Community-operated distributed API
 *
 * Used by:
 * - Application code needing to verify anchors on Cardano
 * - The main package index for re-export
 *
 * @example
 * ```typescript
 * import {
 *   createBlockfrostProvider,
 *   createKoiosProvider,
 * } from "@fluxpointstudios/poi-sdk-anchors-cardano/providers";
 *
 * // Using Blockfrost
 * const blockfrost = createBlockfrostProvider({
 *   projectId: "mainnetXXXXXXXX",
 *   network: "mainnet",
 * });
 *
 * // Using Koios
 * const koios = createKoiosProvider({
 *   network: "mainnet",
 *   apiToken: "optional-token",
 * });
 * ```
 */

// Blockfrost provider
export {
  createBlockfrostProvider,
  getBlockfrostBaseUrl,
  BlockfrostError,
} from "./blockfrost.js";

// Koios provider
export {
  createKoiosProvider,
  getKoiosBaseUrl,
  KoiosError,
} from "./koios.js";
