import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MAX_FIND_WINDOW, findMidnightAnchors, type FindRequest } from "../find.js";
import type { IndexedAction, MidnightSource } from "../source.js";
import { verifyMidnightAnchor } from "../verify.js";
import { fromHex, toHex } from "../scale.js";
import { midnightTransactionIn } from "../substrate.js";
import { anchorChain, fixture } from "./anchor-chain.js";
import { replaySource } from "./recorded-source.js";

const registry = anchorChain().registry;
const at = (height: number, transactionId: number, name: "anchor" | "hiding" | "stranger"): IndexedAction => ({
  txHash: fixture[name].txHash,
  transactionId,
  raw: fixture[name].tx,
  block: { height, hash: "ab".repeat(32) },
});

// The indexer as its subscription behaves: every action from the offset, in order, then
// silence; `latest` is what its newest-action probe answers, `head` its head block.
function indexer(actions: IndexedAction[], { head = 50_000, latest = actions.at(-1) ?? null, address = registry.address } = {} as { head?: number; latest?: IndexedAction | null; address?: string }) {
  let delivered = 0;
  const source: MidnightSource = {
    operator: "fake",
    indexer: {
      transactions: async () => [],
      head: async () => ({ height: head, hash: "cd".repeat(32), timestamp: 0 }),
      latestAction: async (a) => (a === address && latest ? { height: latest.block.height, transactionId: latest.transactionId } : null),
      contractActions(a, fromHeight) {
        const queue = actions.filter((x) => a === address && x.block.height >= fromHeight);
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          next: () => {
            const value = queue.shift();
            if (!value) return new Promise<never>(() => {});
            delivered++;
            return Promise.resolve({ value, done: false as const });
          },
          return: async () => ({ value: undefined, done: true as const }),
        };
      },
    },
    node: { call: async () => null as never, batch: async () => [] },
  };
  return { source, delivered: () => delivered };
}
const find = (source: MidnightSource, extra: Partial<FindRequest> = {}) =>
  findMidnightAnchors({ network: "mainnet", source, fromHeight: 1000, toHeight: 3000, registries: [registry], authors: [fixture.author.key], idleMillis: 20, ...extra });

describe("findMidnightAnchors", () => {
  it("returns the requested authors' anchors in the window, every one decoded from its own bytes, and counts every action it read", async () => {
    const { source } = indexer([at(1500, 10, "anchor"), at(1600, 11, "stranger"), at(1700, 12, "hiding")]);
    const r = await find(source);
    expect(r).toMatchObject({ complete: true, nextCursor: null, scannedActions: 3, rejected: [] });
    expect(r.anchors.map((a) => [a.txHash, a.kind, a.author, a.block.height])).toEqual([
      [fixture.anchor.txHash, 1, fixture.author.key, 1500],
      [fixture.hiding.txHash, 2, fixture.author.key, 1700],
    ]);
  });

  it("narrows by kind and by commitment", async () => {
    const { source } = indexer([at(1500, 10, "anchor"), at(1700, 12, "hiding")]);
    expect((await find(source, { kinds: [2] })).anchors.map((a) => a.txHash)).toEqual([fixture.hiding.txHash]);
    expect((await find(indexer([at(1500, 10, "anchor"), at(1700, 12, "hiding")]).source, { commitment: fixture.anchor.commitment })).anchors.map((a) => a.txHash)).toEqual([fixture.anchor.txHash]);
  });

  it("stops at the first action past the window, which is complete without waiting for the stream", async () => {
    const { source, delivered } = indexer([at(1500, 10, "anchor"), at(3001, 20, "hiding"), at(3500, 21, "hiding")]);
    const r = await find(source, { idleMillis: 60_000 });
    expect(r).toMatchObject({ complete: true, scannedActions: 1 });
    expect(delivered()).toBe(2);
  });

  it("knows a quiet stream is done once it has delivered the indexer's newest action", async () => {
    const { source } = indexer([at(1500, 10, "anchor")]);
    expect(await find(source)).toMatchObject({ complete: true, scannedActions: 1 });
  });

  it("reports a stream that stays quiet before the newest action as incomplete at its deadline, with a cursor", async () => {
    const { source } = indexer([at(1500, 10, "anchor")], { latest: at(2500, 30, "hiding") });
    const r = await find(source, { deadlineMillis: 200 });
    expect(r).toMatchObject({ complete: false, scannedActions: 1, nextCursor: { registry: registry.address, height: 1500, transactionId: 10, actionIndex: 0 } });
  });

  it("spends at most maxActions reads on spam, and its cursor resumes exactly where it stopped", async () => {
    const spam = Array.from({ length: 5000 }, (_, i) => at(1001 + Math.floor(i / 3), 100 + i, "stranger"));
    const actions = [...spam, at(2900, 9999, "anchor")];
    const first = indexer(actions);
    const r = await find(first.source, { maxActions: 2000 });
    expect(r).toMatchObject({ complete: false, scannedActions: 2000, anchors: [], rejected: [] });
    expect(first.delivered()).toBeLessThanOrEqual(2001);
    let cursor = r.nextCursor;
    let scanned = r.scannedActions;
    const found = [];
    while (cursor) {
      const next = await find(indexer(actions).source, { maxActions: 2000, cursor });
      scanned += next.scannedActions;
      found.push(...next.anchors);
      expect(next.rejected).toEqual([]);
      cursor = next.nextCursor;
      if (!cursor) expect(next.complete).toBe(true);
    }
    expect(scanned).toBe(actions.length);
    expect(found.map((a) => a.txHash)).toEqual([fixture.anchor.txHash]);
  });

  it("reports a call to the registry that is not an anchor as rejected, never as found", async () => {
    const mainnet = JSON.parse(readFileSync(new URL("./fixtures/mainnet-blocks.json", import.meta.url), "utf8"));
    const raw = midnightTransactionIn(fromHex(mainnet.blocks[0].extrinsics[3], "extrinsic"))!;
    const theirs = "9ef16e583fbc361ba6016b2751e6f26a5ab2bbf2f7102ea5e28dc8810696eb9c";
    const action = { txHash: "56a425d1a6b15cb7212d1a8f016c55bf37cfedb21081319717ad0792ed8c3a8b", transactionId: 5, raw: toHex(raw), block: { height: 2772320, hash: mainnet.blocks[0].hash.slice(2) } };
    const { source } = indexer([action], { head: 2_800_000, address: theirs });
    const r = await findMidnightAnchors({ network: "mainnet", source, fromHeight: 2_772_000, toHeight: 2_780_000, registries: [{ ...registry, address: theirs }], authors: [fixture.author.key], idleMillis: 20 });
    expect(r).toMatchObject({ complete: true, scannedActions: 1, anchors: [] });
    expect(r.rejected).toEqual([{ txHash: action.txHash, height: 2772320, reason: expect.stringMatching(/its transcript is not the registry circuit's/) }]);
  });

  it("refuses a window wider than 20,000 blocks or above the indexer's head, and a search with no author to filter by", async () => {
    const { source } = indexer([]);
    await expect(find(source, { fromHeight: 1000, toHeight: 1000 + MAX_FIND_WINDOW + 1 })).rejects.toThrow(/at most 20000 blocks/);
    await expect(find(source, { fromHeight: 45_000, toHeight: 50_001 })).rejects.toThrow(/above the indexer's head 50000/);
    await expect(find(source, { authors: [] })).rejects.toThrow(/no author to filter by/);
    await expect(find(source, { authors: undefined })).rejects.toThrow(/no author to filter by/);
  });

  it("finds the synthetic chain's anchors, and each one then verifies on its own", async () => {
    const chain = anchorChain();
    const r = await findMidnightAnchors({ network: "mainnet", source: chain.source, fromHeight: 1001, toHeight: 2500, registries: [chain.registry], knownAuthors: chain.authors(), idleMillis: 20 });
    expect(r).toMatchObject({ complete: true, rejected: [] });
    expect(r.anchors.map((a) => a.entryPoint)).toEqual(["anchor", "anchor_hiding"]);
    for (const a of r.anchors) {
      const v = await verifyMidnightAnchor({ network: "mainnet", txHash: a.txHash, expect: a.kind === 2 ? { kind: 2, attribute: a.attribute } : { kind: 1, commitment: a.commitment } }, { source: chain.source, registries: [chain.registry], knownAuthors: chain.authors() });
      expect(v.status).toBe("valid");
    }
  });
});

// Recorded by running this search against Blockfrost's live mainnet subscription: a busy
// contract whose entry point is also named anchor, named as if it were a registry, so every
// call is read, decoded and refused. The replay fails on any request that was not recorded.
describe("golden: the search over a real mainnet subscription, replayed", () => {
  const f = JSON.parse(readFileSync(new URL("./fixtures/mainnet-find.json", import.meta.url), "utf8"));
  const base = () => ({
    network: "mainnet" as const,
    source: replaySource(f.recording),
    ...f.window,
    registries: [{ ...registry, address: f.registry, deployTxHash: "cd".repeat(32), deployHeight: 1 }],
    authors: f.authors,
  });
  const summary = (r: Awaited<ReturnType<typeof findMidnightAnchors>>) => ({ complete: r.complete, scannedActions: r.scannedActions, anchors: r.anchors.length, rejected: r.rejected, nextCursor: r.nextCursor });

  it("reads every action in the window and refuses each one as not an anchor", async () => {
    const r = await findMidnightAnchors(base());
    expect(summary(r)).toEqual(f.whole);
    expect(r.scannedActions).toBe(11);
    expect(r.rejected.every((x) => /its transcript is not the registry circuit's/.test(x.reason))).toBe(true);
  });

  it("pages through the same window three actions at a time, with no gap and no repeat", async () => {
    let cursor = null;
    const pages = [];
    do {
      const page = await findMidnightAnchors({ ...base(), maxActions: 3, cursor });
      pages.push(summary(page));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages).toEqual(f.pages);
    expect(pages.flatMap((p) => p.rejected.map((x: { txHash: string }) => x.txHash))).toEqual(f.whole.rejected.map((x: { txHash: string }) => x.txHash));
  });
});
