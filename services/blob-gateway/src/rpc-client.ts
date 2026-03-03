/**
 * Lazy @polkadot/api singleton for on-chain queries.
 *
 * Used for:
 * - Balance checks (funded-account gate for sig-only uploads)
 * - Receipt-exists checks (deferred cleanup of orphaned blobs)
 *
 * Gracefully degrades on RPC failure — never blocks uploads.
 */

import { ApiPromise, WsProvider } from "@polkadot/api";
import { config } from "./config.js";

let apiPromise: Promise<ApiPromise> | null = null;
let lastConnectAttempt = 0;
const RECONNECT_COOLDOWN_MS = 30_000;
const ZERO_HASH = "0x" + "00".repeat(32);

function getApi(): Promise<ApiPromise> | null {
  if (apiPromise) return apiPromise;
  if (Date.now() - lastConnectAttempt < RECONNECT_COOLDOWN_MS) return null;
  lastConnectAttempt = Date.now();

  const provider = new WsProvider(config.materiosRpcUrl, /* autoConnectMs */ 5000);
  apiPromise = ApiPromise.create({ provider, noInitWarn: true });
  apiPromise
    .then((api) => {
      console.log("[rpc-client] Connected to Materios RPC");
      api.on("disconnected", () => {
        console.warn("[rpc-client] Disconnected from RPC");
        apiPromise = null;
      });
      api.on("error", (err) => {
        console.warn(`[rpc-client] RPC error: ${err}`);
        apiPromise = null;
      });
    })
    .catch((err) => {
      console.warn(`[rpc-client] Failed to connect: ${err}`);
      apiPromise = null;
    });
  return apiPromise;
}

// Balance cache: SS58 → { free, expiry }
const balanceCache = new Map<string, { free: bigint; expiry: number }>();

/**
 * Check if account has minimum balance. Returns true if funded, false if not.
 * Returns TRUE on RPC failure (graceful degradation — don't block uploads).
 */
export async function checkFunded(ss58: string): Promise<boolean> {
  const now = Date.now();
  const cached = balanceCache.get(ss58);
  if (cached && cached.expiry > now) return cached.free >= config.minUploadBalance;

  const pending = getApi();
  if (!pending) {
    console.warn("[rpc-client] RPC unavailable, allowing upload (degraded mode)");
    return true;
  }

  try {
    const api = await pending;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = (await api.query.system.account(ss58)) as any;
    const free = data.free.toBigInt();
    balanceCache.set(ss58, { free, expiry: now + config.balanceCacheTtlMs });
    return free >= config.minUploadBalance;
  } catch (err) {
    console.warn(`[rpc-client] Balance check failed for ${ss58}: ${err}`);
    return true; // Graceful degradation — rely on quotas + nginx
  }
}

/**
 * Check if receipt exists on-chain. For deferred cleanup.
 * Uses storage query — no custom RPC type defs needed.
 * Returns "not_found" | "pending" | "certified" | "rpc_error"
 */
export async function checkReceiptStatus(
  receiptId: string,
): Promise<"not_found" | "pending" | "certified" | "rpc_error"> {
  const pending = getApi();
  if (!pending) return "rpc_error";

  try {
    const api = await pending;
    // Storage query — same pattern as SDK's getReceipt()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (api.query as any).orinqReceipts.receipts(receiptId);
    if (result.isEmpty) return "not_found";

    // Check availability_cert_hash — zero hash means pending, non-zero means certified
    const record = result.toJSON() as Record<string, unknown>;
    const certHash = String(record.availability_cert_hash ?? record.availabilityCertHash ?? "");
    return certHash === ZERO_HASH || certHash === "" ? "pending" : "certified";
  } catch (err) {
    console.warn(`[rpc-client] Receipt status check failed: ${err}`);
    return "rpc_error";
  }
}

export async function disconnectRpc(): Promise<void> {
  if (apiPromise) {
    try {
      (await apiPromise).disconnect();
    } catch {
      // ignore
    }
    apiPromise = null;
  }
}
