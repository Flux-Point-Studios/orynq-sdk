import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MateriosProvider } from "../src/provider.js";
import { submitReceipt } from "../src/receipt.js";
import { submitAnchor } from "../src/submitter.js";

const mocks = vi.hoisted(() => ({ apis: [] as any[], sockets: [] as any[] }));
vi.mock("@polkadot/api", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    WsProvider: class extends EventEmitter {
      disconnect = vi.fn(async () => { this.removeAllListeners(); });
      constructor() { super(); mocks.sockets.push(this); }
    },
    ApiPromise: class {
      constructor() { return mocks.apis.shift(); }
      static async create() { const api = mocks.apis.shift(); await api.isReadyOrError; return api; }
    },
    Keyring: class { addFromUri() { return { address: "fixture" }; } },
  };
});

const hash = (byte: string) => `0x${byte.repeat(64)}`;
const blockHash = hash("b");
const txHash = hash("c");
const input = { contentHash: hash("1"), rootHash: hash("2"), manifestHash: hash("3") };
const entry = { type: "custom" as const, version: "1.0" as const, ...input, timestamp: "2026-10-27T00:00:00Z" };
const never = () => new Promise<any>(() => {});
const stored = () => ({ isEmpty: false, toJSON: () => ({ contentHash: input.contentHash, baseRootSha256: input.rootHash, baseManifestHash: input.manifestHash, schemaHash: hash("0") }) });

function fixture() {
  let callback: (result: any) => void = () => {};
  const unsubscribe = vi.fn();
  const signed = { hash: { toHex: () => txHash }, toHex: () => "0x00", send: vi.fn(async (cb: typeof callback) => { callback = cb; return unsubscribe; }) };
  const tx = { signAsync: vi.fn(async () => signed), signAndSend: vi.fn(async (_key: unknown, cb: typeof callback) => { callback = cb; return unsubscribe; }) };
  const api = Object.assign(new EventEmitter(), {
    isConnected: true,
    isReadyOrError: Promise.resolve(),
    disconnect: vi.fn(async () => { api.isConnected = false; }),
    genesisHash: { toHex: () => hash("f") },
    tx: { orinqReceipts: { submitReceipt: vi.fn(() => tx), submitAnchor: vi.fn(() => tx) } },
    rpc: {
      system: { dryRun: vi.fn(async () => ({ isErr: false, asOk: { isErr: false } })) },
      chain: {
        getHeader: vi.fn(async () => ({ hash: { toHex: () => blockHash }, number: { toNumber: () => 42 } })),
        getFinalizedHead: vi.fn(async () => ({ toHex: () => blockHash })),
      },
    },
    query: { orinqReceipts: { receipts: vi.fn(async () => stored()), anchors: vi.fn(async () => ({ isEmpty: true })) } },
    registry: { findMetaError: () => ({ section: "orinqReceipts", name: "Rejected", docs: ["fixture"] }) },
    at: vi.fn(async () => ({ query: api.query })),
  });
  return { api, signed, tx, unsubscribe, emit: (result: any) => callback(result), drop: () => { api.isConnected = false; api.emit("disconnected", { code: 1006 }); } };
}

async function connected() {
  const original = fixture();
  const recovery = fixture();
  mocks.apis.push(original.api, recovery.api);
  const provider = new MateriosProvider({ rpcUrl: "ws://fixture.invalid", signerUri: "fixture", connectTimeoutMs: 40 });
  await provider.connect();
  return { ...original, recovery, provider };
}

async function observe(promise: Promise<unknown>, action?: () => void) {
  let outcome: any = { pending: true };
  promise.then(value => { outcome = { value }; }, error => { outcome = { error }; });
  await vi.advanceTimersByTimeAsync(0);
  action?.();
  await vi.advanceTimersByTimeAsync(201);
  expect(outcome, "caller still pending beyond its 100 ms budget (bounded observation: 201 ms)").not.toEqual({ pending: true });
  return outcome;
}

beforeEach(() => { vi.useFakeTimers(); mocks.apis.length = 0; mocks.sockets.length = 0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Materios RPC deadlines", () => {
  it("bounds a connection whose provider accepts but never answers", async () => {
    const f = fixture();
    f.api.isReadyOrError = never();
    mocks.apis.push(f.api);
    const provider = new MateriosProvider({ rpcUrl: "ws://fixture.invalid", signerUri: "fixture", connectTimeoutMs: 100 });
    const { error } = await observe(provider.connect());
    expect(error).toMatchObject({ name: "MateriosConnectionError", code: "connect-timeout", timeoutMs: 100 });
    expect(f.api.disconnect).toHaveBeenCalledOnce();
    expect(() => provider.getApi()).toThrow("Not connected");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconciles a receipt that landed after the acknowledged watch drops with 1006", async () => {
    const f = await connected();
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), f.drop);
    expect(value).toMatchObject({ confirmed: true, status: "submitted", reconciled: true, txHash });
    expect(f.recovery.api.query.orinqReceipts.receipts).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.api.listenerCount("disconnected")).toBe(0);
    expect(f.recovery.api.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not call an absent receipt safe to resubmit while the transaction may be pending", async () => {
    const f = await connected();
    f.recovery.api.query.orinqReceipts.receipts.mockResolvedValue({ isEmpty: true } as any);
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), f.drop);
    expect(error).toMatchObject({ name: "MateriosSubmissionError", code: "inclusion-unknown", safeToResubmit: false });
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds unreadable reconciliation storage", async () => {
    const f = await connected();
    f.recovery.api.query.orinqReceipts.receipts.mockImplementation(never);
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), f.drop);
    expect(error).toMatchObject({ code: "inclusion-unknown", safeToResubmit: false });
    expect(f.recovery.api.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds signAndSend after an acknowledged watch drops", async () => {
    const f = await connected();
    const { error } = await observe(submitAnchor(f.provider, entry, { timeoutMs: 100 }), f.drop);
    expect(error).toMatchObject({ name: "MateriosSubmissionError", code: "inclusion-unknown", safeToResubmit: false });
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.api.listenerCount("disconnected")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconciles a silent watch before the total deadline expires", async () => {
    const f = await connected();
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(value).toMatchObject({ confirmed: true, reconciled: true });
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["sign", "dryRun"])("bounds a stuck %s before broadcasting and permits a safe retry", async stage => {
    const f = await connected();
    if (stage === "sign") f.tx.signAsync.mockImplementation(never);
    else f.api.rpc.system.dryRun.mockImplementation(never);
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "not-landed", safeToResubmit: true });
    expect(f.signed.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an unrelated receipt at a caller-supplied id even on the inBlock path", async () => {
    const f = await connected();
    const unrelated = { isEmpty: false, toJSON: () => ({ ...stored().toJSON(), contentHash: hash("9") }) };
    f.api.query.orinqReceipts.receipts.mockResolvedValue(unrelated);
    f.recovery.api.query.orinqReceipts.receipts.mockResolvedValue(unrelated);
    const { error } = await observe(submitReceipt(f.provider, { ...input, receiptId: hash("a") }, { timeoutMs: 100 }),
      () => f.emit({ status: { isInBlock: true, asInBlock: { toHex: () => blockHash } } }));
    expect(error).toMatchObject({ code: "inclusion-unknown", safeToResubmit: false });
  });

  it("keeps the successful receipt result shape and releases the watch", async () => {
    const f = await connected();
    const { value } = await observe(submitReceipt(f.provider, { ...input, receiptId: hash("a") }, { timeoutMs: 100 }),
      () => f.emit({ status: { isInBlock: true, asInBlock: { toHex: () => blockHash } } }));
    expect(value).toEqual({ receiptId: hash("a"), blockHash, blockNumber: 42, txHash, confirmed: true, status: "submitted" });
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.api.listenerCount("disconnected")).toBe(0);
    expect(mocks.apis).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("cleans up synchronous dispatch callbacks (module=%s) before the unsubscribe handle arrives", async isModule => {
    const f = await connected();
    let release: (unsub: () => void) => void = () => {};
    f.signed.send.mockImplementation(cb => {
      cb({ dispatchError: { isModule, asModule: {}, toString: () => "bad origin" } });
      return new Promise(resolve => { release = resolve; });
    });
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "dispatch", safeToResubmit: false });
    release(f.unsubscribe);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.api.listenerCount("disconnected")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases an unsubscribe handle arriving after recovery has settled", async () => {
    const f = await connected();
    let release: (unsub: () => void) => void = () => {};
    f.signed.send.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), f.drop);
    expect(value.confirmed).toBe(true);
    release(f.unsubscribe);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns an anchor only after finalized storage confirms the payload", async () => {
    const f = await connected();
    const { createHash } = await import("node:crypto");
    f.recovery.api.query.orinqReceipts.anchors.mockResolvedValue({ isEmpty: false, toJSON: () => ({
      contentHash: "0x" + createHash("sha256").update(Buffer.from(input.rootHash.slice(2), "hex")).digest("hex"),
      rootHash: input.rootHash, manifestHash: input.manifestHash,
    }) } as any);
    const { value } = await observe(submitAnchor(f.provider, entry, { timeoutMs: 100 }), f.drop);
    expect(value).toMatchObject({ reconciled: true, blockHash, rootHash: input.rootHash });
    expect(f.recovery.api.rpc.chain.getFinalizedHead).toHaveBeenCalledOnce();
    expect(f.recovery.api.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps the happy finalized anchor result and ignores later disconnects", async () => {
    const f = await connected();
    const { value } = await observe(submitAnchor(f.provider, entry, { timeoutMs: 100 }),
      () => f.emit({ status: { isFinalized: true, asFinalized: { toHex: () => blockHash } } }));
    expect(value).toMatchObject({ blockHash, rootHash: input.rootHash, manifestHash: input.manifestHash });
    expect(value).not.toHaveProperty("reconciled");
    f.drop();
    expect(mocks.apis).toHaveLength(1);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not broadcast when a timed-out signer later resolves", async () => {
    const f = await connected();
    let release: (signed: typeof f.signed) => void = () => {};
    f.tx.signAsync.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(error.safeToResubmit).toBe(true);
    release(f.signed);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.signed.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a late recovery header from launching new queries after the budget", async () => {
    const f = await connected();
    let release: (header: any) => void = () => {};
    f.recovery.api.rpc.chain.getHeader.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), f.drop);
    expect(error.code).toBe("inclusion-unknown");
    release({ hash: { toHex: () => blockHash }, number: { toNumber: () => 42 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.recovery.api.at).not.toHaveBeenCalled();
    expect(f.recovery.api.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects recovery from a different chain", async () => {
    const f = await connected();
    f.recovery.api.genesisHash = { toHex: () => hash("d") };
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), f.drop);
    expect(error.code).toBe("inclusion-unknown");
    expect(f.recovery.api.query.orinqReceipts.receipts).not.toHaveBeenCalled();
    expect(f.recovery.api.disconnect).toHaveBeenCalledOnce();
  });

  it.each([0, -1, NaN, Infinity, 2 ** 31])("rejects an invalid timeout %s without opening a socket", async timeoutMs => {
    const provider = new MateriosProvider({ rpcUrl: "ws://fixture.invalid", signerUri: "fixture" });
    await expect(provider.connect({ timeoutMs })).rejects.toThrow(RangeError);
    expect(mocks.sockets).toHaveLength(0);
  });

  it("honors the timeout of a concurrent connect caller", async () => {
    const f = fixture();
    f.api.isReadyOrError = never();
    mocks.apis.push(f.api);
    const provider = new MateriosProvider({ rpcUrl: "ws://fixture.invalid", signerUri: "fixture", connectTimeoutMs: 1000 });
    const first = provider.connect().catch(error => error);
    const { error } = await observe(provider.connect({ timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "connect-timeout", timeoutMs: 100 });
    expect(mocks.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect(f.api.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the 30-second connect default without activating the legacy timeout field", async () => {
    const f = fixture();
    f.api.isReadyOrError = never();
    mocks.apis.push(f.api);
    const provider = new MateriosProvider({ rpcUrl: "ws://fixture.invalid", signerUri: "fixture", timeout: 1 });
    let error: any;
    const pending = provider.connect().catch(value => { error = value; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(error).toMatchObject({ code: "connect-timeout", timeoutMs: 30_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the default 120-second submission budget with 30 seconds reserved for recovery", async () => {
    const f = await connected();
    let value: any;
    const pending = submitReceipt(f.provider, input).then(result => { value = result; });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(value).toMatchObject({ confirmed: true, reconciled: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves dispatch failures detected by the dry-run", async () => {
    const f = await connected();
    f.api.rpc.system.dryRun.mockResolvedValue({ isErr: false, asOk: { isErr: true, asErr: { isModule: true, asModule: {} } } } as any);
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "dispatch", safeToResubmit: false });
    expect(error.message).toContain("orinqReceipts.Rejected");
    expect(f.signed.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports an RPC failure while signing as not-landed", async () => {
    const f = await connected();
    f.tx.signAsync.mockRejectedValue(new Error("Disconnected"));
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "not-landed", safeToResubmit: true });
    expect(f.signed.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a recovery connection that never becomes ready", async () => {
    const f = await connected();
    f.recovery.api.isReadyOrError = never();
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), f.drop);
    expect(error).toMatchObject({ code: "inclusion-unknown", safeToResubmit: false });
    expect(f.recovery.api.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["reject", "isInvalid", "isDropped", "isUsurped", "isFinalityTimeout"])("reconciles an interrupted %s watch", async mode => {
    const f = await connected();
    if (mode === "reject") f.signed.send.mockRejectedValue(new Error("transport dropped"));
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }),
      mode === "reject" ? undefined : () => f.emit({ status: { [mode]: true } }));
    expect(value).toMatchObject({ confirmed: true, reconciled: true });
    expect(f.api.listenerCount("disconnected")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
