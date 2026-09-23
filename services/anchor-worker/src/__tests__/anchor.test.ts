import { afterEach, describe, expect, it, vi } from "vitest";
import { CML, Lucid } from "@lucid-evolution/lucid";
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
    expect(submitted.every((tx) => tx.entry !== null)).toBe(true);
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

  const first = {
    manifest: { ...manifest(7), merkleRoot: "1".repeat(64), agentId: "agent-a", totalEvents: 5 },
    storageUri: "https://a.example/trace",
  };
  it.each([
    ["merkleRoot", { ...first, manifest: { ...first.manifest, merkleRoot: "2".repeat(64) } }, { merkleRoot: "2".repeat(64) }],
    ["agentId", { ...first, manifest: { ...first.manifest, agentId: "agent-b" } }, { agentId: "agent-b" }],
    ["totalEvents", { ...first, manifest: { ...first.manifest, totalEvents: 99 } }, { itemCount: 99 }],
    ["storageUri", { ...first, storageUri: "https://b.example/trace" }, { storageUri: "https://b.example/trace" }],
  ])(
    "anchors a request that differs from a landed one only in %s in its own tx",
    async (_field, second, anchoredAs) => {
      const { anchor, submitted, notified } = await emulatorHarness();

      const a = await anchor("req-a", first.manifest, first.storageUri);
      const b = await anchor("req-b", second.manifest, second.storageUri);

      expect(b.txHash).not.toBe(a.txHash);
      expect(submitted.map((tx) => tx.txHash)).toEqual([a.txHash, b.txHash]);
      expect(submitted[1]!.entry).toMatchObject(anchoredAs);
      expect(notified.find((n) => n.requestId === "req-b")!.txHash).toBe(b.txHash);
    }
  );

  it("anchors hash strings exactly as sent, so a bare and a prefixed hash are separate anchors", async () => {
    const { anchor, submitted } = await emulatorHarness();
    const prefixed = manifest(7);
    const bare = {
      ...prefixed,
      manifestHash: prefixed.manifestHash.slice("sha256:".length),
      rootHash: prefixed.rootHash.slice("sha256:".length),
    };

    const a = await anchor("req-a", prefixed);
    const b = await anchor("req-b", bare);

    expect(b.txHash).not.toBe(a.txHash);
    expect(submitted[1]!.entry).toMatchObject({
      manifestHash: bare.manifestHash,
      rootHash: bare.rootHash,
    });
  });

  it("resets the chain when its input is spent elsewhere, then re-reads the wallet once the tip lands", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

    const anchors = submitted.filter((tx) => tx.entry !== null);
    expect(anchors.map((tx) => tx.txHash)).toEqual([first.txHash, third.txHash]);
    expect(anchors[1]!.inputs.length).toBeGreaterThan(0);
    expect(anchors[1]!.inputs.every((input) => input.startsWith(`${moveHash}#`))).toBe(true);
  });

  it("answers a request whose submit failed after the node took its tx with that tx, and chains on from it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { emulator, anchor, submitted, notified } = await emulatorHarness();
    produceBlocks(emulator);
    const submitTx = emulator.submitTx.bind(emulator);
    let calls = 0;
    // Blockfrost relayed the tx, then answered 5xx or a non-JSON body.
    emulator.submitTx = async (cbor: string) => {
      const txHash = await submitTx(cbor);
      if (++calls === 2) throw new Error("Could not submit transaction.");
      return txHash;
    };

    const r1 = await anchor("req-1", manifest(1));
    const r2 = await anchor("req-2", manifest(2));
    const r3 = await anchor("req-3", manifest(3));
    const repost = await anchor("req-2-again", manifest(2));

    expect(submitted.map((tx) => tx.txHash)).toEqual([r1.txHash, r2.txHash, r3.txHash]);
    expectEachSpendsThePreviousChange(submitted);
    expect(repost.txHash).toBe(r2.txHash);
    expect(notified.map((n) => [n.requestId, n.txHash])).toEqual([
      ["req-1", r1.txHash],
      ["req-2", r2.txHash],
      ["req-3", r3.txHash],
      ["req-2-again", r2.txHash],
    ]);
  });

  it("fails a request whose tx never reached the node only after checking the chain, then chains on the tx before it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { emulator, anchor, submitted } = await emulatorHarness();
    const submitTx = emulator.submitTx.bind(emulator);
    let calls = 0;
    emulator.submitTx = async (cbor: string) => {
      if (++calls === 2) throw new Error("fetch failed");
      return submitTx(cbor);
    };

    const r1 = await anchor("req-1", manifest(1));
    await expect(anchor("req-2", manifest(2))).rejects.toThrow("fetch failed");
    emulator.awaitBlock();
    const r3 = await anchor("req-3", manifest(3));

    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringMatching(/^\[anchor\] Submit of [0-9a-f]{64} failed: .*fetch failed/),
      expect.stringMatching(/^\[anchor\] [0-9a-f]{64} not on chain after 500ms/),
    ]);
    expect(submitted.map((tx) => tx.txHash)).toEqual([r1.txHash, r3.txHash]);
    expectEachSpendsThePreviousChange(submitted);
  });
});

describe("anchorProcessTrace on a two-UTxO wallet", () => {
  it("never answers a re-post with a tx that did not land, though the tip on the other UTxO did", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { emulator, anchor, submitted } = await emulatorHarness({ maxChainLength: 4 }, [
      250_000_000n,
      250_000_000n,
    ]);
    const submitTx = emulator.submitTx.bind(emulator);
    let calls = 0;
    // The node took the third tx, then lost it from its mempool.
    emulator.submitTx = async (cbor: string) =>
      ++calls === 3
        ? CML.hash_transaction(CML.Transaction.from_cbor_hex(cbor).body()).to_hex()
        : submitTx(cbor);

    const results = [];
    for (let i = 1; i <= 4; i++) results.push(await anchor(`req-${i}`, manifest(i)));
    emulator.awaitBlock();
    // At the length cap: waits for the tip, then reads the wallet.
    await anchor("req-5", manifest(5));

    // lucid selects largest-first, so the tip spends the other UTxO's lineage.
    expect(submitted.slice(0, 3).map((tx) => tx.txHash)).toEqual(
      [results[0], results[1], results[3]].map((r) => r!.txHash)
    );
    expect(submitted[2]!.inputs).not.toContain(`${results[2]!.txHash}#0`);
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringMatching(`^\\[anchor\\] ${results[2]!.txHash} not on chain after 0ms`),
    ]);
    for (const i of [1, 2, 4]) {
      expect((await anchor(`req-${i}-again`, manifest(i))).txHash).toBe(results[i - 1]!.txHash);
    }
    const retry = await anchor("req-3-again", manifest(3));
    expect(retry.txHash).not.toBe(results[2]!.txHash);
    expect(submitted.at(-1)!.txHash).toBe(retry.txHash);
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

  it("resolves true as soon as the tx is in a block", async () => {
    const chain = chainAnswering(null, null, onChain);

    await expect(
      awaitOnChain(chain, onChain.txHash, { pollMs: 1, timeoutMs: 1_000 })
    ).resolves.toBe(true);

    expect(chain.getTxInfo).toHaveBeenCalledTimes(3);
  });

  it("keeps polling through failed lookups", async () => {
    const chain = chainAnswering(new Error("fetch failed"), onChain);

    await expect(
      awaitOnChain(chain, onChain.txHash, { pollMs: 1, timeoutMs: 1_000 })
    ).resolves.toBe(true);

    expect(chain.getTxInfo).toHaveBeenCalledTimes(2);
  });

  it("gives up after the timeout, says so, and resolves false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const chain = chainAnswering(new Error("fetch failed"), null);

    await expect(
      awaitOnChain(chain, onChain.txHash, { pollMs: 1, timeoutMs: 20 })
    ).resolves.toBe(false);

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
