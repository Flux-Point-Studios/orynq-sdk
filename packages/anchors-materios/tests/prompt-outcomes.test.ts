/**
 * Gap tests for the four mutants that survived the #211 review (#213). Each outcome below must
 * arrive when its cause does. A test that only checks the final label also passes on a mutant
 * that reaches the same label by waiting out a deadline, so every test here bounds the fake time
 * the outcome may take far below any deadline in play, and checks that no recovery was started.
 */
import { EventEmitter } from "node:events";
import type { ApiPromise } from "@polkadot/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "../src/index.js";
import { submitReceipt } from "../src/receipt.js";
import { submitAnchor } from "../src/submitter.js";
import { waitForCertification } from "../src/polling.js";
import { watchSubmission } from "../src/subscription.js";
import {
  PRIORITY_TOO_LOW, anchorId, connected, entry, hash, inBlock, input, mocks, receiptId, rpcError, txHash,
} from "./support/fake-chain.js";

vi.mock("@polkadot/api", async () => (await import("./support/fake-chain.js")).polkadotApiMock());

const blockHash = hash("b");
const moduleError = { isModule: true, asModule: {}, toString: () => "module error" };
/** Far above every bound asserted below: an outcome that waits for a deadline cannot meet them. */
const TIMEOUT_MS = 100_000;
const WATCH_WINDOW_MS = TIMEOUT_MS - 30_000;

beforeEach(() => { vi.useFakeTimers(); mocks.apis.length = 0; mocks.sockets.length = 0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Runs `promise` for at most `windowMs` of fake time after `action`; reports the settlement and its fake-time delay. */
async function within(promise: Promise<unknown>, windowMs: number, action?: () => void) {
  let outcome: { value?: any; error?: any; when: number } | undefined;
  promise.then(value => { outcome = { value, when: Date.now() }; }, error => { outcome = { error, when: Date.now() }; });
  await vi.advanceTimersByTimeAsync(0);
  const start = Date.now();
  action?.();
  await vi.advanceTimersByTimeAsync(0);
  for (let waited = 0; outcome === undefined && waited < windowMs; waited++) await vi.advanceTimersByTimeAsync(1);
  expect(outcome, `still pending ${windowMs} ms of fake time after its cause`).toBeDefined();
  return { value: outcome!.value, error: outcome!.error, at: outcome!.when - start };
}

describe("M10: a pool report of Invalid, Dropped or Usurped ends the watch when it arrives", () => {
  const statuses = ["Invalid", "Dropped", "Usurped", "FinalityTimeout"];

  it.each(statuses)("watchSubmission settles as lost on %s without waiting for its deadline", async type => {
    const api = Object.assign(new EventEmitter(), { isConnected: true });
    const unsubscribe = vi.fn();
    let report: (result: unknown) => void = () => {};
    const watch = watchSubmission(api as unknown as ApiPromise, async callback => {
      report = callback as typeof report;
      return unsubscribe;
    }, Date.now() + WATCH_WINDOW_MS, false);
    const { value, at } = await within(watch, 5, () => report({ status: { [`is${type}`]: true, type } }));
    expect(value).toMatchObject({ status: "lost", timedOut: false });
    expect(value.cause.message).toBe(`Transaction pool reported ${type}`);
    expect(at).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(api.listenerCount("disconnected")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(statuses)("a receipt whose transaction the pool reports %s starts recovery at once and names the report", async type => {
    const f = await connected();
    const { error, at } = await within(submitReceipt(f.provider, input, { timeoutMs: 100 }), 150,
      () => f.emit({ status: { [`is${type}`]: true, type } }));
    // Recovery polls until the 100 ms deadline either way; its cause tells why the watch ended.
    expect(error).toMatchObject({ code: "inclusion-unknown", safeToResubmit: false });
    expect(error.cause.message).toBe(`Transaction pool reported ${type}`);
    expect(error.message).toContain(`Transaction pool reported ${type}`);
    expect(at).toBe(100);
    expect(f.api.disconnect).not.toHaveBeenCalled();
  });

  it.each(statuses)("reconciles a receipt that landed although the pool reported %s, long before the watch window ends", async type => {
    const f = await connected();
    const { value, at } = await within(submitReceipt(f.provider, input, { timeoutMs: TIMEOUT_MS }), 50, () => {
      f.chain.storeReceipt();
      f.emit({ status: { [`is${type}`]: true, type } });
    });
    expect(value).toMatchObject({ receiptId, reconciled: true, confirmed: true, txHash });
    expect(at).toBeLessThan(5);
  });
});

describe("M15: a dispatch error other than AlreadyExists is reported when it is seen", () => {
  it("rejects a receipt's in-block dispatch error at once, without reading recovery storage", async () => {
    const f = await connected();
    const { error, at } = await within(submitReceipt(f.provider, input, { timeoutMs: TIMEOUT_MS }), 50,
      () => f.emit(inBlock(blockHash, { dispatchError: moduleError })));
    expect(error).toMatchObject({ name: "MateriosSubmissionError", code: "dispatch", safeToResubmit: false, id: receiptId, txHash });
    expect(error.message).toContain("orinqReceipts.Rejected");
    expect(at).toBeLessThan(5);
    expect(mocks.apis).toHaveLength(1);
    expect(f.recovery.api.rpc.chain.getHeader).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a receipt's dry-run dispatch error at once, without reading recovery storage", async () => {
    const f = await connected();
    f.api.rpc.system.dryRun.mockResolvedValue({ isErr: false, asOk: { isErr: true, asErr: moduleError } });
    const { error, at } = await within(submitReceipt(f.provider, input, { timeoutMs: TIMEOUT_MS }), 50);
    expect(error).toMatchObject({ code: "dispatch", safeToResubmit: false, id: receiptId });
    expect(error.message).toContain("orinqReceipts.Rejected");
    expect(at).toBeLessThan(5);
    expect(f.signed.send).not.toHaveBeenCalled();
    expect(mocks.apis).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an anchor's dispatch error at once, without reading recovery storage", async () => {
    const f = await connected();
    const { error, at } = await within(submitAnchor(f.provider, entry, { timeoutMs: TIMEOUT_MS }), 50,
      () => f.emit(inBlock(blockHash, { dispatchError: moduleError })));
    expect(error).toMatchObject({ code: "dispatch", safeToResubmit: false, id: anchorId, txHash });
    expect(at).toBeLessThan(5);
    expect(mocks.apis).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("names a receipt's AlreadyExists for an anchor as a plain dispatch error, at once", async () => {
    const f = await connected();
    f.api.registry.findMetaError.mockReturnValue({ section: "orinqReceipts", name: "ReceiptAlreadyExists", docs: ["exists"] });
    const { error, at } = await within(submitAnchor(f.provider, entry, { timeoutMs: TIMEOUT_MS }), 50,
      () => f.emit(inBlock(blockHash, { dispatchError: moduleError })));
    expect(error).toMatchObject({ code: "dispatch", id: anchorId });
    expect(at).toBeLessThan(5);
    expect(mocks.apis).toHaveLength(1);
  });
});

describe("M23: resolveInclusion takes only an inclusion-unknown error", () => {
  /** A refused submission: not-landed, yet carrying every field resolveInclusion reads. */
  async function refused() {
    const f = await connected();
    f.signed.send.mockRejectedValue(rpcError(1014, PRIORITY_TOO_LOW));
    const { error } = await within(submitReceipt(f.provider, input, { timeoutMs: 100 }), 50);
    expect(error).toMatchObject({ code: "not-landed", txHash, nonce: 7, mortalityEnd: 105 });
    expect(error.expected).toBeDefined();
    expect(error.signer).toBeDefined();
    return { ...f, error };
  }

  it("refuses a not-landed error that carries its extrinsic, without polling", async () => {
    const f = await refused();
    f.chain.blockMs = 1000;
    const { error, value, at } = await within(sdk.resolveInclusion(f.provider, f.error, { intervalMs: 1000, timeoutMs: TIMEOUT_MS }), 50);
    expect(value).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toContain("inclusion-unknown");
    expect(at).toBe(0);
    expect(mocks.apis).toHaveLength(1);
    expect(f.recovery.api.rpc.chain.getFinalizedHead).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never turns a refused submission into landed because someone else stored the record", async () => {
    const f = await refused();
    f.chain.storeReceipt();
    const { error, value } = await within(sdk.resolveInclusion(f.provider, f.error, { intervalMs: 1000, timeoutMs: TIMEOUT_MS }), 50);
    expect(value).toBeUndefined();
    expect(error).toBeInstanceOf(TypeError);
    expect(mocks.apis).toHaveLength(1);
  });

  it("refuses a dispatch error that carries its extrinsic, without polling", async () => {
    const f = await connected();
    const dispatch = await within(submitReceipt(f.provider, input, { timeoutMs: 100 }), 50,
      () => f.emit(inBlock(blockHash, { dispatchError: moduleError })));
    expect(dispatch.error).toMatchObject({ code: "dispatch", txHash, nonce: 7, mortalityEnd: 105 });
    const { error, at } = await within(sdk.resolveInclusion(f.provider, dispatch.error, { timeoutMs: TIMEOUT_MS }), 50);
    expect(error).toBeInstanceOf(TypeError);
    expect(at).toBe(0);
    expect(mocks.apis).toHaveLength(1);
  });
});

describe("M25: a certification read that fails for a reason other than transport is thrown as it is", () => {
  it("rejects with the read's own error on the first poll, not with a certification timeout", async () => {
    const f = await connected();
    const decode = new TypeError("Cannot decode orinqReceipts.receipts: unexpected storage layout");
    f.api.query.orinqReceipts.receipts.mockRejectedValue(decode);
    const onPoll = vi.fn();
    const { error, at } = await within(waitForCertification(f.provider, receiptId, { intervalMs: 1000, timeoutMs: TIMEOUT_MS, onPoll }), 50);
    expect(error).toBe(decode);
    expect(at).toBe(0);
    expect(onPoll).toHaveBeenCalledOnce();
    expect(f.api.query.orinqReceipts.receipts).toHaveBeenCalledOnce();
    expect(f.api.disconnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with a node's JSON-RPC error instead of retrying it", async () => {
    const f = await connected();
    const rpc = rpcError(-32603, "Internal error: state pruned");
    f.api.query.orinqReceipts.receipts.mockRejectedValue(rpc);
    const { error, at } = await within(waitForCertification(f.provider, receiptId, { intervalMs: 1000, timeoutMs: TIMEOUT_MS }), 50);
    expect(error).toBe(rpc);
    expect(at).toBe(0);
    expect(f.api.query.orinqReceipts.receipts).toHaveBeenCalledOnce();
  });
});
