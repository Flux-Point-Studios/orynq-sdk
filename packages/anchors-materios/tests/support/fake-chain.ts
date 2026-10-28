import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { expect, vi } from "vitest";

/** ApiPromise instances handed out, in order, by the mocked constructor. */
export const mocks = { apis: [] as FakeApi[], sockets: [] as unknown[] };

/** Module body for `vi.mock("@polkadot/api", ...)`. */
export function polkadotApiMock() {
  return {
    WsProvider: class extends EventEmitter {
      disconnect = vi.fn(async () => { this.removeAllListeners(); });
      constructor() { super(); mocks.sockets.push(this); }
    },
    ApiPromise: class {
      constructor() {
        const api = mocks.apis.shift();
        if (!api) throw new Error("No fake ApiPromise queued for this connection");
        return api;
      }
    },
    Keyring: class { addFromUri() { return { address: SIGNER }; } },
  };
}

export const hash = (byte: string) => `0x${byte.repeat(64)}`;
export const SIGNER = "5FixtureSigner";
export const ZERO = hash("0");
export const txHash = hash("c");
export const input = { contentHash: hash("1"), rootHash: hash("2"), manifestHash: hash("3") };
export const entry = { type: "custom" as const, version: "1.0" as const, ...input, timestamp: "2026-10-27T00:00:00Z" };
export const never = () => new Promise<never>(() => {});
const sha256 = (hex: string) => "0x" + createHash("sha256").update(Buffer.from(hex.replace(/^0x/, ""), "hex")).digest("hex");
export const receiptId = sha256(input.contentHash);
export const anchorId = sha256(input.rootHash.slice(2) + input.manifestHash.slice(2));

/** Block hashes encode their number so `at(hash)` can find the state they name. */
export const blockHashOf = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const toText = (value: unknown) => typeof value === "string" ? value : (value as { toHex(): string }).toHex();

/** The record the pallet stores for a receipt submitted by this SDK. */
export const receiptRecord = (overrides: Record<string, unknown> = {}, of = input) => ({
  schemaHash: ZERO, contentHash: of.contentHash, baseRootSha256: of.rootHash, zkRootPoseidon: null,
  poseidonParamsHash: null, baseManifestHash: of.manifestHash, safetyManifestHash: ZERO, monitorConfigHash: ZERO,
  attestationEvidenceHash: ZERO, storageLocatorHash: ZERO, availabilityCertHash: ZERO, createdAtMillis: 1,
  submitter: SIGNER, ...overrides,
});
export const receiptIdOf = (of: { contentHash: string }) => sha256(of.contentHash);

const bytesHex = (bytes: unknown) => "0x" + Buffer.from(bytes as number[]).toString("hex");
/** The record the pallet would store for one `orinqReceipts.submitReceipt(...)` call. */
export function recordFromCall(args: unknown[]) {
  const [id, contentHash, root, zk, params, manifest, safety, monitor, evidence, locator, schema] = args;
  return {
    id: String(id),
    json: {
      schemaHash: bytesHex(schema), contentHash, baseRootSha256: bytesHex(root), zkRootPoseidon: zk, poseidonParamsHash: params,
      baseManifestHash: bytesHex(manifest), safetyManifestHash: bytesHex(safety), monitorConfigHash: bytesHex(monitor),
      attestationEvidenceHash: bytesHex(evidence), storageLocatorHash: bytesHex(locator), availabilityCertHash: ZERO,
      createdAtMillis: 1, submitter: SIGNER,
    },
  };
}
export const anchorRecord = (overrides: Record<string, unknown> = {}) => ({
  contentHash: sha256(input.rootHash), rootHash: input.rootHash, manifestHash: input.manifestHash,
  createdAtMillis: 1, submitter: SIGNER, ...overrides,
});

const option = (json: Record<string, unknown> | undefined) =>
  json ? { isEmpty: false, toJSON: () => json } : { isEmpty: true, toJSON: () => null };

type Stored = { from: number; json: Record<string, unknown> };
type Placement = { id?: string; from?: number };

export interface Chain {
  base: number;
  blockMs: number;
  finalityLag: number;
  readonly best: number;
  readonly finalized: number;
  nonce: number;
  nonceBumpAt: number;
  recordAt(item: "receipts" | "anchors", id: string, n: number): ReturnType<typeof option>;
  nonceAt(n: number): number;
  storeReceipt(json?: Record<string, unknown>, placement?: Placement): void;
  storeAnchor(json?: Record<string, unknown>, placement?: Placement): void;
}

/**
 * One chain behind every fake connection. Blocks advance with fake time when `blockMs` is set;
 * a record is visible from the block it is stored at; the signer's nonce rises at `nonceBumpAt`.
 */
export function makeChain(): Chain {
  const start = Date.now();
  const storage = { receipts: new Map<string, Stored>(), anchors: new Map<string, Stored>() };
  const chain: Chain = {
    base: 42,
    blockMs: Infinity,
    finalityLag: 0,
    get best(): number {
      return chain.base + (Number.isFinite(chain.blockMs) ? Math.floor((Date.now() - start) / chain.blockMs) : 0);
    },
    get finalized(): number { return chain.best - chain.finalityLag; },
    nonce: 7,
    nonceBumpAt: Infinity,
    recordAt(item: keyof typeof storage, id: string, n: number) {
      const stored = storage[item].get(id.toLowerCase());
      return option(stored && n >= stored.from ? stored.json : undefined);
    },
    nonceAt: (n: number) => n >= chain.nonceBumpAt ? chain.nonce + 1 : chain.nonce,
    storeReceipt(json = receiptRecord(), { id = receiptId, from = chain.best } = {}) {
      storage.receipts.set(id.toLowerCase(), { from, json });
    },
    storeAnchor(json = anchorRecord(), { id = anchorId, from = chain.finalized } = {}) {
      storage.anchors.set(id.toLowerCase(), { from, json });
    },
  };
  return chain;
}

/** A polkadot.js MortalEra signed at block 42 with period 64: includable up to block 105. */
export const era = {
  isMortalEra: true,
  asMortalEra: {
    birth: (current: number) => Math.floor((Math.max(current, 42) - 42) / 64) * 64 + 42,
    death: (current: number) => era.asMortalEra.birth(current) + 64,
  },
};

export function fixture(chain: Chain) {
  let callback: (result: unknown) => void = () => {};
  const unsubscribe = vi.fn();
  /** Like polkadot.js, a request on a closed socket fails before anything is sent. */
  const live = <A extends unknown[], R>(fn: (...args: A) => R) => vi.fn(async (...args: A): Promise<Awaited<R>> => {
    if (!api.isConnected) throw new Error("WebSocket is not connected");
    return await fn(...args);
  });
  const signed = {
    hash: { toHex: () => txHash }, nonce: { toNumber: () => 7 }, era, toHex: () => "0x00",
    send: live((cb: typeof callback): (() => void) => { callback = cb; return unsubscribe; }),
  };
  const tx = {
    signAsync: live((): typeof signed => signed),
    signAndSend: vi.fn((_signer: unknown, cb: typeof callback) => signed.send(cb)),
  };
  const numberOf = (at: unknown) => {
    const text = toText(at);
    return text.startsWith("0x000000") ? Number.parseInt(text, 16) : chain.best;
  };
  const header = (n: number, hashText = blockHashOf(n)) => ({ hash: { toHex: () => hashText }, number: { toNumber: () => n } });
  const api = Object.assign(new EventEmitter(), {
    isConnected: true,
    isReadyOrError: Promise.resolve() as Promise<unknown>,
    disconnect: vi.fn(async () => { api.isConnected = false; }),
    genesisHash: { toHex: () => hash("f") },
    tx: { orinqReceipts: { submitReceipt: vi.fn(() => tx), submitAnchor: vi.fn(() => tx) } },
    rpc: {
      system: { dryRun: live((_hex: string): unknown => ({ isErr: false, asOk: { isErr: false } })) },
      chain: {
        getHeader: live((at?: unknown) => at === undefined ? header(chain.best) : header(numberOf(at), toText(at))),
        getFinalizedHead: live(() => ({ toHex: () => blockHashOf(chain.finalized) })),
      },
    },
    query: {
      orinqReceipts: {
        receipts: live((id: string, at: number = chain.best): unknown => chain.recordAt("receipts", id, at)),
        anchors: live((id: string, at: number = chain.best): unknown => chain.recordAt("anchors", id, at)),
      },
      system: {
        account: live((_who: string, at: number = chain.best) => ({ nonce: { toNumber: () => chain.nonceAt(at) } })),
      },
    },
    registry: {
      findMetaError: vi.fn((_: unknown) => ({ section: "orinqReceipts", name: "Rejected", docs: ["fixture"] })),
    },
    at: vi.fn(async (at: unknown) => {
      const n = numberOf(at);
      return {
        query: {
          orinqReceipts: {
            receipts: (id: string) => api.query.orinqReceipts.receipts(id, n),
            anchors: (id: string) => api.query.orinqReceipts.anchors(id, n),
          },
          system: { account: (who: string) => api.query.system.account(who, n) },
        },
      };
    }),
  });
  return {
    api, signed, tx, unsubscribe,
    emit: (result: unknown) => callback(result),
    drop: () => { api.isConnected = false; api.emit("disconnected"); },
    reconnect: () => { api.isConnected = true; api.emit("connected"); },
  };
}
export type Fixture = ReturnType<typeof fixture>;
export type FakeApi = Fixture["api"];

/** Watch results as polkadot.js reports them once it has read the inclusion block's events. */
export const inBlock = (blockHash: string, extra: Record<string, unknown> = {}) =>
  ({ status: { isInBlock: true, asInBlock: { toHex: () => blockHash } }, blockNumber: { toNumber: () => 42 }, ...extra });
export const finalized = (blockHash: string, extra: Record<string, unknown> = {}) =>
  ({ status: { isInBlock: false, isFinalized: true, asFinalized: { toHex: () => blockHash } }, blockNumber: { toNumber: () => 42 }, ...extra });

/** A JSON-RPC refusal shaped like polkadot.js RpcError. */
export const rpcError = (code: number, message: string) => Object.assign(new Error(`${code}: ${message}`), { code });
export const PRIORITY_TOO_LOW = "Priority is too low: (0 vs 0): The transaction has too low priority to replace another transaction already in the pool.";

/**
 * A provider connected to the first fake; `spares` more fakes on the same chain serve the
 * connections it opens later (recovery readers, replacements), in order.
 */
export async function connected(options: { spares?: number; chain?: Chain } = {}) {
  const { MateriosProvider } = await import("../../src/provider.js");
  const chain = options.chain ?? makeChain();
  const main = fixture(chain);
  const spares = Array.from({ length: options.spares ?? 1 }, () => fixture(chain));
  mocks.apis.push(main.api, ...spares.map(spare => spare.api));
  const provider = new MateriosProvider({ rpcUrl: "ws://fixture.invalid", signerUri: "fixture", connectTimeoutMs: 40 });
  await provider.connect();
  return { ...main, chain, spares, recovery: spares[0]!, provider };
}

/** Runs `promise` for `windowMs` of fake time (after `action`) and requires it to have settled. */
export async function observe(promise: Promise<unknown>, action?: () => void, windowMs = 201) {
  let outcome: { pending?: true; value?: any; error?: any } = { pending: true };
  promise.then(value => { outcome = { value }; }, error => { outcome = { error }; });
  await vi.advanceTimersByTimeAsync(0);
  action?.();
  await vi.advanceTimersByTimeAsync(windowMs);
  expect(outcome, `caller still pending after ${windowMs} ms of fake time`).not.toEqual({ pending: true });
  return outcome;
}
