/**
 * Polling utilities for waiting on receipt certification and anchor submission.
 *
 * After submitting a receipt, the cert daemon committee must attest its
 * availability (setting availability_cert_hash), and then the checkpoint
 * system batches it into a Merkle tree whose root is anchored to L1.
 *
 * These functions poll the chain until the expected state is reached.
 */

import { createHash } from "crypto";
import type { MateriosProvider } from "./provider.js";
import type {
  PollOptions,
  CertificationResult,
  AnchorMatchResult,
  BlobGatewayConfig,
  BatchMetadata,
  CertificationStatusResult,
} from "./types.js";
import { getReceipt, queryMotraBalance } from "./receipt.js";
import { stripPrefix, ensureHex, isZeroHash } from "./hex.js";
import { merkleRoot } from "./merkle.js";

const DEFAULT_INTERVAL_MS = 6_000; // ~1 Substrate block
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Wait until a receipt has been certified by the attester committee.
 *
 * Polls `orinqReceipts.receipts(receiptId)` until
 * `availability_cert_hash` is non-zero.
 *
 * @returns The cert hash, computed checkpoint leaf, and chain ID.
 *
 * @example
 * ```ts
 * const cert = await waitForCertification(provider, receiptId, {
 *   onPoll: (n, ms) => console.log(`  poll #${n} (${ms}ms elapsed)`),
 * });
 * console.log("Certified:", cert.certHash);
 * ```
 */
export async function waitForCertification(
  provider: MateriosProvider,
  receiptId: string,
  opts: PollOptions = {},
): Promise<CertificationResult> {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  let attempt = 0;

  const api = provider.getApi();
  const chainId = api.genesisHash.toHex();

  while (true) {
    attempt++;
    const elapsed = Date.now() - start;
    if (elapsed >= timeout) {
      throw new Error(
        `Certification timeout after ${timeout}ms (${attempt} polls). ` +
          `Hint: if blobs are not uploaded, certification will never complete. ` +
          `Use getCertificationStatus() to check.`,
      );
    }

    opts.onPoll?.(attempt, elapsed);

    const receipt = await getReceipt(provider, receiptId);
    if (receipt && !isZeroHash(receipt.availabilityCertHash)) {
      const certHash = receipt.availabilityCertHash;
      const leafHash = computeCheckpointLeaf(
        chainId,
        receiptId,
        certHash,
      );
      return { receiptId: ensureHex(receiptId), certHash, leafHash, chainId };
    }

    await sleep(interval);
  }
}

/**
 * Wait until an anchor containing the receipt's checkpoint leaf is found.
 *
 * Scans `AnchorSubmitted` events for an anchor whose `rootHash` matches
 * the receipt's leaf hash (single-leaf batch). For multi-leaf batches,
 * use the Python `materios-verify` tool for full Merkle reconstruction.
 *
 * @param certResult - The certification result from `waitForCertification`.
 * @param scanWindow - Number of recent blocks to scan (default: 500).
 *
 * @example
 * ```ts
 * const anchor = await waitForAnchor(provider, certResult, {
 *   onPoll: (n) => console.log(`  scanning for anchor... (attempt ${n})`),
 * });
 * console.log("Anchored in block:", anchor.blockHash);
 * ```
 */
export async function waitForAnchor(
  provider: MateriosProvider,
  certResult: CertificationResult,
  opts: PollOptions & { scanWindow?: number; blobGateway?: BlobGatewayConfig } = {},
): Promise<AnchorMatchResult> {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const scanWindow = opts.scanWindow ?? 50;
  const start = Date.now();
  let attempt = 0;

  while (true) {
    attempt++;
    const elapsed = Date.now() - start;
    if (elapsed >= timeout) {
      throw new Error(
        `Anchor timeout after ${timeout}ms (${attempt} polls)`,
      );
    }

    opts.onPoll?.(attempt, elapsed);

    // Try batch metadata from gateway first (handles multi-leaf + pruned nodes)
    if (opts.blobGateway) {
      const batchMatch = await scanForAnchorWithGateway(
        provider,
        certResult.leafHash,
        scanWindow,
        opts.blobGateway,
      );
      if (batchMatch) return batchMatch;
    }

    // Fallback: exact-match on-chain scan (single-leaf only)
    const match = await scanForAnchor(
      provider,
      certResult.leafHash,
      scanWindow,
    );
    if (match) return match;

    await sleep(interval);
  }
}

/**
 * Scan recent blocks for an AnchorSubmitted event whose root matches the leaf.
 */
async function scanForAnchor(
  provider: MateriosProvider,
  leafHash: string,
  scanWindow: number,
): Promise<AnchorMatchResult | null> {
  const api = provider.getApi();
  const best = (
    await api.rpc.chain.getHeader()
  ).number.toNumber();
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
      // State pruned for this block, stop scanning further back
      break;
    }
  }

  return null;
}

/**
 * Scan recent blocks for AnchorSubmitted events and check batch metadata
 * from the gateway to find multi-leaf anchors containing the target leaf.
 * Handles pruned nodes gracefully.
 */
async function scanForAnchorWithGateway(
  provider: MateriosProvider,
  leafHash: string,
  scanWindow: number,
  gateway: BlobGatewayConfig,
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
          const anchorId = event.data[0]?.toHex?.() ?? String(event.data[0]);
          const rootHash = event.data[1]?.toHex?.() ?? String(event.data[1]);

          // Check exact match first
          if (stripPrefix(rootHash).toLowerCase() === leafHex) {
            return {
              anchorId,
              rootHash: ensureHex(stripPrefix(rootHash)),
              blockHash: blockHash.toHex(),
              exactMatch: true,
            };
          }

          // Query batch metadata from gateway for multi-leaf match
          try {
            const headers: Record<string, string> = {};
            if (gateway.apiKey) headers["x-api-key"] = gateway.apiKey;
            const res = await fetch(
              `${gateway.baseUrl}/batches/${stripPrefix(anchorId)}`,
              { headers },
            );
            if (res.ok) {
              const batch: BatchMetadata = await res.json();
              const leafIndex = batch.leafHashes.findIndex(
                (h) => stripPrefix(h).toLowerCase() === leafHex,
              );
              if (leafIndex >= 0) {
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

/**
 * Compute the checkpoint leaf hash.
 *
 * leaf = SHA256("materios-checkpoint-v1" || chainId || receiptId || certHash)
 *
 * All values are converted to 32-byte big-endian before concatenation.
 */
export function computeCheckpointLeaf(
  chainId: string,
  receiptId: string,
  certHash: string,
): string {
  const prefix = Buffer.from("materios-checkpoint-v1", "utf8");
  const chainBytes = toBytes32(chainId);
  const receiptBytes = toBytes32(receiptId);
  const certBytes = toBytes32(certHash);

  const hash = createHash("sha256")
    .update(Buffer.concat([prefix, chainBytes, receiptBytes, certBytes]))
    .digest("hex");

  return "0x" + hash;
}

/**
 * Wait until an account has sufficient MOTRA balance to pay transaction fees.
 *
 * On Materios v5+, MOTRA is 15 decimals (Midnight DUST parity) and MATRA is 6.
 * With the default pallet params (`generation_per_matra_per_block = 100_000`),
 * holding 1 MATRA generates ~1e5 MOTRA-base per block = 1e-10 MOTRA/block in
 * display units. A v5 extrinsic costs ~1.2 µMOTRA = 1.2e9 base — so the
 * default minBalance below is tuned to cover ~1000× a single tx fee, giving
 * cert-daemon bursts room to chain several txs before waiting again.
 *
 * @param minBalance - Minimum MOTRA balance required in base units
 *   (default: 1.5e12 = 1.5 milli-MOTRA at 15 decimals). Pre-v5 callers that
 *   hard-coded 1_500_000n should update — that value is now 1000× too small
 *   and the poll will return immediately with a balance that can't pay fees.
 * @param opts - Poll interval and timeout options.
 * @returns The MOTRA balance once it reaches the minimum.
 */
export async function waitForMotra(
  provider: MateriosProvider,
  minBalance = 1_500_000_000_000n,
  opts: PollOptions = {},
): Promise<bigint> {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeout = opts.timeoutMs ?? 60_000;
  const start = Date.now();
  let attempt = 0;

  while (true) {
    attempt++;
    const elapsed = Date.now() - start;
    if (elapsed >= timeout) {
      throw new Error(
        `MOTRA warm-up timeout after ${timeout}ms (${attempt} polls). ` +
          `Account may not have sufficient MATRA holdings to generate MOTRA.`,
      );
    }

    opts.onPoll?.(attempt, elapsed);

    const balance = await queryMotraBalance(provider);
    if (balance >= minBalance) return balance;

    await sleep(interval);
  }
}

/**
 * Check the current certification status of a receipt.
 * Optionally queries blob gateway for blob upload status.
 *
 * This is useful for diagnosing why `waitForCertification()` might be
 * timing out — typically because blobs have not been uploaded to the
 * gateway, so the cert daemon cannot verify availability.
 *
 * @example
 * ```ts
 * const status = await getCertificationStatus(provider, receiptId, {
 *   baseUrl: "https://blobs.example.com",
 * });
 * console.log(status.status); // "PENDING_NO_BLOBS"
 * ```
 */
export async function getCertificationStatus(
  provider: MateriosProvider,
  receiptId: string,
  blobGateway?: BlobGatewayConfig,
): Promise<CertificationStatusResult> {
  // 1. Check if receipt exists on-chain
  const receipt = await getReceipt(provider, receiptId);
  if (!receipt) {
    return { receiptId, status: "RECEIPT_NOT_FOUND", details: "Receipt not found on-chain" };
  }

  // 2. Check if cert hash is set (non-zero)
  const certHash = receipt.availabilityCertHash;
  if (certHash && !isZeroHash(certHash)) {
    return { receiptId, status: "CERTIFIED", certHash, blobsUploaded: true };
  }

  // 3. If gateway provided, check blob status
  if (blobGateway) {
    try {
      const contentHash = receipt.contentHash;
      const stripped = stripPrefix(contentHash);
      const res = await fetch(`${blobGateway.baseUrl}/blobs/${stripped}/status`);
      if (res.ok) {
        const status = await res.json();
        if (status.complete) {
          return {
            receiptId,
            status: "PENDING_VERIFICATION",
            blobsUploaded: true,
            details: "Blobs uploaded, waiting for daemon attestation",
          };
        }
      }
    } catch {
      // Gateway unreachable, fall through
    }
    return {
      receiptId,
      status: "PENDING_NO_BLOBS",
      blobsUploaded: false,
      details: "Receipt exists but blob data not uploaded to gateway",
    };
  }

  // No gateway → can't determine blob status, just say pending
  return {
    receiptId,
    status: "PENDING_VERIFICATION",
    details: "Receipt exists, cert hash not yet set",
  };
}

function toBytes32(hex: string): Buffer {
  return Buffer.from(stripPrefix(hex).padStart(64, "0"), "hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
