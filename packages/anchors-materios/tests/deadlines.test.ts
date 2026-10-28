import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MateriosProvider } from "../src/provider.js";
import { submitReceipt } from "../src/receipt.js";
import { submitAnchor } from "../src/submitter.js";
import {
  blockHashOf, connected, entry, finalized, fixture, hash, inBlock, input, makeChain, mocks, never, observe, receiptRecord,
  txHash,
} from "./support/fake-chain.js";

vi.mock("@polkadot/api", async () => (await import("./support/fake-chain.js")).polkadotApiMock());

const blockHash = hash("b");

beforeEach(() => { vi.useFakeTimers(); mocks.apis.length = 0; mocks.sockets.length = 0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Materios RPC deadlines", () => {
  it("bounds a connection whose provider accepts but never answers", async () => {
    const f = fixture(makeChain());
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
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), () => { f.chain.storeReceipt(); f.drop(); });
    expect(value).toMatchObject({ confirmed: true, status: "submitted", reconciled: true, txHash });
    expect(f.recovery.api.query.orinqReceipts.receipts).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.api.listenerCount("disconnected")).toBe(0);
    expect(f.recovery.api.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not call an absent receipt safe to resubmit while the transaction may be pending", async () => {
    const f = await connected();
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

  it("bounds an anchor watch that drops after acknowledgement", async () => {
    const f = await connected();
    const { error } = await observe(submitAnchor(f.provider, entry, { timeoutMs: 100 }), f.drop);
    expect(error).toMatchObject({ name: "MateriosSubmissionError", code: "inclusion-unknown", safeToResubmit: false });
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.api.listenerCount("disconnected")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconciles a silent watch before the total deadline expires", async () => {
    const f = await connected();
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), () => f.chain.storeReceipt());
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

  it("refuses to broadcast over an unrelated receipt stored at a caller-supplied id", async () => {
    const f = await connected();
    f.chain.storeReceipt(receiptRecord({ contentHash: hash("9") }), { id: hash("a") });
    const { error } = await observe(submitReceipt(f.provider, { ...input, receiptId: hash("a") }, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "dispatch", id: hash("a"), safeToResubmit: false });
    expect(f.signed.send).not.toHaveBeenCalled();
  });

  it("does not accept an unrelated receipt that appears after the inBlock status", async () => {
    const f = await connected();
    const { error } = await observe(submitReceipt(f.provider, { ...input, receiptId: hash("a") }, { timeoutMs: 100 }), () => {
      f.chain.storeReceipt(receiptRecord({ contentHash: hash("9") }), { id: hash("a") });
      f.emit(inBlock(blockHash));
    });
    expect(error).toMatchObject({ code: "inclusion-unknown", safeToResubmit: false });
  });

  it("keeps the successful receipt result shape and releases the watch", async () => {
    const f = await connected();
    const { value } = await observe(submitReceipt(f.provider, { ...input, receiptId: hash("a") }, { timeoutMs: 100 }), () => {
      f.chain.storeReceipt(receiptRecord(), { id: hash("a") });
      f.emit(inBlock(blockHash));
    });
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
      cb(inBlock(blockHash, { dispatchError: { isModule, asModule: {}, toString: () => "bad origin" } }));
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
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), () => { f.chain.storeReceipt(); f.drop(); });
    expect(value.confirmed).toBe(true);
    release(f.unsubscribe);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns an anchor only after finalized storage confirms the payload", async () => {
    const f = await connected();
    const { value } = await observe(submitAnchor(f.provider, entry, { timeoutMs: 100 }), () => { f.chain.storeAnchor(); f.drop(); });
    expect(value).toMatchObject({ reconciled: true, blockHash: blockHashOf(42), rootHash: input.rootHash });
    expect(f.recovery.api.rpc.chain.getFinalizedHead).toHaveBeenCalledOnce();
    expect(f.recovery.api.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps the happy finalized anchor result and ignores later disconnects", async () => {
    const f = await connected();
    const { value } = await observe(submitAnchor(f.provider, entry, { timeoutMs: 100 }), () => f.emit(finalized(blockHash)));
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
    let release: (header: { hash: { toHex(): string }; number: { toNumber(): number } }) => void = () => {};
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
    const f = fixture(makeChain());
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
    const f = fixture(makeChain());
    f.api.isReadyOrError = never();
    mocks.apis.push(f.api);
    const provider = new MateriosProvider({ rpcUrl: "ws://fixture.invalid", signerUri: "fixture", timeout: 1 });
    let error: unknown;
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
    let value: unknown;
    const pending = submitReceipt(f.provider, input).then(result => { value = result; });
    await vi.advanceTimersByTimeAsync(0);
    f.chain.storeReceipt();
    await vi.advanceTimersByTimeAsync(89_999);
    expect(value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(value).toMatchObject({ confirmed: true, reconciled: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves dispatch failures detected by the dry-run", async () => {
    const f = await connected();
    f.api.rpc.system.dryRun.mockResolvedValue({ isErr: false, asOk: { isErr: true, asErr: { isModule: true, asModule: {} } } });
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
    if (mode === "reject") {
      f.signed.send.mockImplementation(async () => { f.chain.storeReceipt(); throw new Error("transport dropped"); });
    }
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }),
      mode === "reject" ? undefined : () => { f.chain.storeReceipt(); f.emit({ status: { [mode]: true, type: mode.slice(2) } }); });
    expect(value).toMatchObject({ confirmed: true, reconciled: true });
    expect(f.api.listenerCount("disconnected")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
