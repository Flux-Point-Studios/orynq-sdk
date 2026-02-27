/**
 * On-chain verification for Materios receipts.
 *
 * TypeScript port of the core verification pipeline from
 * materios-verify (Python). Checks the full chain of custody:
 *
 *   receipt → cert_hash → checkpoint_leaf → anchor_root → on-chain
 *
 * For full multi-leaf Merkle reconstruction, use the Python
 * `materios-verify` CLI which supports batch history files and
 * on-chain reconstruction.
 */

import type { MateriosProvider } from "./provider.js";
import type {
  VerifyResult,
  VerifyStep,
  AnchorMatchResult,
} from "./types.js";
import { getReceipt } from "./receipt.js";
import { stripPrefix, ensureHex, isZeroHash } from "./hex.js";
import { computeCheckpointLeaf } from "./polling.js";

/**
 * Verify a receipt's full chain of custody on the Materios chain.
 *
 * Runs a 5-step verification pipeline:
 *   1. Receipt exists on-chain
 *   2. Availability certification (cert_hash set)
 *   3. Checkpoint leaf computation
 *   4. Anchor lookup (single-leaf match)
 *   5. Root hash match
 *
 * @example
 * ```ts
 * const result = await verifyReceipt(provider, receiptId, { scanWindow: 1000 });
 * console.log(result.status); // "FULLY_VERIFIED"
 * ```
 */
export async function verifyReceipt(
  provider: MateriosProvider,
  receiptId: string,
  opts: { scanWindow?: number } = {},
): Promise<VerifyResult> {
  const api = provider.getApi();
  const chainId = api.genesisHash.toHex();
  const scanWindow = opts.scanWindow ?? 500;
  const steps: VerifyStep[] = [];

  // Step 1: Receipt exists
  const receipt = await getReceipt(provider, receiptId);
  steps.push({
    step: 1,
    title: "Receipt on-chain",
    passed: receipt !== null,
    details: receipt
      ? {
          receiptId: receipt.receiptId,
          contentHash: receipt.contentHash,
          submitter: receipt.submitter,
        }
      : { error: "Receipt not found" },
  });

  if (!receipt) {
    return {
      status: "NOT_VERIFIED",
      receipt: null,
      certHash: null,
      leafHash: null,
      anchor: null,
      chainId,
      steps,
    };
  }

  // Step 2: Certification
  const certHash = receipt.availabilityCertHash;
  const hasCert = !isZeroHash(certHash);
  steps.push({
    step: 2,
    title: "Availability certified",
    passed: hasCert,
    details: hasCert
      ? { certHash }
      : { status: "Pending attestation" },
  });

  if (!hasCert) {
    return {
      status: "NOT_VERIFIED",
      receipt,
      certHash: null,
      leafHash: null,
      anchor: null,
      chainId,
      steps,
    };
  }

  // Step 3: Compute checkpoint leaf
  const leafHash = computeCheckpointLeaf(chainId, receiptId, certHash);
  steps.push({
    step: 3,
    title: "Checkpoint leaf computed",
    passed: true,
    details: { leafHash, chainId },
  });

  // Step 4: Scan for anchor
  const anchor = await scanForAnchorMatch(provider, leafHash, scanWindow);
  steps.push({
    step: 4,
    title: "Anchor found",
    passed: anchor !== null,
    details: anchor
      ? {
          anchorId: anchor.anchorId,
          rootHash: anchor.rootHash,
          blockHash: anchor.blockHash,
          matchType: anchor.exactMatch ? "exact (single-leaf)" : "multi-leaf",
        }
      : { status: "No matching anchor in recent blocks" },
  });

  if (!anchor) {
    return {
      status: "PARTIALLY_VERIFIED",
      receipt,
      certHash,
      leafHash,
      anchor: null,
      chainId,
      steps,
    };
  }

  // Step 5: Root hash match
  const rootMatch =
    stripPrefix(anchor.rootHash).toLowerCase() ===
    stripPrefix(leafHash).toLowerCase();
  steps.push({
    step: 5,
    title: "Root hash verified",
    passed: rootMatch,
    details: {
      anchorRoot: anchor.rootHash,
      expectedLeaf: leafHash,
      match: rootMatch ? "exact" : "mismatch",
    },
  });

  return {
    status: rootMatch ? "FULLY_VERIFIED" : "PARTIALLY_VERIFIED",
    receipt,
    certHash,
    leafHash,
    anchor,
    chainId,
    steps,
  };
}

/**
 * Scan recent blocks for an anchor whose rootHash matches the leaf.
 */
async function scanForAnchorMatch(
  provider: MateriosProvider,
  leafHash: string,
  scanWindow: number,
): Promise<AnchorMatchResult | null> {
  const api = provider.getApi();
  const best = (await api.rpc.chain.getHeader()).number.toNumber();
  const from = Math.max(1, best - scanWindow);
  const leafHex = stripPrefix(leafHash).toLowerCase();

  for (let block = best; block >= from; block--) {
    try {
      const blockHash = await api.rpc.chain.getBlockHash(block);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const events = (await (api.query as any).system.events.at(
        blockHash,
      )) as any[];

      for (const { event } of events) {
        if (
          event.section === "orinqReceipts" &&
          event.method === "AnchorSubmitted"
        ) {
          const data = event.data;
          const anchorId = data[0]?.toHex?.() ?? String(data[0]);
          const rootHash = data[1]?.toHex?.() ?? String(data[1]);
          const rootHex = stripPrefix(rootHash).toLowerCase();

          if (rootHex === leafHex) {
            return {
              anchorId,
              rootHash: ensureHex(rootHex),
              blockHash: blockHash.toHex(),
              exactMatch: true,
            };
          }
        }
      }
    } catch {
      // State pruned for this block, skip
      continue;
    }
  }

  return null;
}
