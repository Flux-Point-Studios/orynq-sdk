/**
 * @fluxpointstudios/poi-sdk-anchors-materios
 *
 * Materios blockchain anchor support for Proof-of-Intent SDK.
 * Submits and verifies anchors via Substrate extrinsics (OrinqReceipts pallet).
 */

export { MateriosProvider } from "./provider.js";
export { submitAnchor } from "./submitter.js";
export { getAnchor, anchorExists } from "./verifier.js";
export type {
  AnchorEntry,
  MateriosAnchorConfig,
  MateriosAnchorResult,
  AnchorRecord,
} from "./types.js";
