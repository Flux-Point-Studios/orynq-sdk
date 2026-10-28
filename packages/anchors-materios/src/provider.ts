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

/** Node 22+ (undici) WebSocket reports a failed handshake as an ErrorEvent without any text. */
function connectFailure(error: unknown, rpcUrl: string): Error {
  if (error instanceof Error && error.message) return error;
  const event = error as { message?: unknown; error?: { message?: unknown } } | null | undefined;
  const text = [event?.message, event?.error?.message].find((value): value is string => typeof value === "string" && value !== "");
  return new Error(text ?? `WebSocket to ${rpcUrl} closed before opening; the runtime reported no reason`, { cause: error });
}

function aborted(signal: AbortSignal, timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new MateriosConnectionError("connect-aborted", timeoutMs));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function openApi(rpcUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<ApiPromise> {
  const api = new ApiPromise({ provider: new WsProvider(rpcUrl), throwOnConnect: true });
  try {
    await withinDeadline(() => signal ? Promise.race([api.isReadyOrError, aborted(signal, timeoutMs)]) : api.isReadyOrError,
      Date.now() + timeoutMs, () => new MateriosConnectionError("connect-timeout", timeoutMs));
    return api;
  } catch (cause) {
    await api.disconnect();
    if (cause instanceof MateriosConnectionError) throw cause;
    throw new MateriosConnectionError("connect-failed", timeoutMs, { cause: connectFailure(cause, rpcUrl) });
  }
}

/** Resolves on the API's next "connected" event; rejects with `timedOut()` at the deadline. */
function reconnected(api: ApiPromise, deadline: number, timedOut: () => Error): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      api.off("connected", onConnected);
      if (error) reject(error);
      else resolve();
    };
    const onConnected = () => finish();
    const timer = setTimeout(() => finish(timedOut()), Math.max(0, deadline - Date.now()));
    api.on("connected", onConnected);
  });
}

interface Opening {
  promise: Promise<void>;
  abort: AbortController;
}

export class MateriosProvider {
  private api: ApiPromise | null = null;
  private keypair: KeyringPair | null = null;
  private config: MateriosAnchorConfig;
  private connecting: Opening | null = null;
  private replacing: Opening | null = null;
  private unresponsive: ApiPromise | null = null;

  constructor(config: MateriosAnchorConfig) {
    this.config = config;
  }

  get inclusionTimeoutMs(): number {
    return this.config.inclusionTimeoutMs ?? 120_000;
  }

  private get connectTimeoutMs(): number {
    return this.config.connectTimeoutMs ?? 30_000;
  }

  async connect(opts: TimeoutOptions = {}): Promise<void> {
    if (this.api) return;
    const timeoutMs = timeoutBudget(opts.timeoutMs ?? this.connectTimeoutMs);
    this.connecting ??= this.open(async signal => {
      const api = await openApi(this.config.rpcUrl, timeoutMs, signal);
      try {
        this.keypair = new Keyring({ type: "sr25519" }).addFromUri(this.config.signerUri);
      } catch (error) {
        await api.disconnect();
        throw error;
      }
      this.api = api;
    }, () => { this.connecting = null; });
    const { promise } = this.connecting;
    return withinDeadline(() => promise, Date.now() + timeoutMs, () => new MateriosConnectionError("connect-timeout", timeoutMs));
  }

  /** Aborts a connect or replacement in flight (its caller gets `connect-aborted`) and closes the connection. */
  async disconnect(): Promise<void> {
    const pending = [this.connecting, this.replacing].filter((opening): opening is Opening => opening !== null);
    for (const opening of pending) opening.abort.abort();
    await Promise.allSettled(pending.map(opening => opening.promise));
    const api = this.api;
    this.api = null;
    this.keypair = null;
    this.unresponsive = null;
    await api?.disconnect();
  }

  /** Records that `api` stopped answering a read or a transaction watch; the next `connection()` replaces it. */
  markUnresponsive(api: ApiPromise): void {
    if (this.api === api) this.unresponsive = api;
  }

  /**
   * The main connection for a submission or poll. Replaces it when marked unresponsive, since an
   * open socket that stopped answering is never reopened by polkadot.js, and waits for an
   * automatic reconnect in progress. Both waits end at `deadline`.
   */
  async connection(deadline: number): Promise<ApiPromise> {
    const api = this.getApi();
    const budgetMs = Math.max(0, deadline - Date.now());
    const timedOut = () => new MateriosConnectionError("connect-timeout", budgetMs);
    if (this.unresponsive === api) {
      this.replacing ??= this.open(signal => this.replace(api, signal), () => { this.replacing = null; });
      const { promise } = this.replacing;
      await withinDeadline(() => promise, deadline, timedOut);
    } else if (!api.isConnected) {
      await reconnected(api, deadline, timedOut);
    }
    return this.getApi();
  }

  /** An isolated connection for storage reads, checked against `genesis`; the caller disconnects it. */
  async openReader(genesis: string, deadline: number): Promise<ApiPromise> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new MateriosConnectionError("connect-timeout", 0);
    const api = await openApi(this.config.rpcUrl, Math.min(remaining, this.connectTimeoutMs));
    if (api.genesisHash.toHex() !== genesis) {
      await api.disconnect();
      throw new Error("Recovery endpoint returned a different genesis hash");
    }
    return api;
  }

  getApi(): ApiPromise {
    if (!this.api) throw new Error("Not connected. Call connect() first.");
    return this.api;
  }

  getKeypair(): KeyringPair {
    if (!this.keypair) throw new Error("Not connected. Call connect() first.");
    return this.keypair;
  }

  private open(run: (signal: AbortSignal) => Promise<void>, done: () => void): Opening {
    const abort = new AbortController();
    return { abort, promise: run(abort.signal).finally(done) };
  }

  private async replace(stale: ApiPromise, signal: AbortSignal): Promise<void> {
    const fresh = await openApi(this.config.rpcUrl, this.connectTimeoutMs, signal);
    if (this.api !== stale) {
      await fresh.disconnect();
      return;
    }
    this.api = fresh;
    this.unresponsive = null;
    await stale.disconnect();
  }
}
