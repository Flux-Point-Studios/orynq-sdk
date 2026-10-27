/**
 * Materios anchor chain provider.
 *
 * Connects to a Materios Substrate node via @polkadot/api and provides
 * methods to submit and query anchors via the OrinqReceipts pallet.
 */

import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import type { KeyringPair } from "@polkadot/keyring/types";
import type { MateriosAnchorConfig, TimeoutOptions } from "./types.js";
import { MateriosConnectionError } from "./errors.js";
import { timeoutBudget, withinDeadline } from "./deadline.js";

async function openApi(rpcUrl: string, timeoutMs: number): Promise<ApiPromise> {
  const provider = new WsProvider(rpcUrl);
  const api = new ApiPromise({ provider, throwOnConnect: true });
  try {
    await withinDeadline(() => api.isReadyOrError, Date.now() + timeoutMs,
      () => new MateriosConnectionError("connect-timeout", timeoutMs));
    return api;
  } catch (cause) {
    await api.disconnect();
    if (cause instanceof MateriosConnectionError) throw cause;
    throw new MateriosConnectionError("connect-failed", timeoutMs, { cause });
  }
}

export class MateriosProvider {
  private api: ApiPromise | null = null;
  private keypair: KeyringPair | null = null;
  private config: MateriosAnchorConfig;
  private connecting: Promise<void> | null = null;

  constructor(config: MateriosAnchorConfig) {
    this.config = config;
  }

  get inclusionTimeoutMs(): number {
    return this.config.inclusionTimeoutMs ?? 120_000;
  }

  async connect(opts: TimeoutOptions = {}): Promise<void> {
    if (this.api) return;
    const timeoutMs = timeoutBudget(opts.timeoutMs ?? this.config.connectTimeoutMs ?? 30_000);
    if (this.connecting) {
      return withinDeadline(() => this.connecting!, Date.now() + timeoutMs,
        () => new MateriosConnectionError("connect-timeout", timeoutMs));
    }
    this.connecting = (async () => {
      const api = await openApi(this.config.rpcUrl, timeoutMs);
      try {
        const keyring = new Keyring({ type: "sr25519" });
        this.keypair = keyring.addFromUri(this.config.signerUri);
        this.api = api;
      } catch (error) {
        await api.disconnect();
        throw error;
      }
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connecting) await this.connecting;
    if (this.api) {
      await this.api.disconnect();
      this.api = null;
    }
    this.keypair = null;
  }

  /** An isolated read connection cannot revive or replay the interrupted transaction watch. */
  async withRecoveryApi<T>(read: (api: ApiPromise) => Promise<T>, timeoutMs: number): Promise<T> {
    timeoutBudget(timeoutMs);
    const deadline = Date.now() + timeoutMs;
    const api = await openApi(this.config.rpcUrl, Math.min(timeoutMs, this.config.connectTimeoutMs ?? 30_000));
    try {
      if (api.genesisHash.toHex() !== this.getApi().genesisHash.toHex()) {
        throw new Error("Recovery endpoint returned a different genesis hash");
      }
      return await withinDeadline(() => read(api), deadline,
        () => new MateriosConnectionError("connect-timeout", timeoutMs));
    } finally {
      await api.disconnect();
    }
  }

  getApi(): ApiPromise {
    if (!this.api) throw new Error("Not connected. Call connect() first.");
    return this.api;
  }

  getKeypair(): KeyringPair {
    if (!this.keypair) throw new Error("Not connected. Call connect() first.");
    return this.keypair;
  }
}
