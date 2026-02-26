/**
 * Environment configuration for Materios anchor worker.
 */

export const PORT = parseInt(process.env.PORT ?? "3334", 10);
export const MATERIOS_RPC_URL = process.env.MATERIOS_RPC_URL ?? "ws://materios-rpc.materios.svc.cluster.local:9944";
export const SIGNER_URI = process.env.SIGNER_URI ?? "//Alice";
export const ANCHOR_WORKER_TOKEN = process.env.ANCHOR_WORKER_TOKEN;
export const TX_TIMEOUT = parseInt(process.env.TX_TIMEOUT ?? "30000", 10);

export function validateEnv(): void {
  if (!ANCHOR_WORKER_TOKEN) {
    throw new Error("ANCHOR_WORKER_TOKEN is required");
  }
}
