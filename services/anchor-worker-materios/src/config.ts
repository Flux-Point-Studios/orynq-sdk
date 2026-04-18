/**
 * Environment configuration for Materios anchor worker.
 */

export const PORT = parseInt(process.env.PORT ?? "3334", 10);
export const MATERIOS_RPC_URL = process.env.MATERIOS_RPC_URL ?? "ws://materios-rpc.materios.svc.cluster.local:9944";
export const SIGNER_URI = process.env.SIGNER_URI ?? "//Alice";
export const ANCHOR_WORKER_TOKEN = process.env.ANCHOR_WORKER_TOKEN;
export const TX_TIMEOUT = parseInt(process.env.TX_TIMEOUT ?? "30000", 10);
export const BLOB_GATEWAY_URL = process.env.BLOB_GATEWAY_URL ?? "";
export const BLOB_GATEWAY_API_KEY = process.env.BLOB_GATEWAY_API_KEY ?? "";

// Cardano L1 settlement (materios-anchor-v2 under label 8746).
// Disabled by default; enable in deployments that should settle checkpoints
// directly to Cardano from this worker. See src/cardano.ts.
export const CARDANO_L1_ENABLED = (process.env.CARDANO_L1_ENABLED ?? "false").toLowerCase() === "true";
export const CARDANO_NETWORK = (process.env.CARDANO_NETWORK ?? "Mainnet") as "Mainnet" | "Preprod" | "Preview" | "Custom";
export const CARDANO_KUPO_URL = process.env.CARDANO_KUPO_URL ?? "https://kupo.saturnswap.io";
export const CARDANO_OGMIOS_URL = process.env.CARDANO_OGMIOS_URL ?? "wss://ogmios.saturnswap.io";
// IMPORTANT: must be a path on disk, chmod 600. NEVER pass the mnemonic via env.
export const CARDANO_MNEMONIC_PATH = process.env.CARDANO_MNEMONIC_PATH ?? "";

export function validateEnv(): void {
  if (!ANCHOR_WORKER_TOKEN) {
    throw new Error("ANCHOR_WORKER_TOKEN is required");
  }
  if (CARDANO_L1_ENABLED && !CARDANO_MNEMONIC_PATH) {
    throw new Error(
      "CARDANO_L1_ENABLED=true requires CARDANO_MNEMONIC_PATH (path to a chmod 600 file with a BIP39 mnemonic)",
    );
  }
}
