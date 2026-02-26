/**
 * Submits anchors to the Materios chain via OrinqReceipts.submit_anchor extrinsic.
 */

import { createHash } from "crypto";
import type { MateriosProvider } from "./provider.js";
import type { AnchorEntry, MateriosAnchorResult } from "./types.js";

/**
 * Compute SHA-256 of a hex string (without 0x prefix).
 */
function sha256Hex(hex: string): string {
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Compute the anchor_id as H256 from the entry's rootHash + manifestHash.
 */
function computeAnchorId(rootHash: string, manifestHash: string): string {
  const combined = rootHash.replace(/^(sha256:)?0x?/, "") + manifestHash.replace(/^(sha256:)?0x?/, "");
  return "0x" + sha256Hex(combined);
}

/**
 * Submit an anchor entry to the Materios chain.
 */
export async function submitAnchor(
  provider: MateriosProvider,
  entry: AnchorEntry,
): Promise<MateriosAnchorResult> {
  const api = provider.getApi();
  const keypair = provider.getKeypair();

  const rootHashHex = entry.rootHash.replace(/^(sha256:)?0x?/, "");
  const manifestHashHex = entry.manifestHash.replace(/^(sha256:)?0x?/, "");
  const anchorId = computeAnchorId(entry.rootHash, entry.manifestHash);

  // content_hash = SHA256(rootHash bytes)
  const contentHashHex = sha256Hex(rootHashHex);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx = (api.tx as any).orinqReceipts.submitAnchor(
    anchorId,
    "0x" + contentHashHex,
    "0x" + rootHashHex,
    "0x" + manifestHashHex,
  );

  return new Promise<MateriosAnchorResult>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx.signAndSend(keypair, ({ status, dispatchError }: any) => {
      if (dispatchError) {
        if (dispatchError.isModule) {
          const decoded = api.registry.findMetaError(dispatchError.asModule);
          reject(new Error(`${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`));
        } else {
          reject(new Error(dispatchError.toString()));
        }
        return;
      }
      if (status.isFinalized) {
        resolve({
          blockHash: status.asFinalized.toHex(),
          anchorId,
          contentHash: "0x" + contentHashHex,
          rootHash: entry.rootHash,
          manifestHash: entry.manifestHash,
        });
      }
    }).catch(reject);
  });
}
