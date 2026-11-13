/**
 * Liveness and hardening follow-ups from the #211 review (#213). None of these changes a result
 * label; they bound how long a truthful label takes and how many sockets it costs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "../src/index.js";
import { submitReceipt } from "../src/receipt.js";
import { submitAnchor } from "../src/submitter.js";
import {
  PRIORITY_TOO_LOW, SIGNER, blockHashOf, connected, entry, hash, inBlock, input, mocks, never, observe, receiptId,
  receiptIdOf, receiptRecord, rpcError, txHash,
} from "./support/fake-chain.js";

vi.mock("@polkadot/api", async () => (await import("./support/fake-chain.js")).polkadotApiMock());

const blockHash = hash("b");
const other = { contentHash: hash("4"), rootHash: hash("5"), manifestHash: hash("6") };

beforeEach(() => { vi.useFakeTimers(); mocks.apis.length = 0; mocks.sockets.length = 0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Fake time until `promise` settles, in `stepMs` steps up to `limitMs`; returns the settlement and when it came. */
async function settle(promise: Promise<unknown>, limitMs: number, stepMs = 100) {
  const start = Date.now();
  let outcome: { value?: any; error?: any; at?: number } | undefined;
  promise.then(value => { outcome = { value, at: Date.now() - start }; }, error => { outcome = { error, at: Date.now() - start }; });
  for (let waited = 0; outcome === undefined && waited <= limitMs; waited += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
  expect(outcome, `still pending after ${limitMs} ms of fake time`).toBeDefined();
  return outcome!;
}

describe("a watch that times out on a socket that carried traffic leaves the socket in place", () => {
  it.each([
    ["the node acknowledged the submission", (_f: Awaited<ReturnType<typeof connected>>) => {}],
    ["the pool reported a status", (f: Awaited<ReturnType<typeof connected>>) => f.emit({ status: { isReady: true, type: "Ready" } })],
  ])("keeps the main connection when %s but inclusion came after the watch window", async (_name, traffic) => {
    const f = await connected({ spares: 2 });
    const first = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), () => { traffic(f); f.chain.storeReceipt(); });
    expect(first.value).toMatchObject({ reconciled: true, confirmed: true });
    // The same socket serves the next call: nothing was replaced, so no other call's watch was cut.
    const { value } = await observe(submitReceipt(f.provider, other, { timeoutMs: 100 }), () => {
      f.chain.storeReceipt(receiptRecord({}, other), { id: receiptIdOf(other) });
      f.emit(inBlock(blockHash));
    });
    expect(value).toMatchObject({ receiptId: receiptIdOf(other), status: "submitted", txHash });
    expect(value).not.toHaveProperty("reconciled");
    expect(f.api.disconnect).not.toHaveBeenCalled();
    expect(f.provider.getApi()).toBe(f.api);
    expect(mocks.apis).toHaveLength(1);
  });

  it("keeps the main connection when a status arrives before the acknowledgement that never comes", async () => {
    const f = await connected({ spares: 2 });
    f.signed.send.mockImplementation(cb => { cb({ status: { isReady: true, type: "Ready" } }); return never(); });
    const first = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), () => f.chain.storeReceipt());
    expect(first.value).toMatchObject({ reconciled: true });
    await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(f.api.disconnect).not.toHaveBeenCalled();
    expect(f.provider.getApi()).toBe(f.api);
  });

  it("keeps an anchor's socket when finality is slower than the watch window", async () => {
    const f = await connected({ spares: 2 });
    const first = await observe(submitAnchor(f.provider, entry, { timeoutMs: 100 }), () => {
      f.emit(inBlock(blockHash));
      f.chain.storeAnchor();
    });
    expect(first.value).toMatchObject({ reconciled: true });
    await observe(submitAnchor(f.provider, entry, { timeoutMs: 100 }));
    expect(f.api.disconnect).not.toHaveBeenCalled();
    expect(f.provider.getApi()).toBe(f.api);
  });

  it("still replaces a socket whose watch saw neither a reply nor a status", async () => {
    const f = await connected({ spares: 2 });
    f.signed.send.mockImplementation(never);
    const first = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), () => f.chain.storeReceipt());
    expect(first.value).toMatchObject({ reconciled: true });
    await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(f.api.disconnect).toHaveBeenCalledOnce();
    expect(f.provider.getApi()).toBe(f.spares[1]!.api);
  });
});

describe("pool refusals", () => {
  it("reports 1016 (pool full) as not-landed at once, without opening a recovery reader", async () => {
    const f = await connected();
    const refusal = rpcError(1016, "Immediately Dropped: The transaction couldn't enter the pool because of the limit");
    f.signed.send.mockRejectedValue(refusal);
    const { error, at } = await settle(submitReceipt(f.provider, input), 1000, 1);
    expect(error).toMatchObject({ name: "MateriosSubmissionError", code: "not-landed", safeToResubmit: true, id: receiptId, txHash, nonce: 7 });
    expect(error.message).toBe(refusal.message);
    expect(error.cause).toBe(refusal);
    expect(at).toBeLessThan(5);
    expect(mocks.apis).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [1012, "Transaction is temporarily banned"],
    [1013, "Transaction Already Imported"],
  ])("keeps %i out of the refusal set: the transaction may be pooled or included, so storage decides", async (code, text) => {
    const f = await connected();
    const refusal = rpcError(code, text);
    f.signed.send.mockRejectedValue(refusal);
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "inclusion-unknown", safeToResubmit: false, cause: refusal });
    expect(f.recovery.api.query.orinqReceipts.receipts).toHaveBeenCalled();
  });

  it("reconciles a 1013 (already imported) submission once its record lands", async () => {
    const f = await connected();
    f.signed.send.mockImplementation(async () => { f.chain.storeReceipt(); throw rpcError(1013, "Transaction Already Imported"); });
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(value).toMatchObject({ reconciled: true, confirmed: true });
  });
});

describe("recovery shares one reader per provider", () => {
  it("opens one reader for two lost watches and closes it once, after the last one ends", async () => {
    const f = await connected({ spares: 2 });
    const both = Promise.allSettled([
      submitReceipt(f.provider, input, { timeoutMs: 100 }),
      submitReceipt(f.provider, other, { timeoutMs: 100 }),
    ]);
    const { value } = await observe(both, f.drop);
    expect(value.map((result: PromiseRejectedResult) => result.reason.code)).toEqual(["inclusion-unknown", "inclusion-unknown"]);
    // One of the two spare connections was never opened.
    expect(mocks.apis).toHaveLength(1);
    expect(mocks.sockets).toHaveLength(2);
    expect(f.recovery.api.query.orinqReceipts.receipts.mock.calls.map(call => call[0])).toEqual(
      expect.arrayContaining([receiptId, receiptIdOf(other)]));
    expect(f.recovery.api.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the shared reader open for a poll that outlives another", async () => {
    const f = await connected({ spares: 2 });
    f.chain.blockMs = 1000;
    f.chain.storeReceipt(receiptRecord(), { from: 43 });
    f.chain.storeReceipt(receiptRecord({}, other), { id: receiptIdOf(other), from: 46 });
    const first = settle(submitReceipt(f.provider, input, { timeoutMs: 20_000 }), 20_000);
    const second = settle(submitReceipt(f.provider, other, { timeoutMs: 20_000 }), 20_000);
    await vi.advanceTimersByTimeAsync(0);
    f.drop();
    expect((await first).value).toMatchObject({ reconciled: true, blockNumber: 43 });
    expect(f.recovery.api.disconnect).not.toHaveBeenCalled();
    expect((await second).value).toMatchObject({ reconciled: true, blockNumber: 46, blockHash: blockHashOf(46) });
    expect(f.recovery.api.disconnect).toHaveBeenCalledOnce();
    expect(mocks.apis).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces a stalled shared reader once for every poll using it", async () => {
    const f = await connected({ spares: 3 });
    f.recovery.api.rpc.chain.getHeader.mockImplementation(never);
    const both = Promise.allSettled([
      submitReceipt(f.provider, input, { timeoutMs: 40_000 }),
      submitReceipt(f.provider, other, { timeoutMs: 40_000 }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    f.drop();
    f.chain.storeReceipt();
    f.chain.storeReceipt(receiptRecord({}, other), { id: receiptIdOf(other) });
    const { value } = await settle(both, 40_000);
    expect(value.map((result: PromiseFulfilledResult<{ reconciled?: boolean }>) => result.value?.reconciled)).toEqual([true, true]);
    expect(f.recovery.api.disconnect).toHaveBeenCalledOnce();
    expect(f.spares[1]!.api.disconnect).toHaveBeenCalledOnce();
    // The stalled reader was replaced by one connection, not one per poll.
    expect(mocks.apis).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the reader between a submission in recovery and resolveInclusion", async () => {
    const f = await connected({ spares: 3 });
    const unknown = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), f.drop);
    expect(unknown.error.code).toBe("inclusion-unknown");
    f.reconnect();
    f.chain.blockMs = 1000;
    const resolving = settle(sdk.resolveInclusion(f.provider, unknown.error, { intervalMs: 1000, timeoutMs: 10_000 }), 12_000);
    const submitting = settle(submitReceipt(f.provider, other, { timeoutMs: 10_000 }), 12_000);
    await vi.advanceTimersByTimeAsync(0);
    f.drop();
    expect((await submitting).error.code).toBe("inclusion-unknown");
    expect((await resolving).error.code).toBe("inclusion-unknown");
    expect(mocks.apis).toHaveLength(1);
    expect(f.spares[1]!.api.disconnect).toHaveBeenCalledOnce();
  });
});

describe("disconnect() ends recovery", () => {
  it("stops a submission in recovery from opening or reading readers, and reports inclusion-unknown at once", async () => {
    const f = await connected({ spares: 3 });
    f.chain.blockMs = 1000;
    let outcome: { error?: any; at?: number } | undefined;
    const start = Date.now();
    submitReceipt(f.provider, input, { timeoutMs: 60_000 }).then(
      () => { outcome = {}; }, error => { outcome = { error, at: Date.now() - start }; });
    await vi.advanceTimersByTimeAsync(0);
    f.drop();
    await vi.advanceTimersByTimeAsync(2500);
    expect(outcome).toBeUndefined();
    const reads = f.recovery.api.rpc.chain.getHeader.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    await f.provider.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome?.at).toBe(2500);
    expect(outcome!.error).toMatchObject({ code: "inclusion-unknown", safeToResubmit: false, txHash, signer: SIGNER, nonce: 7 });
    expect(outcome!.error.message).toMatch(/disconnect\(\)/);
    expect(f.recovery.api.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    // Up to the original deadline nothing else is opened or read.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.apis).toHaveLength(2);
    expect(mocks.sockets).toHaveLength(2);
    expect(f.recovery.api.rpc.chain.getHeader.mock.calls.length).toBe(reads);
  });

  it("aborts a reader that is still opening", async () => {
    const f = await connected({ spares: 3 });
    f.recovery.api.isReadyOrError = never();
    let error: any;
    submitReceipt(f.provider, input, { timeoutMs: 60_000 }).catch(value => { error = value; });
    await vi.advanceTimersByTimeAsync(0);
    f.drop();
    await vi.advanceTimersByTimeAsync(10);
    expect(error).toBeUndefined();
    await f.provider.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toMatchObject({ code: "inclusion-unknown", safeToResubmit: false });
    expect(f.recovery.api.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.apis).toHaveLength(2);
  });

  it("ends resolveInclusion with inclusion-unknown instead of polling to its timeout", async () => {
    const f = await connected({ spares: 3 });
    const unknown = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), f.drop);
    f.chain.blockMs = 1000;
    let outcome: { value?: unknown; error?: any } | undefined;
    sdk.resolveInclusion(f.provider, unknown.error, { intervalMs: 1000, timeoutMs: 600_000 }).then(
      value => { outcome = { value }; }, error => { outcome = { error }; });
    await vi.advanceTimersByTimeAsync(3000);
    expect(outcome).toBeUndefined();
    await f.provider.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome?.error).toMatchObject({ code: "inclusion-unknown", safeToResubmit: false, txHash, mortalityEnd: 105 });
    expect(outcome!.error.message).toMatch(/disconnect\(\)/);
    expect(f.spares[1]!.api.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(mocks.apis).toHaveLength(1);
  });

  it("serves recovery again after the provider reconnects", async () => {
    const f = await connected({ spares: 1 });
    const pending = submitReceipt(f.provider, input, { timeoutMs: 60_000 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    f.drop();
    await vi.advanceTimersByTimeAsync(10);
    await f.provider.disconnect();
    expect(await pending).toMatchObject({ code: "inclusion-unknown" });
    const again = await connected({ spares: 1, provider: f.provider, chain: f.chain });
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), () => { f.chain.storeReceipt(); again.drop(); });
    expect(value).toMatchObject({ reconciled: true });
    expect(again.recovery.api.disconnect).toHaveBeenCalledOnce();
  });
});

describe("mortalityEnd comes from the block the extrinsic was signed against", () => {
  it("signs with an explicit era born at the finalized block, that block's hash and the fetched nonce", async () => {
    const f = await connected();
    f.chain.base = 100;
    f.chain.finalityLag = 3;
    f.signed.send.mockRejectedValue(rpcError(1014, PRIORITY_TOO_LOW));
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(f.api.derive.tx.signingInfo).toHaveBeenCalledExactlyOnceWith(SIGNER, -1);
    const info = await f.api.derive.tx.signingInfo.mock.results[0]!.value as { nonce: unknown; header: { hash: { toHex(): string } } };
    expect(info.header.hash.toHex()).toBe(blockHashOf(97));
    expect(f.api.registry.createType).toHaveBeenCalledExactlyOnceWith("ExtrinsicEra", { current: expect.anything(), period: 64 });
    const era = f.api.registry.createType.mock.results[0]!.value;
    expect(f.tx.signAsync).toHaveBeenCalledExactlyOnceWith(expect.anything(), { nonce: info.nonce, era, blockHash: info.header.hash });
    expect(error).toMatchObject({ code: "not-landed", mortalityEnd: 97 + 63 });
  });

  it.each(["receipt", "anchor"])("does not undercount a %s's mortalityEnd when the best block read after signing is below the era's birth", async kind => {
    const f = await connected();
    f.chain.base = 100;
    // A reorg to a shorter fork: the best head read after signing is #99, below the birth block #100.
    const read = f.api.rpc.chain.getHeader.getMockImplementation()!;
    f.api.rpc.chain.getHeader.mockImplementation(async at =>
      at === undefined ? { hash: { toHex: () => blockHashOf(99) }, number: { toNumber: () => 99 } } : read(at));
    f.signed.send.mockRejectedValue(rpcError(1014, PRIORITY_TOO_LOW));
    const { error } = await observe(kind === "receipt"
      ? submitReceipt(f.provider, input, { timeoutMs: 100 })
      : submitAnchor(f.provider, entry, { timeoutMs: 100 }));
    // Born at #100 with period 64, block #163 can still include it; #99 would wrongly read as expired.
    expect(error).toMatchObject({ code: "not-landed", mortalityEnd: 163 });
  });

  it("reports a missing signing block as not-landed, with nothing signed or sent", async () => {
    const f = await connected();
    f.api.derive.tx.signingInfo.mockResolvedValue({ nonce: { toNumber: () => 7 }, header: null, mortalLength: 64 });
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "not-landed", safeToResubmit: true });
    expect(f.tx.signAsync).not.toHaveBeenCalled();
    expect(f.signed.send).not.toHaveBeenCalled();
  });
});
