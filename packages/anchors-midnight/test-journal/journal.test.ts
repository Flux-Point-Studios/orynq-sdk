import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chainView, openJournal, type AnchorKey, type ChainView, type Submission } from "../src/journal.js";
import { fixture } from "../src/__tests__/anchor-chain.js";
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
  it("reads a transaction's status and block from the indexer, and chain time from its head block", async () => {
    const source = {
      indexer: {
        transactions: async (hash: string) =>
          hash === fixture.anchor.txHash
            ? [{ hash, raw: "", block: { height: 9, hash: "cd".repeat(32), timestamp: 0 }, status: "SUCCESS", contractActions: [] }]
            : [],
        head: async () => ({ height: 10, hash: "ef".repeat(32), timestamp: Date.UTC(2030, 0, 2) }),
      },
    } as unknown as MidnightSource;
    const view = chainView(source);
    expect(await view.lookup(fixture.anchor.txHash)).toEqual({ status: "SUCCESS", height: 9, blockHash: "cd".repeat(32) });
    expect(await view.lookup(fixture.hiding.txHash)).toBeNull();
    expect(await view.indexedThrough()).toEqual(new Date(Date.UTC(2030, 0, 2)));
  });
});
