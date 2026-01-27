/**
 * @summary Re-exports the Signer interface from @fluxpointstudios/poi-sdk-core.
 *
 * This file provides convenient access to the Signer interface for
 * implementers of custom signers in the Cardano Node payer context.
 *
 * The Signer interface is defined in @fluxpointstudios/poi-sdk-core and is the standard
 * abstraction for cryptographic operations across all payer implementations.
 *
 * Usage:
 * ```typescript
 * import type { Signer } from "@fluxpointstudios/poi-sdk-payer-cardano-node/signers";
 *
 * class MySigner implements Signer {
 *   // ...
 * }
 * ```
 */

// Re-export Signer interface from core
export type { Signer, ChainId } from "@fluxpointstudios/poi-sdk-core";
