/**
 * Environment configuration for anchor-worker service.
 *
 * Location: services/anchor-worker/src/env.ts
 */

/**
 * Service port.
 * @default 3333
 */
export const PORT = parseInt(process.env.PORT ?? "3333", 10);

/**
 * Internal authentication token for service-to-service calls.
 * Required - service will not start without it.
 */
export const ANCHOR_WORKER_TOKEN = process.env.ANCHOR_WORKER_TOKEN;

/**
 * Blockfrost API project ID for Cardano network access.
 * Required - service will not start without it.
 */
export const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;

/**
 * Cardano network to use.
 * @default "preprod"
 */
export const CARDANO_NETWORK = (process.env.CARDANO_NETWORK ?? "preprod") as
  | "mainnet"
  | "preprod"
  | "preview";

/**
 * Wallet seed phrase for signing transactions.
 * Required - service will not start without it.
 */
export const WALLET_SEED_PHRASE = process.env.WALLET_SEED_PHRASE;

/**
 * Internal URL for orynq-backend service callbacks.
 * @default "http://orynq-backend:8000"
 */
export const T_BACKEND_INTERNAL_URL =
  process.env.T_BACKEND_INTERNAL_URL ?? "http://orynq-backend:8000";

/**
 * Timeout for awaitTx in milliseconds.
 * @default 10000 (10 seconds)
 */
export const AWAIT_TX_TIMEOUT = parseInt(
  process.env.AWAIT_TX_TIMEOUT ?? "10000",
  10
);

/**
 * Validate required environment variables.
 * Throws if any required variable is missing.
 */
export function validateEnv(): void {
  const missing: string[] = [];

  if (!ANCHOR_WORKER_TOKEN) {
    missing.push("ANCHOR_WORKER_TOKEN");
  }
  if (!BLOCKFROST_PROJECT_ID) {
    missing.push("BLOCKFROST_PROJECT_ID");
  }
  if (!WALLET_SEED_PHRASE) {
    missing.push("WALLET_SEED_PHRASE");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}
