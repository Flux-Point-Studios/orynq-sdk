import { afterEach, describe, expect, it, vi } from "vitest";
import { Lucid } from "@lucid-evolution/lucid";
import type { AnchorChainProvider, TxInfo } from "@fluxpointstudios/orynq-sdk-anchors-cardano";

import { awaitOnChain } from "../anchor.js";
import {
  emulatorHarness,
  expectEachSpendsThePreviousChange,
  manifest,
  produceBlocks,
  stopProducingBlocks,
} from "./emulator-harness.js";

afterEach(() => {
  stopProducingBlocks();
  vi.restoreAllMocks();
});

describe("anchorProcessTrace on a one-UTxO wallet", () => {
  it("lands N concurrent requests, each tx spending the previous one's change", async () => {
    /** Production, 2026-09-22: 224 concurrent requests landed 15; the rest
     * failed with "All inputs are spent". */
    const { anchor, submitted, notified } = await emulatorHarness();

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => anchor(`req-${i}`, manifest(i)))
    );

    expect(submitted).toHaveLength(12);
    expect(submitted.every((tx) => tx.isAnchor)).toBe(true);
    expect(results.map((r) => r.txHash)).toEqual(submitted.map((tx) => tx.txHash));
    expectEachSpendsThePreviousChange(submitted);
    expect(notified.map((n) => n.requestId)).toEqual(results.map((_, i) => `req-${i}`));
    expect(results.every((r) => r.network === "preprod" && r.label === 2222)).toBe(true);
  });

  it("waits for the chain tip to land at the length cap, then continues from a fresh wallet read", async () => {
    const { emulator, anchor, submitted } = await emulatorHarness({ maxChainLength: 3 });
    produceBlocks(emulator);

    const results = await Promise.all(
      Array.from({ length: 7 }, (_, i) => anchor(`req-${i}`, manifest(i)))
    );

    expect(new Set(results.map((r) => r.txHash)).size).toBe(7);
    expect(submitted).toHaveLength(7);
    expectEachSpendsThePreviousChange(submitted);
  });

  it("coalesces concurrent requests for one manifest onto a single tx and notifies each request", async () => {
    const { anchor, submitted, notified } = await emulatorHarness();

    const results = await Promise.all([
      anchor("req-a", manifest(1)),
      anchor("req-b", manifest(1)),
      anchor("req-c", manifest(1)),
    ]);

    expect(submitted).toHaveLength(1);
    expect(results.map((r) => r.txHash)).toEqual(Array(3).fill(submitted[0]!.txHash));
    expect(notified).toEqual(
      ["req-a", "req-b", "req-c"].map((requestId) => ({
        requestId,
        txHash: submitted[0]!.txHash,
        network: "preprod",
      }))
    );
  });

  it("answers a recently anchored manifest with its txHash instead of a new tx", async () => {
    const { anchor, submitted } = await emulatorHarness();

    const first = await anchor("req-1", manifest(7));
    const again = await anchor("req-2", manifest(7));

    expect(again.txHash).toBe(first.txHash);
    expect(submitted).toHaveLength(1);
  });

  it("never hands out a tx whose metadata carries a different root", async () => {
    const { anchor, submitted } = await emulatorHarness();

    const honest = await anchor("req-1", manifest(7, "a"));
    const conflicting = await anchor("req-2", manifest(7, "c"));

    expect(conflicting.txHash).not.toBe(honest.txHash);
    expect(submitted).toHaveLength(2);
  });

  it("resets the chain when its input is spent elsewhere, then re-reads the wallet once the tip lands", async () => {
    const { account, emulator, anchor, submitted } = await emulatorHarness();

    const first = await anchor("req-1", manifest(1));
    emulator.awaitBlock();

    // The same seed spends that change behind the worker's back, as a manual
    // treasury move from the anchor wallet would.
    const elsewhere = await Lucid(emulator, "Custom");
    elsewhere.selectWallet.fromSeed(account.seedPhrase);
    const move = await elsewhere
      .newTx()
      .pay.ToAddress(account.address, { lovelace: 5_000_000n })
      .complete();
    const moveHash = await (await move.sign.withWallet().complete()).submit();

    await expect(anchor("req-2", manifest(2))).rejects.toThrow(
      "does not exist or was already spent"
    );

    emulator.awaitBlock();
    const third = await anchor("req-3", manifest(3));

    const anchors = submitted.filter((tx) => tx.isAnchor);
    expect(anchors.map((tx) => tx.txHash)).toEqual([first.txHash, third.txHash]);
    expect(anchors[1]!.inputs.length).toBeGreaterThan(0);
    expect(anchors[1]!.inputs.every((input) => input.startsWith(`${moveHash}#`))).toBe(true);
  });
});

describe("awaitOnChain", () => {
  const onChain: TxInfo = {
    txHash: "ab".repeat(32),
    blockHash: "cd".repeat(32),
    blockHeight: 1,
    slot: 1,
    timestamp: "2026-09-22T00:00:00.000Z",
    confirmations: 1,
  };

  function chainAnswering(...answers: Array<TxInfo | null | Error>) {
    const getTxInfo = vi.fn(async () => {
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (next instanceof Error) throw next;
      return next;
    });
    return { getTxInfo } satisfies Pick<AnchorChainProvider, "getTxInfo">;
  }

  it("resolves as soon as the tx is in a block", async () => {
    const chain = chainAnswering(null, null, onChain);

    await awaitOnChain(chain, onChain.txHash, { pollMs: 1, timeoutMs: 1_000 });

    expect(chain.getTxInfo).toHaveBeenCalledTimes(3);
  });

  it("keeps polling through failed lookups", async () => {
    const chain = chainAnswering(new Error("fetch failed"), onChain);

    await awaitOnChain(chain, onChain.txHash, { pollMs: 1, timeoutMs: 1_000 });

    expect(chain.getTxInfo).toHaveBeenCalledTimes(2);
  });

  it("gives up after the timeout, says so, and lets the caller read the wallet anyway", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const chain = chainAnswering(new Error("fetch failed"), null);

    await awaitOnChain(chain, onChain.txHash, { pollMs: 1, timeoutMs: 20 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(`${onChain.txHash} not on chain after 20ms`);
  });

  it("names the last lookup failure when it gives up", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const chain = chainAnswering(new Error("fetch failed"));

    await awaitOnChain(chain, onChain.txHash, { pollMs: 1, timeoutMs: 20 });

    expect(String(warn.mock.calls[0]![0])).toContain("last lookup failed: fetch failed");
  });
});
