/**
 * Submits anchors to the Materios chain via OrinqReceipts.submit_anchor extrinsic.
 */

import { createHash } from "crypto";
import type { MateriosProvider } from "./provider.js";
import type { AnchorEntry, MateriosAnchorResult, TimeoutOptions } from "./types.js";
import { submit } from "./submission.js";
import { stripPrefix } from "./hex.js";

/**
 * Compute SHA-256 of a hex string (without 0x prefix).
 */
function sha256Hex(hex: string): string {
  const bytes = Buffer.from(stripPrefix(hex), "hex");
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Compute the anchor_id as H256 from the entry's rootHash + manifestHash.
 */
function computeAnchorId(rootHash: string, manifestHash: string): string {
  const combined = stripPrefix(rootHash) + stripPrefix(manifestHash);
  return "0x" + sha256Hex(combined);
}

/**
 * Submit an anchor entry to the Materios chain.
 */
export async function submitAnchor(
  provider: MateriosProvider,
  entry: AnchorEntry,
  opts: TimeoutOptions = {},
): Promise<MateriosAnchorResult> {
  const rootHashHex = stripPrefix(entry.rootHash);
  const manifestHashHex = stripPrefix(entry.manifestHash);
  const anchorId = computeAnchorId(entry.rootHash, entry.manifestHash);

  // content_hash = SHA256(rootHash bytes)
  const contentHashHex = sha256Hex(rootHashHex);
  const fields = { anchorId, contentHash: "0x" + contentHashHex, rootHash: entry.rootHash, manifestHash: entry.manifestHash };

  return submit<MateriosAnchorResult>(provider, {
    id: anchorId,
    expected: {
      kind: "anchor",
      fields: {
        contentHash: fields.contentHash,
        rootHash: ("0x" + rootHashHex).toLowerCase(),
        manifestHash: ("0x" + manifestHashHex).toLowerCase(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    build: api => (api.tx as any).orinqReceipts.submitAnchor(
      anchorId,
      "0x" + contentHashHex,
      "0x" + rootHashHex,
      "0x" + manifestHashHex,
    ),
    result: ({ blockHash, reconciled }) => ({ ...fields, blockHash, ...(reconciled ? { reconciled } : {}) }),
  }, opts);
}
