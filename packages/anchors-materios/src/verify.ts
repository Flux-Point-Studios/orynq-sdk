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
  BlobGatewayConfig,
  BatchMetadata,
} from "./types.js";
import { getReceipt } from "./receipt.js";
import { stripPrefix, ensureHex, isZeroHash } from "./hex.js";
import { computeCheckpointLeaf } from "./polling.js";
import { merkleRoot } from "./merkle.js";

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
  opts: { scanWindow?: number; blobGateway?: BlobGatewayConfig } = {},
): Promise<VerifyResult> {
  const api = provider.getApi();
  const chainId = api.genesisHash.toHex();
  const scanWindow = opts.scanWindow ?? 50;
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
  // Try batch metadata from gateway first (handles multi-leaf batches)
  let anchor: AnchorMatchResult | null = null;
  if (opts.blobGateway) {
    anchor = await findAnchorViaBatchMetadata(provider, leafHash, opts.blobGateway);
  }
  // Fallback to direct on-chain scan (exact match only)
  if (!anchor) {
    anchor = await scanForAnchorMatch(provider, leafHash, scanWindow);
  }

  steps.push({
    step: 4,
    title: "Anchor found",
    passed: anchor !== null,
    details: anchor
      ? {
          anchorId: anchor.anchorId,
          rootHash: anchor.rootHash,
          blockHash: anchor.blockHash,
          matchType: anchor.exactMatch ? "exact (single-leaf)" : "multi-leaf (via batch metadata)",
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
  // For single-leaf (exact match), root === leaf.
  // For multi-leaf, the batch metadata query already verified Merkle inclusion.
  const rootMatch = anchor.exactMatch
    ? stripPrefix(anchor.rootHash).toLowerCase() ===
      stripPrefix(leafHash).toLowerCase()
    : true; // Multi-leaf match already verified via merkleRoot in findAnchorViaBatchMetadata
  steps.push({
    step: 5,
    title: "Root hash verified",
    passed: rootMatch,
    details: {
      anchorRoot: anchor.rootHash,
      expectedLeaf: leafHash,
      match: anchor.exactMatch ? "exact" : "merkle-inclusion",
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

/**
 * Find an anchor by querying batch metadata from the blob gateway.
 *
 * This handles multi-leaf batches where the on-chain root is a Merkle root
 * over multiple checkpoint leaves. The gateway stores batch metadata that
 * maps anchor IDs to the full set of leaf hashes.
 *
 * Strategy:
 *   1. Scan recent blocks for AnchorSubmitted events
 *   2. For each anchor, query batch metadata from the gateway
 *   3. Check if our target leaf hash is in the batch
 *   4. If found, verify the Merkle root matches the on-chain root
 */
async function findAnchorViaBatchMetadata(
  provider: MateriosProvider,
  leafHash: string,
  gateway: BlobGatewayConfig,
): Promise<AnchorMatchResult | null> {
  const api = provider.getApi();
  const bestHash = await api.rpc.chain.getFinalizedHead();
  const bestHeader = await api.rpc.chain.getHeader(bestHash);
  const bestNumber = bestHeader.number.toNumber();

  // Scan last ~50 blocks for AnchorSubmitted events
  // (checkpoint interval is usually 2 min = ~20 blocks)
  const scanStart = Math.max(1, bestNumber - 50);

  for (let blockNum = bestNumber; blockNum >= scanStart; blockNum--) {
    try {
      const blockHash = await api.rpc.chain.getBlockHash(blockNum);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const events = (await (api.query as any).system.events.at(
        blockHash,
      )) as any[];

      for (const { event } of events) {
        if (
          event.section === "orinqReceipts" &&
          event.method === "AnchorSubmitted"
        ) {
          const anchorId = event.data[0]?.toHex?.() ?? String(event.data[0]);
          const rootHash = event.data[1]?.toHex?.() ?? String(event.data[1]);

          // Query batch metadata from gateway
          try {
            const headers: Record<string, string> = {};
            if (gateway.apiKey) {
              if (gateway.apiKey.startsWith("matra_")) {
                headers["Authorization"] = `Bearer ${gateway.apiKey}`;
              } else {
                headers["x-api-key"] = gateway.apiKey;
              }
            }
            const res = await fetch(
              `${gateway.baseUrl}/batches/${stripPrefix(anchorId)}`,
              { headers },
            );
            if (res.ok) {
              const batch: BatchMetadata = await res.json();
              // Check if our leaf is in this batch
              const leafIndex = batch.leafHashes.findIndex(
                (h) => stripPrefix(h).toLowerCase() === stripPrefix(leafHash).toLowerCase(),
              );
              if (leafIndex >= 0) {
                // Verify Merkle root matches the on-chain root
                const computedRoot = merkleRoot(batch.leafHashes);
                if (
                  stripPrefix(computedRoot).toLowerCase() ===
                  stripPrefix(rootHash).toLowerCase()
                ) {
                  return {
                    anchorId: ensureHex(stripPrefix(anchorId)),
                    rootHash: ensureHex(stripPrefix(rootHash)),
                    blockHash: blockHash.toHex(),
                    exactMatch: batch.leafCount === 1,
                  };
                }
              }
            }
          } catch {
            // Gateway unreachable, continue scanning
          }
        }
      }
    } catch {
      // State pruned for this block, stop scanning further back
      break;
    }
  }
  return null;
}
