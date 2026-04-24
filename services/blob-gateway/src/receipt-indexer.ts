/**
 * Receipt Indexer — polls Materios chain for ReceiptSubmitted events
 * and writes receipt-to-content index entries.
 *
 * This bridges the gap between blob uploads (keyed by contentHash)
 * and receipt queries (keyed by receiptId). The game client may
 * derive receiptId differently from the gateway's computeReceiptId(),
 * so this indexer uses the authoritative on-chain mapping.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { config } from "./config.js";

const POLL_INTERVAL_MS = 6_000; // Poll every 6 seconds (1 block)
const STATE_FILE = join(config.storagePath, "indexer-state.json");

function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function indexDir(): string {
  return join(config.storagePath, "index", "receipt-to-content");
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

interface IndexerState {
  lastProcessedBlock: number;
}

async function loadState(): Promise<IndexerState> {
  try {
    const data = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return { lastProcessedBlock: 0 };
  }
}

async function saveState(state: IndexerState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state));
}

async function writeIndex(receiptId: string, contentHash: string): Promise<void> {
  const dir = indexDir();
  await ensureDir(dir);
  const receiptIdClean = stripHexPrefix(receiptId);
  const contentHashClean = stripHexPrefix(contentHash);
  await writeFile(join(dir, `${receiptIdClean}.txt`), contentHashClean);
}

/**
 * Start the receipt indexer background loop.
 * Uses raw JSON-RPC calls to avoid @polkadot/api metadata decode issues.
 */
export async function startReceiptIndexer(): Promise<void> {
  const rpcUrl = config.materiosRpcUrl?.replace("ws://", "http://").replace("wss://", "https://");
  if (!rpcUrl) {
    console.log("[receipt-indexer] No RPC URL configured, indexer disabled");
    return;
  }

  console.log(`[receipt-indexer] Starting, RPC: ${rpcUrl}`);
  let state = await loadState();

  const poll = async () => {
    try {
      // Get current block number
      const headerResp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "chain_getHeader",
          params: [],
        }),
      });
      const headerData = (await headerResp.json()) as {
        result?: { number?: string };
      };
      const bestBlock = parseInt(headerData.result?.number || "0x0", 16);

      if (bestBlock <= state.lastProcessedBlock) return;

      // If first run, start from current block (don't replay)
      if (state.lastProcessedBlock === 0) {
        state.lastProcessedBlock = Math.max(0, bestBlock - 10);
      }

      // Scan new blocks for ReceiptSubmitted events
      for (
        let blockNum = state.lastProcessedBlock + 1;
        blockNum <= bestBlock;
        blockNum++
      ) {
        // Get block hash
        const hashResp = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "chain_getBlockHash",
            params: [blockNum],
          }),
        });
        const hashData = (await hashResp.json()) as { result?: string };
        const blockHash = hashData.result;
        if (!blockHash) continue;

        // Get events via system events storage
        // Use the orinq_getReceipt RPC for each new receipt instead of
        // decoding events (avoids metadata decode issues).
        // We'll check receipt count to detect new receipts.

        state.lastProcessedBlock = blockNum;
      }

      // Simpler approach: check receipt count and query any unindexed receipts
      const countResp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "orinq_getReceiptCount",
          params: [],
        }),
      });
      const countData = (await countResp.json()) as { result?: number };
      const receiptCount = countData.result || 0;

      if (receiptCount > 0) {
        // Scan all receipts and check if they're indexed.
        //
        // state_getKeysPaged returns keys in blake2_128(receipt_id) hash order,
        // so a single page of the first N keys is NOT "the newest N receipts".
        // New receipts land at random hash positions and may be past any page
        // boundary; the indexer must walk the entire storage map each tick,
        // otherwise receipts past position N are never indexed and get stuck
        // without an availability cert (see the live symptoms on preprod
        // where cert-daemon logs "No locator found for 0x...").
        //
        // Paginate by passing the last key of batch K as start_key for batch
        // K+1 until we see an empty response (or a short final page).
        // OrinqReceipts.Receipts prefix = twox128("OrinqReceipts") ++ twox128("Receipts").
        const PREFIX =
          "0xcd01cd31249ddf8841dad036babd910f9a6912f00c3f09f66bdf9eb1bdb77563";
        const PAGE_SIZE = 1000;
        let startKey: string | null = null;
        const allKeys: string[] = [];
        for (;;) {
          const keysResp = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "state_getKeysPaged",
              params: [PREFIX, PAGE_SIZE, startKey],
            }),
          });
          const keysData = (await keysResp.json()) as { result?: string[] };
          const batch = keysData.result || [];
          if (batch.length === 0) break;
          allKeys.push(...batch);
          if (batch.length < PAGE_SIZE) break;
          startKey = batch[batch.length - 1];
        }

        for (const key of allKeys) {
          // Extract receipt_id from the storage key
          // Key format: prefix(32) + blake2_128(16) + receipt_id(32) = 80 bytes hex = 160 chars + 0x
          // The receipt_id is the last 32 bytes (64 hex chars)
          const receiptId = "0x" + key.slice(key.length - 64);

          // Check if already indexed
          const receiptIdClean = stripHexPrefix(receiptId);
          const indexPath = join(indexDir(), `${receiptIdClean}.txt`);
          try {
            await readFile(indexPath, "utf-8");
            continue; // Already indexed
          } catch {
            // Not indexed — query the receipt to get content_hash
          }

          // Query receipt via storage
          const valResp = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "state_getStorage",
              params: [key],
            }),
          });
          const valData = (await valResp.json()) as { result?: string };
          const rawValue = valData.result;
          if (!rawValue) continue;

          // ReceiptRecord layout: schema_hash(32) + content_hash(32) + ...
          // content_hash starts at byte offset 32 (hex offset 64, after 0x prefix = 66)
          const hex = stripHexPrefix(rawValue);
          if (hex.length < 128) continue; // Not enough data

          const contentHash = hex.slice(64, 128); // bytes 32-63 = content_hash

          // Write the index
          await writeIndex(receiptId, contentHash);
          console.log(
            `[receipt-indexer] Indexed: ${receiptId.slice(0, 18)}... → ${contentHash.slice(0, 16)}...`
          );
        }
      }

      await saveState(state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[receipt-indexer] Poll error: ${msg}`);
    }
  };

  // Initial poll
  await poll();

  // Recurring poll
  setInterval(poll, POLL_INTERVAL_MS);
}
