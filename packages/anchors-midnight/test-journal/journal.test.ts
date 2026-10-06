import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chainView, openJournal, type AnchorKey, type ChainView, type Submission } from "../src/journal.js";
import { fixture } from "../src/__tests__/anchor-chain.js";
import { u64le } from "../src/scale.js";
import type { MidnightSource } from "../src/source.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-journal-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => join(dir, `journal-${n++}.sqlite`);

const key: AnchorKey = { network: "preprod", registry: fixture.registry.address, author: fixture.author.key, kind: 1, commitment: fixture.anchor.commitment, attribute: "00".repeat(32) };
const TTL = new Date("2030-01-01T00:00:00Z");
const MINUTE = 60_000;
const bytesOf = (name: "anchor" | "hiding" | "stranger") => new Uint8Array(Buffer.from(fixture[name].tx, "hex"));

// A network that records what reaches it and an indexer that lags it: `index()` makes what
// arrived visible, and `indexedAt` is the time of the newest block the indexer has read.
function network() {
  const arrived: string[] = [];
  const indexed = new Map<string, "SUCCESS" | "FAILURE">();
  let indexedAt = new Date("2029-12-31T23:00:00Z");
  const chain: ChainView = {
    lookup: async (txHash) => (indexed.has(txHash) ? { status: indexed.get(txHash)!, height: 7, blockHash: "ab".repeat(32) } : null),
    indexedThrough: async () => indexedAt,
  };
  return {
    chain,
    arrived,
    index: (status: "SUCCESS" | "FAILURE" = "SUCCESS") => arrived.forEach((h) => indexed.set(h, status)),
    advance: (to: Date) => (indexedAt = to),
    send: (name: "anchor" | "hiding" | "stranger") => async (bytes: Uint8Array) => {
      expect(Buffer.from(bytes).toString("hex")).toBe(fixture[name].tx);
      arrived.push(fixture[name].txHash);
    },
  };
}
const prepared = (name: "anchor" | "hiding" | "stranger", count: { n: number }) => async (): Promise<Submission> => {
  count.n++;
  return { bytes: bytesOf(name), ttl: TTL };
};

describe("the write-ahead journal", () => {
  it("writes the pending row, with the hash it computes from the final bytes, before anything is broadcast", async () => {
    const path = file();
    const journal = openJournal(path);
    const net = network();
    let seenByAnotherConnection: unknown;
    const row = await journal.submitOnce(key, {
      prepare: prepared("anchor", { n: 0 }),
      broadcast: async (bytes) => {
        const other = new DatabaseSync(path);
        seenByAnotherConnection = other.prepare("select tx_hash, state from attempts").all();
        other.close();
        await net.send("anchor")(bytes);
      },
      chain: net.chain,
    });
    expect(seenByAnotherConnection).toEqual([{ tx_hash: fixture.anchor.txHash, state: "pending" }]);
    expect(row).toMatchObject({ txHash: fixture.anchor.txHash, state: "pending", broadcasts: 1 });
    journal.close();
  });

  it("answers a repeat for the key from the journal, then records it landed once the indexer shows it", async () => {
    const journal = openJournal(file());
    const net = network();
    const count = { n: 0 };
    const submit = () => journal.submitOnce(key, { prepare: prepared("anchor", count), broadcast: net.send("anchor"), chain: net.chain });
    await submit();
    net.index();
    expect(await submit()).toMatchObject({ state: "landed", height: 7, blockHash: "ab".repeat(32) });
    expect(await submit()).toMatchObject({ state: "landed" });
    expect([count.n, net.arrived.length]).toEqual([1, 1]);
    journal.close();
  });

  it("crash window: a broadcast that reaches the network and then throws is answered by txHash, never sent as a second transaction", async () => {
    const journal = openJournal(file());
    const net = network();
    const count = { n: 0 };
    const acceptedThenTimedOut = async (bytes: Uint8Array) => {
      await net.send("anchor")(bytes);
      throw new Error("ETIMEDOUT after the node accepted the transaction");
    };
    await expect(journal.submitOnce(key, { prepare: prepared("anchor", count), broadcast: acceptedThenTimedOut, chain: net.chain })).rejects.toThrow(/ETIMEDOUT/);
    net.index();
    expect(await journal.submitOnce(key, { prepare: prepared("hiding", count), broadcast: net.send("hiding"), chain: net.chain })).toMatchObject({ txHash: fixture.anchor.txHash, state: "landed" });
    expect(count.n).toBe(1);
    expect(net.arrived).toEqual([fixture.anchor.txHash]);
    journal.close();
  });

  it("crash window: a process that dies between writing the row and broadcasting resends the same bytes after restart", async () => {
    const path = file();
    const net = network();
    const count = { n: 0 };
    const first = openJournal(path);
    await expect(
      first.submitOnce(key, {
        prepare: prepared("anchor", count),
        broadcast: async () => {
          throw new Error("process killed before the broadcast left");
        },
        chain: net.chain,
      }),
    ).rejects.toThrow(/process killed/);
    first.close();
    expect(net.arrived).toEqual([]);

    const restarted = openJournal(path);
    expect(restarted.pending().map((r) => r.txHash)).toEqual([fixture.anchor.txHash]);
    const row = await restarted.submitOnce(key, { prepare: prepared("hiding", count), broadcast: net.send("anchor"), chain: net.chain });
    expect(row).toMatchObject({ txHash: fixture.anchor.txHash, state: "pending", broadcasts: 1 });
    expect(await restarted.submitOnce(key, { prepare: prepared("hiding", count), broadcast: net.send("anchor"), chain: net.chain })).toMatchObject({ broadcasts: 1 });
    expect([count.n, net.arrived]).toEqual([1, [fixture.anchor.txHash]]);
    restarted.close();
  });

  it("crash window: an indexer that lags past the local TTL keeps the row pending; only chain time past TTL plus the margin frees the key", async () => {
    const journal = openJournal(file(), { ttlMarginMillis: 5 * MINUTE });
    const net = network();
    const count = { n: 0 };
    await journal.submitOnce(key, { prepare: prepared("anchor", count), broadcast: net.send("anchor"), chain: net.chain });
    net.advance(new Date(TTL.getTime() + 4 * MINUTE));
    expect(await journal.submitOnce(key, { prepare: prepared("hiding", count), broadcast: net.send("anchor"), chain: net.chain })).toMatchObject({
      txHash: fixture.anchor.txHash,
      state: "pending",
    });
    expect(count.n).toBe(1);
    net.advance(new Date(TTL.getTime() + 6 * MINUTE));
    const retried = await journal.submitOnce(key, { prepare: prepared("hiding", count), broadcast: net.send("hiding"), chain: net.chain });
    expect(retried).toMatchObject({ txHash: fixture.hiding.txHash, state: "pending" });
    expect(journal.history(key).map((r) => [r.txHash, r.state])).toEqual([
      [fixture.anchor.txHash, "failed"],
      [fixture.hiding.txHash, "pending"],
    ]);
    journal.close();
  });

  it("a transaction the chain reports failed frees the key for a new attempt", async () => {
    const journal = openJournal(file());
    const net = network();
    const count = { n: 0 };
    await journal.submitOnce(key, { prepare: prepared("anchor", count), broadcast: net.send("anchor"), chain: net.chain });
    net.index("FAILURE");
    expect(await journal.submitOnce(key, { prepare: prepared("hiding", count), broadcast: net.send("hiding"), chain: net.chain })).toMatchObject({ txHash: fixture.hiding.txHash });
    expect(count.n).toBe(2);
    journal.close();
  });

  it("serializes concurrent calls for one key in a process: one prepare, one broadcast", async () => {
    const journal = openJournal(file());
    const net = network();
    const count = { n: 0 };
    const rows = await Promise.all(Array.from({ length: 5 }, () => journal.submitOnce(key, { prepare: prepared("anchor", count), broadcast: net.send("anchor"), chain: net.chain })));
    expect(new Set(rows.map((r) => r.txHash))).toEqual(new Set([fixture.anchor.txHash]));
    expect([count.n, net.arrived.length]).toEqual([1, 1]);
    journal.close();
  });

  it("across processes, the attempt that writes its row second never broadcasts, and answers with the first", async () => {
    const path = file();
    const a = openJournal(path);
    const b = openJournal(path);
    const net = network();
    let releaseA!: () => void;
    const aPrepared = new Promise<void>((resolve) => (releaseA = resolve));
    const slow = a.submitOnce(key, {
      prepare: async () => {
        await aPrepared;
        return { bytes: bytesOf("hiding"), ttl: TTL };
      },
      broadcast: net.send("hiding"),
      chain: net.chain,
    });
    const fast = await b.submitOnce(key, { prepare: prepared("anchor", { n: 0 }), broadcast: net.send("anchor"), chain: net.chain });
    releaseA();
    expect((await slow).txHash).toBe(fast.txHash);
    expect(net.arrived).toEqual([fixture.anchor.txHash]);
    a.close();
    b.close();
  });

  it("reconcile settles every pending row by txHash alone, preparing and broadcasting nothing", async () => {
    const path = file();
    const first = openJournal(path);
    const net = network();
    const hidingKey: AnchorKey = { ...key, kind: 2, commitment: fixture.hiding.commitment, attribute: fixture.hiding.attribute };
    await first.submitOnce(key, { prepare: prepared("anchor", { n: 0 }), broadcast: net.send("anchor"), chain: net.chain });
    await first.submitOnce(hidingKey, { prepare: prepared("hiding", { n: 0 }), broadcast: net.send("hiding"), chain: net.chain });
    first.close();

    const restarted = openJournal(path);
    expect(await restarted.reconcile(net.chain)).toEqual([
      expect.objectContaining({ txHash: fixture.anchor.txHash, state: "pending" }),
      expect.objectContaining({ txHash: fixture.hiding.txHash, state: "pending" }),
    ]);
    net.index();
    expect(await restarted.reconcile(net.chain)).toEqual([
      expect.objectContaining({ txHash: fixture.anchor.txHash, state: "landed", height: 7 }),
      expect.objectContaining({ txHash: fixture.hiding.txHash, state: "landed", height: 7 }),
    ]);
    expect(restarted.pending()).toEqual([]);
    expect(net.arrived).toEqual([fixture.anchor.txHash, fixture.hiding.txHash]);
    restarted.close();
  });

  it("hands back a key's live attempt with the exact bytes it journalled, after a restart, and none once that attempt failed", async () => {
    const path = file();
    const net = network();
    const first = openJournal(path);
    expect(first.live(key)).toBeUndefined();
    await first.submitOnce(key, { prepare: prepared("anchor", { n: 0 }), broadcast: net.send("anchor"), chain: net.chain });
    first.close();

    const restarted = openJournal(path);
    const asHex = (row: ReturnType<typeof restarted.live>) => row && { ...row, bytes: Buffer.from(row.bytes).toString("hex") };
    expect(asHex(restarted.live(key))).toEqual({ txHash: fixture.anchor.txHash, state: "pending", ttl: TTL, broadcasts: 1, bytes: fixture.anchor.tx });
    net.index();
    await restarted.reconcile(net.chain);
    expect(asHex(restarted.live(key))).toEqual({ txHash: fixture.anchor.txHash, state: "landed", ttl: TTL, broadcasts: 1, height: 7, blockHash: "ab".repeat(32), bytes: fixture.anchor.tx });
    restarted.close();

    const other = openJournal(file());
    const refused = network();
    await other.submitOnce(key, { prepare: prepared("anchor", { n: 0 }), broadcast: refused.send("anchor"), chain: refused.chain });
    refused.index("FAILURE");
    await other.reconcile(refused.chain);
    expect(other.live(key)).toBeUndefined();
    other.close();
  });

  it("keeps its file, which holds final transaction bytes until they land, readable only by its owner", () => {
    const path = file();
    openJournal(path).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const open = file();
    writeFileSync(open, "");
    chmodSync(open, 0o644);
    expect(() => openJournal(open)).toThrow(/journal-\d+\.sqlite can be read or written by group or others/);
  });

  it("refuses bytes that are not a final transaction before writing anything", async () => {
    const journal = openJournal(file());
    const net = network();
    await expect(
      journal.submitOnce(key, { prepare: async () => ({ bytes: new Uint8Array([1, 2, 3]), ttl: TTL }), broadcast: net.send("anchor"), chain: net.chain }),
    ).rejects.toThrow(/not a final Midnight transaction/);
    expect(journal.history(key)).toEqual([]);
    journal.close();
  });
});

describe("chainView over a Midnight source", () => {
  const TIMESTAMP_NOW = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";
  const HEAD = { height: 10, hash: "ef".repeat(32), timestamp: Date.UTC(2030, 0, 2) };
  const timestamp = (ms: number) => `0x${Buffer.from(u64le(BigInt(ms))).toString("hex")}`;
  // An indexer whose newest block is HEAD, and a node that holds `nodeHash` at HEAD's height and
  // records `nodeNow` (by default `nodeTime`, encoded) as that block's Timestamp.Now.
  const source = ({ nodeHash = `0x${HEAD.hash}` as string | null, nodeTime = HEAD.timestamp as number | null, nodeNow = nodeTime === null ? null : timestamp(nodeTime) } = {}) => {
    const calls: Array<[string, unknown[]]> = [];
    const s = {
      indexer: {
        transactions: async (hash: string) =>
          hash === fixture.anchor.txHash
            ? [{ hash, raw: "", block: { height: 9, hash: "cd".repeat(32), timestamp: 0 }, status: "SUCCESS", contractActions: [] }]
            : [],
        head: async () => HEAD,
      },
      node: {
        call: async (method: string, params: unknown[] = []) => {
          calls.push([method, params]);
          if (method === "chain_getBlockHash" && params[0] === HEAD.height) return nodeHash;
          if (method === "state_getStorage" && params[0] === TIMESTAMP_NOW && params[1] === `0x${HEAD.hash}`) return nodeNow;
          throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
        },
      },
    } as unknown as MidnightSource;
    return { s, calls };
  };

  it("reads a transaction's status and block from the indexer", async () => {
    const view = chainView(source().s);
    expect(await view.lookup(fixture.anchor.txHash)).toEqual({ status: "SUCCESS", height: 9, blockHash: "cd".repeat(32) });
    expect(await view.lookup(fixture.hiding.txHash)).toBeNull();
  });

  it("reads chain time from the indexer's newest block only as the node records that block: on its chain, at its own Timestamp.Now", async () => {
    const agreed = source();
    expect(await chainView(agreed.s).indexedThrough()).toEqual(new Date(HEAD.timestamp));
    expect(agreed.calls).toEqual([
      ["chain_getBlockHash", [HEAD.height]],
      ["state_getStorage", [TIMESTAMP_NOW, `0x${HEAD.hash}`]],
    ]);
    expect(await chainView(source({ nodeTime: HEAD.timestamp - 60_000 }).s).indexedThrough()).toEqual(new Date(HEAD.timestamp - 60_000));
  });

  it("reads the indexer's time for its newest block when the node records a later one there", async () => {
    expect(await chainView(source({ nodeTime: HEAD.timestamp + 60_000 }).s).indexedThrough()).toEqual(new Date(HEAD.timestamp));
  });

  it("refuses a node that records no Timestamp.Now in a block it holds", async () => {
    await expect(chainView(source({ nodeTime: null }).s).indexedThrough()).rejects.toThrow(`the node holds no Timestamp.Now in block ${HEAD.height}`);
  });

  it("refuses a Timestamp.Now that is not exactly a u64", async () => {
    await expect(chainView(source({ nodeNow: `${timestamp(HEAD.timestamp)}00` }).s).indexedThrough()).rejects.toThrow("Timestamp.Now has 1 trailing byte");
  });

  it("proves no chain time while the node holds another block at the indexer's newest height, or none yet", async () => {
    expect(await chainView(source({ nodeHash: `0x${"12".repeat(32)}` }).s).indexedThrough()).toEqual(new Date(0));
    expect(await chainView(source({ nodeHash: null }).s).indexedThrough()).toEqual(new Date(0));
  });

  it("keeps a row pending past its TTL by the indexer's clock while the node does not hold the indexer's newest block", async () => {
    const journal = openJournal(file());
    const net = network();
    const count = { n: 0 };
    await journal.submitOnce(key, { prepare: prepared("hiding", count), broadcast: net.send("hiding"), chain: net.chain });
    const forked = source({ nodeHash: `0x${"12".repeat(32)}`, nodeTime: TTL.getTime() + 60 * MINUTE });
    const pastTtl = { ...forked.s, indexer: { ...forked.s.indexer, head: async () => ({ ...HEAD, timestamp: TTL.getTime() + 60 * MINUTE }) } } as MidnightSource;
    expect(await journal.reconcile(chainView(pastTtl))).toEqual([expect.objectContaining({ txHash: fixture.hiding.txHash, state: "pending" })]);
    journal.close();
  });
});
