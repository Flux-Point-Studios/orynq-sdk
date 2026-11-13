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

/** Node's built-in WebSocket (undici) reports a failed handshake as an ErrorEvent without any text. */
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

/** The provider's one recovery connection, shared by every poll that holds a lease. */
interface Reader {
  opening: Promise<ApiPromise>;
  abort: AbortController;
  /** Set once the connection is open. */
  api?: ApiPromise;
}

/** One poll's hold on the provider's shared recovery reader. */
export interface ReaderLease {
  /** Aborted by `disconnect()`: the poll must stop. */
  readonly signal: AbortSignal;
  /**
   * The shared reader, opened when there is none and checked against the lease's genesis hash.
   * Rejects with `connect-aborted` once `disconnect()` was called.
   */
  api(deadline: number): Promise<ApiPromise>;
  /** Closes the shared reader if it still is `api`, so the next `api()` opens a fresh one for every lease. */
  discard(api: ApiPromise): Promise<void>;
  /** Ends the lease; the reader is closed with its last lease. */
  release(): Promise<void>;
}

export class MateriosProvider {
  private api: ApiPromise | null = null;
  private keypair: KeyringPair | null = null;
  private config: MateriosAnchorConfig;
  private connecting: Opening | null = null;
  private replacing: Opening | null = null;
  private unresponsive: ApiPromise | null = null;
  private reader: Reader | null = null;
  private leases = 0;
  /** Aborted and renewed by `disconnect()`; polls started before it stop. */
  private session = new AbortController();

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

  /**
   * Aborts a connect or replacement in flight (its caller gets `connect-aborted`), ends every
   * recovery poll and its reader, and closes the connection.
   */
  async disconnect(): Promise<void> {
    this.session.abort();
    this.session = new AbortController();
    await this.closeReader();
    const pending = [this.connecting, this.replacing].filter((opening): opening is Opening => opening !== null);
    for (const opening of pending) opening.abort.abort();
    await Promise.allSettled(pending.map(opening => opening.promise));
    const api = this.api;
    this.api = null;
    this.keypair = null;
    this.unresponsive = null;
    await api?.disconnect();
  }

  /**
   * Records that `api` did not answer: a read or preparation step got no reply, or a transaction
   * watch saw neither a reply nor a status. The next `connection()` replaces it, which cuts every
   * watch still open on it, so a watch that merely outlasted its window must not mark it.
   */
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

  /**
   * A lease on the provider's recovery reader: one connection, isolated from the main one, that
   * every poll of this provider shares for storage reads on the chain with `genesis`. It is opened
   * by the first `api()` and closed with the last lease, or by `disconnect()`.
   */
  leaseReader(genesis: string): ReaderLease {
    const { signal } = this.session;
    this.leases++;
    let released = false;
    return {
      signal,
      api: async deadline => {
        const remaining = deadline - Date.now();
        if (signal.aborted) throw new MateriosConnectionError("connect-aborted", Math.max(0, remaining));
        if (remaining <= 0) throw new MateriosConnectionError("connect-timeout", 0);
        const reader = this.reader ??= this.openReader(Math.min(remaining, this.connectTimeoutMs));
        const api = await withinDeadline(() => reader.opening, deadline, () => new MateriosConnectionError("connect-timeout", remaining), signal);
        if (api.genesisHash.toHex() !== genesis) {
          await this.closeReader(reader);
          throw new Error("Recovery endpoint returned a different genesis hash");
        }
        return api;
      },
      discard: async api => {
        if (this.reader?.api === api) await this.closeReader(this.reader);
      },
      release: async () => {
        if (released) return;
        released = true;
        if (--this.leases === 0) await this.closeReader();
      },
    };
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

  private openReader(timeoutMs: number): Reader {
    const abort = new AbortController();
    const opening = openApi(this.config.rpcUrl, timeoutMs, abort.signal).then(
      api => { reader.api = api; return api; },
      error => {
        if (this.reader === reader) this.reader = null;
        throw error;
      });
    const reader: Reader = { opening, abort };
    // Every lease waiting for it sees the failure; without one, it must not go unhandled.
    opening.catch(() => {});
    return reader;
  }

  /** Closes the shared reader (only `only`, when given), aborting it if it is still opening. */
  private async closeReader(only?: Reader): Promise<void> {
    const reader = this.reader;
    if (!reader || (only && reader !== only)) return;
    this.reader = null;
    reader.abort.abort();
    const api = await reader.opening.catch(() => undefined);
    await api?.disconnect();
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
