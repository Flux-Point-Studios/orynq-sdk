/**
 * Push-notify the cert daemon when blob upload completes.
 * Fire-and-forget with 3s timeout.
 */

import { config } from "./config.js";

export async function notifyDaemon(contentHash: string, receiptId: string): Promise<void> {
  if (!config.daemonNotifyUrl) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.daemonNotifyToken) {
      headers["X-Internal-Token"] = config.daemonNotifyToken;
    }

    await fetch(`${config.daemonNotifyUrl}/notify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ receiptId, contentHash }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
  } catch (err) {
    console.warn(`[blob-gateway] Daemon notify failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
