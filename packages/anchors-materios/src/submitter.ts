/**
 * Submits anchors to the Materios chain via OrinqReceipts.submit_anchor extrinsic.
 */

import { createHash } from "crypto";
import type { MateriosProvider } from "./provider.js";
import type { AnchorEntry, MateriosAnchorResult, TimeoutOptions } from "./types.js";
import { timeoutBudget, withinDeadline } from "./deadline.js";
import { watchSubmission } from "./subscription.js";
import { MateriosSubmissionError } from "./errors.js";
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
  const api = provider.getApi();
  const keypair = provider.getKeypair();
  const timeoutMs = timeoutBudget(opts.timeoutMs ?? provider.inclusionTimeoutMs ?? 120_000);
  const deadline = Date.now() + timeoutMs;
  const watchDeadline = deadline - Math.min(30_000, timeoutMs / 2);

  const rootHashHex = stripPrefix(entry.rootHash);
  const manifestHashHex = stripPrefix(entry.manifestHash);
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

  const unknown = () => new MateriosSubmissionError("inclusion-unknown", anchorId,
    "Anchor finalization could not be established; do not blindly resubmit");
  const result = await watchSubmission(api, callback => tx.signAndSend(keypair, callback), watchDeadline, anchorId, true);
  const fields = { anchorId, contentHash: "0x" + contentHashHex, rootHash: entry.rootHash, manifestHash: entry.manifestHash };
  if (result) return { ...fields, blockHash: result.status.asFinalized.toHex() };
  try {
    return await provider.withRecoveryApi(async recovery => {
      const head = await withinDeadline(() => recovery.rpc.chain.getFinalizedHead(), deadline, unknown);
      const at = await withinDeadline(() => recovery.at(head), deadline, unknown);
      const record = await withinDeadline(() => at.query.orinqReceipts!.anchors!(anchorId), deadline, unknown);
      if (record.isEmpty) throw unknown();
      const value = record.toJSON() as Record<string, unknown>;
      if (String(value.content_hash ?? value.contentHash).toLowerCase() !== fields.contentHash.toLowerCase()
        || String(value.root_hash ?? value.rootHash).toLowerCase() !== ("0x" + rootHashHex).toLowerCase()
        || String(value.manifest_hash ?? value.manifestHash).toLowerCase() !== ("0x" + manifestHashHex).toLowerCase()) {
        throw unknown();
      }
      return { ...fields, blockHash: head.toHex(), reconciled: true };
    }, deadline - Date.now());
  } catch (cause) {
    if (cause instanceof MateriosSubmissionError) throw cause;
    throw new MateriosSubmissionError("inclusion-unknown", anchorId,
      "Anchor recovery could not read finalized storage before the deadline; do not blindly resubmit", { cause });
  }
}
