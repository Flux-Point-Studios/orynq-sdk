/**
 * Environment configuration for anchor-worker service.
 *
 * Location: services/anchor-worker/src/env.ts
 */

import {
  isCardanoNetwork,
  type CardanoNetwork,
} from "@fluxpointstudios/orynq-sdk-anchors-cardano";

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
 * Cardano network to anchor on. Required: a default would be a guess, and a
 * guessed network gets reported back to clients as fact.
 */
export const CARDANO_NETWORK = process.env.CARDANO_NETWORK as CardanoNetwork;

/**
 * Wallet seed phrase for signing transactions.
 * Required - service will not start without it.
 */
export const WALLET_SEED_PHRASE = process.env.WALLET_SEED_PHRASE;

/**
 * Internal URL for t-backend service callbacks.
 * @default "http://t-backend:8000"
 */
export const T_BACKEND_INTERNAL_URL =
  process.env.T_BACKEND_INTERNAL_URL ?? "http://t-backend:8000";

const REQUIRED = [
  "ANCHOR_WORKER_TOKEN",
  "BLOCKFROST_PROJECT_ID",
  "CARDANO_NETWORK",
  "WALLET_SEED_PHRASE",
] as const;

/**
 * Throws naming every required variable that is unset, then rejects a
 * CARDANO_NETWORK the worker cannot anchor on.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
  if (!isCardanoNetwork(env.CARDANO_NETWORK)) {
    throw new Error(
      `CARDANO_NETWORK must be one of mainnet, preprod, preview (got "${env.CARDANO_NETWORK}")`
    );
  }
}
