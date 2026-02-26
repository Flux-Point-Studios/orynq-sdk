/**
 * Verifies anchors stored on the Materios chain by querying OrinqReceipts.Anchors storage.
 */

import type { MateriosProvider } from "./provider.js";
import type { AnchorRecord } from "./types.js";

/**
 * Get an anchor record from the Materios chain by anchor ID.
 */
export async function getAnchor(
  provider: MateriosProvider,
  anchorId: string,
): Promise<AnchorRecord | null> {
  const api = provider.getApi();
  const result = await api.query.orinqReceipts.anchors(anchorId);

  if (result.isEmpty) {
    return null;
  }

  const record = result.toJSON() as Record<string, unknown>;
  return {
    anchorId,
    contentHash: String(record.content_hash ?? record.contentHash ?? ""),
    rootHash: String(record.root_hash ?? record.rootHash ?? ""),
    manifestHash: String(record.manifest_hash ?? record.manifestHash ?? ""),
    submitter: String(record.submitter ?? ""),
    blockNumber: 0, // block number not stored in anchor record directly
  };
}

/**
 * Check if an anchor exists on-chain.
 */
export async function anchorExists(
  provider: MateriosProvider,
  anchorId: string,
): Promise<boolean> {
  const api = provider.getApi();
  const result = await api.query.orinqReceipts.anchors(anchorId);
  return !result.isEmpty;
}
