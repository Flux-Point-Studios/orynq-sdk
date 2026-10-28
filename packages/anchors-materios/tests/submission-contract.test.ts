import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "../src/index.js";
import { MateriosProvider } from "../src/provider.js";
import { submitCertifiedReceipt, submitReceipt } from "../src/receipt.js";
import { submitAnchor } from "../src/submitter.js";
import { waitForCertification } from "../src/polling.js";
import {
  PRIORITY_TOO_LOW, SIGNER, anchorId, anchorRecord, blockHashOf, connected, entry, finalized, fixture, hash, inBlock,
  input, makeChain, mocks, never, observe, receiptId, receiptIdOf, receiptRecord, recordFromCall, rpcError, txHash,
} from "./support/fake-chain.js";

vi.mock("@polkadot/api", async () => (await import("./support/fake-chain.js")).polkadotApiMock());

/** The adam-oc keeper's retry matcher (anchor-service.ts): it must keep matching a refused submission. */
const NONCE_COLLISION = /^1014: Priority is too low/;
const blockHash = hash("b");
const okDryRun = { isErr: false, asOk: { isErr: false } };
const moduleError = { isModule: true, asModule: {}, toString: () => "module error" };
const other = { contentHash: hash("4"), rootHash: hash("5"), manifestHash: hash("6") };

beforeEach(() => { vi.useFakeTimers(); mocks.apis.length = 0; mocks.sockets.length = 0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Fake time until `promise` settles, in `stepMs` steps up to `limitMs`; returns the settlement and when it came. */
async function settle(promise: Promise<unknown>, limitMs: number, stepMs = 100) {
  const start = Date.now();
  let outcome: { value?: any; error?: any; at?: number } | undefined;
  promise.then(value => { outcome = { value, at: Date.now() - start }; }, error => { outcome = { error, at: Date.now() - start }; });
  for (let waited = 0; outcome === undefined && waited <= limitMs; waited += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
  expect(outcome, `still pending after ${limitMs} ms of fake time`).toBeDefined();
  return outcome!;
}

async function pendingFor(promise: Promise<unknown>, ms: number) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await vi.advanceTimersByTimeAsync(ms);
  return !settled;
}

describe("F1: node refusals and pre-send failures are not-landed", () => {
  it.each([
    [1010, "Invalid Transaction: Inability to pay some fees , e.g. account balance too low"],
    [1011, "Unknown Transaction Validity: cannot lookup"],
    [1014, PRIORITY_TOO_LOW],
  ])("reports refusal %i as not-landed with the node's message verbatim and the cause attached", async (code, text) => {
    const f = await connected();
    const refusal = rpcError(code, text);
    f.signed.send.mockRejectedValue(refusal);
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(error).toMatchObject({ name: "MateriosSubmissionError", code: "not-landed", safeToResubmit: true, id: receiptId });
    expect(error.message).toBe(refusal.message);
    expect(error.cause).toBe(refusal);
    expect(error).toMatchObject({ txHash, signer: SIGNER, nonce: 7 });
    expect(mocks.apis).toHaveLength(1);
    expect(f.api.listenerCount("disconnected")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the keeper's ^1014 retry matcher working for a same-nonce collision", async () => {
    const f = await connected();
    f.signed.send.mockRejectedValue(rpcError(1014, PRIORITY_TOO_LOW));
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(NONCE_COLLISION.test(error.message)).toBe(true);
    expect(error.safeToResubmit).toBe(true);
  });

  it("refuses the next receipt after a dropped watch as not-landed, not inclusion-unknown (s11)", async () => {
    const f = await connected({ spares: 2 });
    const first = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), f.drop);
    expect(first.error.code).toBe("inclusion-unknown");
    f.signed.send.mockRejectedValue(rpcError(1014, PRIORITY_TOO_LOW));
    const next = await observe(submitReceipt(f.provider, other, { timeoutMs: 100 }), f.reconnect);
    expect(next.error).toMatchObject({ code: "not-landed", safeToResubmit: true, id: receiptIdOf(other) });
    expect(NONCE_COLLISION.test(next.error.message)).toBe(true);
    expect(next.error.cause.code).toBe(1014);
  });

  it("reports a 1010 refusal behind an RPC filter that blocks system_dryRun as not-landed (s4)", async () => {
    const f = await connected();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    f.api.rpc.system.dryRun.mockRejectedValue(rpcError(-32601, "RPC call is unsafe to be called externally"));
    const refusal = rpcError(1010, "Invalid Transaction: Inability to pay some fees , e.g. account balance too low");
    f.signed.send.mockRejectedValue(refusal);
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "not-landed", safeToResubmit: true, cause: refusal });
    expect(error.message).toMatch(/^1010: Invalid Transaction/);
  });

  it("reports a socket that is closed before send as not-landed with the cause", async () => {
    const f = await connected();
    const closed = new Error("WebSocket is not connected");
    f.signed.send.mockRejectedValue(closed);
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "not-landed", safeToResubmit: true, message: "WebSocket is not connected", cause: closed });
    expect(mocks.apis).toHaveLength(1);
  });

  it("does not broadcast when the connection closes between preparation and send", async () => {
    const f = await connected();
    f.api.rpc.system.dryRun.mockImplementation(async () => { f.api.isConnected = false; return okDryRun; });
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "not-landed", safeToResubmit: true });
    expect(f.signed.send).not.toHaveBeenCalled();
  });

  it("broadcasts when the dry-run ran on a full best block and reported exhaustsResources", async () => {
    const f = await connected();
    f.api.rpc.system.dryRun.mockResolvedValue({ isErr: true, asErr: { toString: () => '{"invalid":{"exhaustsResources":null}}' } });
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), () => {
      f.chain.storeReceipt();
      f.emit(inBlock(blockHash));
    });
    expect(value).toMatchObject({ receiptId, confirmed: true, status: "submitted", txHash });
    expect(f.signed.send).toHaveBeenCalledOnce();
  });

  it("leaves validity to the pool: a dry-run validity verdict defers to the node's refusal", async () => {
    const f = await connected();
    f.api.rpc.system.dryRun.mockResolvedValue({ isErr: true, asErr: { toString: () => '{"invalid":{"payment":null}}' } });
    const refusal = rpcError(1010, "Invalid Transaction: Inability to pay some fees , e.g. account balance too low");
    f.signed.send.mockRejectedValue(refusal);
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "not-landed", safeToResubmit: true, cause: refusal, message: refusal.message });
  });

  it("signs an anchor before sending, so a signing failure is not-landed and nothing is sent (s12)", async () => {
    const f = await connected();
    const closed = new Error("WebSocket is not connected");
    f.tx.signAsync.mockRejectedValue(closed);
    const { error } = await observe(submitAnchor(f.provider, entry, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "not-landed", safeToResubmit: true, id: anchorId, cause: closed });
    expect(f.signed.send).not.toHaveBeenCalled();
    expect(f.tx.signAndSend).not.toHaveBeenCalled();
    expect(mocks.apis).toHaveLength(1);
  });

  it("reports an anchor refusal as not-landed with the node's message verbatim", async () => {
    const f = await connected();
    f.signed.send.mockRejectedValue(rpcError(1014, PRIORITY_TOO_LOW));
    const { error } = await observe(submitAnchor(f.provider, entry, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "not-landed", safeToResubmit: true, id: anchorId });
    expect(NONCE_COLLISION.test(error.message)).toBe(true);
  });

  it("recovers other send failures and keeps their cause on inclusion-unknown", async () => {
    const f = await connected();
    const dropped = new Error("disconnected from ws://fixture.invalid: 1006:: Abnormal Closure");
    f.signed.send.mockRejectedValue(dropped);
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "inclusion-unknown", safeToResubmit: false, cause: dropped });
    expect(f.recovery.api.query.orinqReceipts.receipts).toHaveBeenCalled();
  });
});

describe("F2: recovery re-reads storage until the deadline", () => {
  it("re-reads best-block storage every block and reconciles a receipt that lands seconds after the drop (s2/sk2)", async () => {
    const f = await connected();
    f.chain.blockMs = 1000;
    f.chain.storeReceipt(receiptRecord(), { from: 44 });
    const result = settle(submitReceipt(f.provider, input), 10_000);
    await vi.advanceTimersByTimeAsync(300);
    f.drop();
    const { value, at } = await result;
    expect(value).toMatchObject({ reconciled: true, confirmed: true, status: "submitted", blockNumber: 44, blockHash: blockHashOf(44), txHash });
    expect(at).toBeGreaterThanOrEqual(2000);
    expect(at).toBeLessThan(3500);
    expect(f.recovery.api.query.orinqReceipts.receipts.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.recovery.api.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads storage once per new block, not once per poll", async () => {
    const f = await connected();
    f.chain.blockMs = 3000;
    const result = settle(submitReceipt(f.provider, input, { timeoutMs: 20_000 }), 25_000);
    await vi.advanceTimersByTimeAsync(0);
    f.drop();
    const { error } = await result;
    expect(error.code).toBe("inclusion-unknown");
    expect(f.recovery.api.rpc.chain.getHeader.mock.calls.length).toBe(20);
    expect(f.recovery.api.query.orinqReceipts.receipts.mock.calls.length).toBe(7);
  });

  it("returns inclusion-unknown only at the deadline, carrying txHash, signer, nonce, mortality end, last head and cause", async () => {
    const f = await connected();
    f.chain.blockMs = 1000;
    const result = settle(submitReceipt(f.provider, input, { timeoutMs: 10_000 }), 12_000);
    await vi.advanceTimersByTimeAsync(0);
    f.drop();
    const { error, at } = await result;
    expect(at).toBe(10_000);
    expect(error).toMatchObject({
      name: "MateriosSubmissionError", code: "inclusion-unknown", safeToResubmit: false, id: receiptId,
      txHash, signer: SIGNER, nonce: 7, mortalityEnd: 105,
    });
    expect(error.lastHead).toEqual({ number: 51, hash: blockHashOf(51) });
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause.message).toMatch(/closed/i);
    expect(error.message).toContain("resolveInclusion");
    expect(error.message).not.toMatch(/blindly/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("confirms from storage a finalized anchor whose block events polkadot.js could not read", async () => {
    const f = await connected();
    const unreadable = new Error("events unavailable");
    const { error } = await observe(submitAnchor(f.provider, entry, { timeoutMs: 100 }),
      () => f.emit(finalized(blockHash, { blockNumber: undefined, internalError: unreadable })));
    expect(error).toMatchObject({ code: "inclusion-unknown", safeToResubmit: false, cause: unreadable });
    expect(f.recovery.api.query.orinqReceipts.anchors).toHaveBeenCalled();
  });

  it("keeps re-reading finalized anchor storage until the anchor is finalized", async () => {
    const f = await connected();
    f.chain.blockMs = 1000;
    f.chain.finalityLag = 2;
    f.chain.storeAnchor(anchorRecord(), { from: 44 });
    const result = settle(submitAnchor(f.provider, entry), 15_000);
    await vi.advanceTimersByTimeAsync(300);
    f.drop();
    const { value, at } = await result;
    expect(value).toMatchObject({ reconciled: true, anchorId, blockHash: blockHashOf(44) });
    expect(at).toBeGreaterThanOrEqual(4000);
    expect(at).toBeLessThan(5500);
  });
});

describe("F2: resolveInclusion settles an inclusion-unknown error from finalized storage", () => {
  async function inclusionUnknown() {
    const f = await connected({ spares: 2 });
    const { error } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), f.drop);
    expect(error.code).toBe("inclusion-unknown");
    f.chain.blockMs = 1000;
    f.chain.finalityLag = 2;
    return { ...f, error, resolver: f.spares[1]! };
  }

  it("is exported from the package entry point", () => {
    expect(typeof sdk.resolveInclusion).toBe("function");
  });

  it("resolves landed only once finalized storage holds the matching receipt", async () => {
    const f = await inclusionUnknown();
    f.chain.storeReceipt(receiptRecord(), { from: 44 });
    const resolution = sdk.resolveInclusion(f.provider, f.error, { intervalMs: 1000, timeoutMs: 60_000 });
    expect(await pendingFor(resolution, 3000)).toBe(true);
    const { value } = await settle(resolution, 5000);
    expect(value).toEqual({ status: "landed", id: receiptId, blockHash: blockHashOf(44), blockNumber: 44 });
    expect(f.resolver.api.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves not-landed only after the finalized head passes the extrinsic's mortality end", async () => {
    const f = await inclusionUnknown();
    const resolution = sdk.resolveInclusion(f.provider, f.error, { intervalMs: 1000, timeoutMs: 120_000 });
    expect(await pendingFor(resolution, 64_000)).toBe(true);
    const { value } = await settle(resolution, 3000);
    expect(value).toEqual({ status: "not-landed", reason: "expired", id: receiptId, blockHash: blockHashOf(105), blockNumber: 105 });
  });

  it("resolves not-landed once the finalized nonce is above the extrinsic's nonce with the record absent", async () => {
    const f = await inclusionUnknown();
    f.chain.nonceBumpAt = 45;
    const resolution = sdk.resolveInclusion(f.provider, f.error, { intervalMs: 1000, timeoutMs: 60_000 });
    expect(await pendingFor(resolution, 4000)).toBe(true);
    const { value } = await settle(resolution, 3000);
    expect(value).toMatchObject({ status: "not-landed", reason: "nonce-consumed", blockNumber: 45 });
  });

  it("prefers the stored receipt over a consumed nonce at the same finalized block", async () => {
    const f = await inclusionUnknown();
    f.chain.nonceBumpAt = 45;
    f.chain.storeReceipt(receiptRecord(), { from: 45 });
    const { value } = await settle(sdk.resolveInclusion(f.provider, f.error, { intervalMs: 1000, timeoutMs: 60_000 }), 10_000);
    expect(value).toMatchObject({ status: "landed", blockNumber: 45 });
  });

  it("stays unknown within mortality while the nonce is unchanged, and says so at its own deadline", async () => {
    const f = await inclusionUnknown();
    const { error, at } = await settle(sdk.resolveInclusion(f.provider, f.error, { intervalMs: 1000, timeoutMs: 10_000 }), 12_000);
    expect(at).toBeGreaterThanOrEqual(10_000);
    expect(error).toMatchObject({ code: "inclusion-unknown", txHash, nonce: 7, mortalityEnd: 105 });
    expect(error.lastHead.number).toBeGreaterThan(f.error.lastHead.number);
  });

  it("reports a different finalized payload at the id as dispatch", async () => {
    const f = await inclusionUnknown();
    f.chain.storeReceipt(receiptRecord({ baseManifestHash: hash("9") }), { from: 40 });
    const { error } = await settle(sdk.resolveInclusion(f.provider, f.error, { intervalMs: 1000, timeoutMs: 60_000 }), 5000);
    expect(error).toMatchObject({ code: "dispatch", safeToResubmit: false, id: receiptId });
  });

  it("refuses an error that is not inclusion-unknown", async () => {
    const f = await connected();
    const notLanded = new sdk.MateriosSubmissionError("not-landed", receiptId, "refused");
    await expect(sdk.resolveInclusion(f.provider, notLanded)).rejects.toThrow(TypeError);
  });
});

describe("F3: certification polling survives a lost main socket", () => {
  const certified = () => receiptRecord({ availabilityCertHash: hash("e") });

  it("keeps polling certification through a disconnect within its budget", async () => {
    const f = await connected();
    f.chain.storeReceipt(certified(), { from: 40 });
    f.drop();
    const result = settle(waitForCertification(f.provider, receiptId, { intervalMs: 500, timeoutMs: 10_000 }), 10_000);
    await vi.advanceTimersByTimeAsync(2000);
    f.reconnect();
    const { value, at } = await result;
    expect(value).toMatchObject({ receiptId, certHash: hash("e") });
    expect(at).toBeLessThan(3000);
  });

  it("replaces an unresponsive main connection when a certification read stalls (F5)", async () => {
    const f = await connected();
    f.chain.storeReceipt(certified(), { from: 40 });
    f.api.query.orinqReceipts.receipts.mockImplementation(never);
    const { value, at } = await settle(waitForCertification(f.provider, receiptId, { intervalMs: 1000, timeoutMs: 60_000 }), 20_000);
    expect(value).toMatchObject({ certHash: hash("e") });
    expect(at).toBeLessThan(15_000);
    expect(f.api.disconnect).toHaveBeenCalledOnce();
    expect(f.provider.getApi()).toBe(f.recovery.api);
  });

  it("names a stalled read read-timeout, not a connection timeout (F7)", async () => {
    const f = await connected();
    f.api.query.orinqReceipts.receipts.mockImplementation(never);
    f.recovery.api.query.orinqReceipts.receipts.mockImplementation(never);
    const { error, at } = await settle(waitForCertification(f.provider, receiptId, { intervalMs: 1000, timeoutMs: 12_000 }), 15_000);
    expect(at).toBe(12_000);
    expect(error.message).toMatch(/^Certification timeout/);
    expect(error.cause).toMatchObject({ name: "MateriosConnectionError", code: "read-timeout" });
    expect(error.cause.message).toMatch(/^Materios read timed out/);
  });

  it("throws a typed error carrying the on-chain submit result when certification still fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const f = await connected();
    f.signed.send.mockImplementation(async cb => {
      const stored = recordFromCall(f.api.tx.orinqReceipts.submitReceipt.mock.calls[0]!);
      f.chain.storeReceipt(stored.json, { id: stored.id });
      setTimeout(() => cb(inBlock(blockHash)), 0);
      setTimeout(f.drop, 10);
      return f.unsubscribe;
    });
    const content = Buffer.from("certified receipt content");
    const { error } = await settle(submitCertifiedReceipt(f.provider, { contentHash: "", rootHash: "", manifestHash: "" }, content, {
      blobGateway: { baseUrl: "http://gateway.invalid" }, submissionOpts: { timeoutMs: 1000 },
      certificationPollOpts: { intervalMs: 500, timeoutMs: 3000 },
    }), 5000);
    expect(error).toBeInstanceOf(sdk.MateriosCertificationError);
    expect(error).toMatchObject({ name: "MateriosCertificationError", stage: "certification" });
    expect(error.result).toMatchObject({ blockHash, blockNumber: 42, txHash, confirmed: true });
    expect(error.result.receiptId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(error.cause.message).toMatch(/^Certification timeout/);
  });
});

describe("F4: an existing matching record is success; anchors are checked before a retry broadcasts", () => {
  it("returns the stored matching receipt without broadcasting a duplicate", async () => {
    const f = await connected();
    f.chain.storeReceipt(receiptRecord(), { from: 41 });
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(value).toEqual({ receiptId, blockHash: blockHashOf(42), blockNumber: 42, confirmed: true, status: "submitted", reconciled: true });
    expect(f.signed.send).not.toHaveBeenCalled();
  });

  it("reconciles a dry-run ReceiptAlreadyExists whose stored payload matches", async () => {
    const f = await connected();
    f.api.registry.findMetaError.mockReturnValue({ section: "orinqReceipts", name: "ReceiptAlreadyExists", docs: ["exists"] });
    f.api.rpc.system.dryRun.mockImplementation(async () => {
      f.chain.storeReceipt();
      return { isErr: false, asOk: { isErr: true, asErr: moduleError } };
    });
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(value).toMatchObject({ receiptId, reconciled: true, confirmed: true });
    expect(value).not.toHaveProperty("txHash");
    expect(f.signed.send).not.toHaveBeenCalled();
  });

  it("reconciles an in-block ReceiptAlreadyExists whose stored payload matches (filtered dry-run)", async () => {
    const f = await connected();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    f.api.rpc.system.dryRun.mockRejectedValue(rpcError(-32601, "RPC call is unsafe to be called externally"));
    f.api.registry.findMetaError.mockReturnValue({ section: "orinqReceipts", name: "ReceiptAlreadyExists", docs: ["exists"] });
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), () => {
      f.chain.storeReceipt();
      f.emit(inBlock(blockHash, { dispatchError: moduleError }));
    });
    expect(value).toMatchObject({ receiptId, reconciled: true, confirmed: true, txHash });
  });

  it("keeps ReceiptAlreadyExists a dispatch error, at the first read, when the stored payload differs", async () => {
    const f = await connected();
    f.api.registry.findMetaError.mockReturnValue({ section: "orinqReceipts", name: "ReceiptAlreadyExists", docs: ["exists"] });
    const result = settle(submitReceipt(f.provider, input), 1000, 1);
    await vi.advanceTimersByTimeAsync(0);
    f.chain.storeReceipt(receiptRecord({ schemaHash: hash("7") }));
    f.emit(inBlock(blockHash, { dispatchError: moduleError }));
    const { error, at } = await result;
    expect(error).toMatchObject({ code: "dispatch", safeToResubmit: false, txHash });
    expect(error.message).toContain("orinqReceipts.ReceiptAlreadyExists");
    expect(at).toBeLessThan(5);
  });

  it("checks finalized anchor storage before broadcasting a retry (s9)", async () => {
    const f = await connected();
    f.chain.storeAnchor();
    const { value } = await observe(submitAnchor(f.provider, entry, { timeoutMs: 100 }));
    expect(value).toMatchObject({ anchorId, reconciled: true, blockHash: blockHashOf(42), rootHash: input.rootHash });
    expect(f.signed.send).not.toHaveBeenCalled();
  });

  it("reconciles an AnchorAlreadyExists once finalized storage shows the matching anchor", async () => {
    const f = await connected();
    f.api.registry.findMetaError.mockReturnValue({ section: "orinqReceipts", name: "AnchorAlreadyExists", docs: ["exists"] });
    const { value } = await observe(submitAnchor(f.provider, entry, { timeoutMs: 100 }), () => {
      f.chain.storeAnchor();
      f.emit(inBlock(blockHash, { dispatchError: moduleError }));
    });
    expect(value).toMatchObject({ anchorId, reconciled: true });
  });

  it("refuses to broadcast an anchor over a different finalized anchor at its id", async () => {
    const f = await connected();
    f.chain.storeAnchor(anchorRecord({ manifestHash: hash("9") }));
    const { error } = await observe(submitAnchor(f.provider, entry, { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: "dispatch", id: anchorId, safeToResubmit: false });
    expect(f.signed.send).not.toHaveBeenCalled();
  });
});

describe("F5: an unresponsive main connection is replaced", () => {
  it("replaces the main connection after a preparation timeout, so the next call succeeds (H3a)", async () => {
    const f = await connected({ spares: 1 });
    f.tx.signAsync.mockImplementation(never);
    const first = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }));
    expect(first.error.code).toBe("not-landed");
    const fresh = f.spares[0]!;
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), () => {
      f.chain.storeReceipt();
      fresh.emit(inBlock(blockHash));
    });
    expect(value).toMatchObject({ confirmed: true, status: "submitted", txHash });
    expect(fresh.signed.send).toHaveBeenCalledOnce();
    expect(f.api.disconnect).toHaveBeenCalledOnce();
    expect(f.provider.getApi()).toBe(fresh.api);
  });

  it("replaces the main connection after a silent watch", async () => {
    const f = await connected({ spares: 2 });
    const first = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), () => f.chain.storeReceipt());
    expect(first.value.reconciled).toBe(true);
    const fresh = f.spares[1]!;
    const { value } = await observe(submitReceipt(f.provider, other, { timeoutMs: 100 }), () => {
      f.chain.storeReceipt(receiptRecord({}, other), { id: receiptIdOf(other) });
      fresh.emit(inBlock(blockHash));
    });
    expect(value).toMatchObject({ receiptId: receiptIdOf(other), status: "submitted" });
    expect(f.api.disconnect).toHaveBeenCalledOnce();
  });

  it("waits for an auto-reconnect instead of failing a submission made during the gap (s12)", async () => {
    const f = await connected();
    f.signed.send.mockImplementation(async cb => {
      f.chain.storeReceipt();
      setTimeout(() => cb(inBlock(blockHash)), 0);
      return f.unsubscribe;
    });
    f.drop();
    const { value } = await observe(submitReceipt(f.provider, input, { timeoutMs: 100 }), f.reconnect);
    expect(value).toMatchObject({ confirmed: true, status: "submitted", blockHash, txHash });
    expect(f.signed.send).toHaveBeenCalledOnce();
  });
});

describe("F6/F7: connection lifecycle", () => {
  it("lets disconnect() abort an in-flight connect() without rethrowing its error", async () => {
    const f = fixture(makeChain());
    f.api.isReadyOrError = never();
    mocks.apis.push(f.api);
    const provider = new MateriosProvider({ rpcUrl: "ws://fixture.invalid", signerUri: "fixture", connectTimeoutMs: 700 });
    const connecting = provider.connect().catch(error => error);
    await vi.advanceTimersByTimeAsync(50);
    const { value, error } = await observe(provider.disconnect(), undefined, 1);
    expect(error).toBeUndefined();
    expect(value).toBeUndefined();
    expect(await connecting).toMatchObject({ name: "MateriosConnectionError", code: "connect-aborted" });
    expect(f.api.disconnect).toHaveBeenCalledOnce();
    expect(() => provider.getApi()).toThrow("Not connected");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the connect failure's text as its cause and in its message", async () => {
    const f = fixture(makeChain());
    const refused = new Error("connect ECONNREFUSED 127.0.0.1:9");
    f.api.isReadyOrError = Promise.reject(refused);
    mocks.apis.push(f.api);
    const provider = new MateriosProvider({ rpcUrl: "ws://127.0.0.1:9", signerUri: "fixture" });
    const error = await provider.connect().catch(value => value);
    expect(error).toMatchObject({ code: "connect-failed", cause: refused });
    expect(error.message).toContain("connect ECONNREFUSED 127.0.0.1:9");
  });

  it("names the endpoint when the runtime's WebSocket error event carries no text (Node 22+)", async () => {
    const f = fixture(makeChain());
    const event = { type: "error", message: "", error: new TypeError("") };
    f.api.isReadyOrError = Promise.reject(event);
    mocks.apis.push(f.api);
    const provider = new MateriosProvider({ rpcUrl: "ws://127.0.0.1:9", signerUri: "fixture" });
    const error = await provider.connect().catch(value => value);
    expect(error.code).toBe("connect-failed");
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause.message).toContain("ws://127.0.0.1:9");
    expect(error.cause.cause).toBe(event);
  });

  it("words a read timeout distinctly from a connection timeout", () => {
    expect(new sdk.MateriosConnectionError("read-timeout", 5).message).toBe("Materios read timed out (budget 5 ms)");
    expect(new sdk.MateriosConnectionError("connect-timeout", 5).message).toBe("Materios connection timed out (budget 5 ms)");
  });
});
