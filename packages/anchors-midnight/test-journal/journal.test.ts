import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chainView, openJournal, type AnchorKey, type ChainView, type Submission } from "../src/journal.js";
import { fixture } from "../src/__tests__/anchor-chain.js";
import { u64le } from "../src/scale.js";
import type { MidnightSource } from "../src/source.js";
import { batchOver, ledgerNode, type NodeVersion } from "../src/__tests__/ledger-node.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-journal-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => join(dir, `journal-${n++}.sqlite`);

const key: AnchorKey = { network: "preprod", registry: fixture.registry.address, author: fixture.author.key, kind: 1, commitment: fixture.anchor.commitment, attribute: "00".repeat(32) };
const TTL = new Date("2030-01-01T00:00:00Z");
const MINUTE = 60_000;
// The registry fixture deploys the registry; the others call it.
type Recorded = "registry" | "anchor" | "hiding" | "stranger";
const deployKey: AnchorKey = { network: "preprod", registry: "registry-deploy", author: "", kind: 0, commitment: "ef".repeat(32), attribute: "" };
const bytesOf = (name: Recorded) => new Uint8Array(Buffer.from(fixture[name].tx, "hex"));

// A network named `name` that records what reaches it and an indexer that lags it: `index()`
// makes what arrived visible, in block 7 "ab…" unless `place` moved it and until `forget` drops
// it, and `indexedAt` is the time of the newest block the indexer has read, INDEXED_HEAD, which
// the node holds. The node holds a contract at each address in `contracts`, and every question
// put to it about one is recorded in `asked`; its finalized chain holds the blocks `finalize`
// names, and none above them.
const INDEXED_HEAD = "cd".repeat(32);
function network(name = "preprod") {
  const arrived: string[] = [];
  const indexed = new Map<string, "SUCCESS" | "FAILURE">();
  const placed = new Map<string, { height: number; blockHash: string }>();
  const final = new Map<number, string>();
  const contracts = new Set<string>();
  const asked: Array<[string, string]> = [];
  let indexedAt = new Date("2029-12-31T23:00:00Z");
  const chain: ChainView = {
    network: name,
    lookup: async (txHash) => (indexed.has(txHash) ? { status: indexed.get(txHash)!, ...(placed.get(txHash) ?? { height: 7, blockHash: "ab".repeat(32) }) } : null),
    indexedThrough: async () => ({ hash: INDEXED_HEAD, time: indexedAt }),
    holdsContract: async (address, at) => {
      asked.push([address, at]);
      return contracts.has(address);
    },
    finalHash: async (height) => final.get(height) ?? null,
  };
  return {
    chain,
    arrived,
    contracts,
    asked,
    index: (status: "SUCCESS" | "FAILURE" = "SUCCESS") => arrived.forEach((h) => indexed.set(h, status)),
    place: (txHash: string, height: number, blockHash: string) => placed.set(txHash, { height, blockHash }),
    forget: (txHash: string) => indexed.delete(txHash),
    finalize: (height: number, blockHash: string) => final.set(height, blockHash),
    advance: (to: Date) => (indexedAt = to),
    send: (name: Recorded) => async (bytes: Uint8Array) => {
      expect(Buffer.from(bytes).toString("hex")).toBe(fixture[name].tx);
      arrived.push(fixture[name].txHash);
    },
  };
}
const prepared = (name: Recorded, count: { n: number }) => async (): Promise<Submission> => {
  count.n++;
  return { bytes: bytesOf(name), ttl: TTL };
};

describe("the write-ahead journal", () => {
  it("rebroadcasts only the named pending bytes, counts sends, and stops at inclusion or TTL", async () => {
    const journal = openJournal(file());
    const net = network();
    const row = await journal.submitOnce(key, { prepare: prepared("anchor", { n: 0 }), broadcast: net.send("anchor"), chain: net.chain });
    const retry = () => journal.rebroadcast(row.txHash, net.chain, net.send("anchor"));
    await retry();
    expect(journal.live(key)?.broadcasts).toBe(2);
    net.advance(TTL);
    await retry();
    expect(net.arrived).toHaveLength(2);
    net.advance(new Date(TTL.getTime() - 1000));
    await expect(journal.rebroadcast(row.txHash, network("mainnet").chain, net.send("anchor"))).rejects.toThrow("network");
    expect(net.arrived).toHaveLength(2);
    net.index();
    await retry();
    expect(journal.live(key)?.state).toBe("landed");
    expect(net.arrived).toHaveLength(2);
    journal.close();
  });
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
    expect(net.asked).toEqual([]);
    journal.close();
  });

  it("never retires a row whose bytes deploy a contract on the indexer's word: unseen past its TTL plus the margin, it asks the node at that block and stays landed while the node holds the contract there", async () => {
    const journal = openJournal(file(), { ttlMarginMillis: 5 * MINUTE });
    const net = network();
    const count = { n: 0 };
    await journal.submitOnce(deployKey, { prepare: prepared("registry", count), broadcast: net.send("registry"), chain: net.chain });
    net.contracts.add(fixture.registry.address);
    net.advance(new Date(TTL.getTime() + 4 * MINUTE));
    await journal.reconcile(net.chain);
    expect(net.asked).toEqual([]);
    net.advance(new Date(TTL.getTime() + 6 * MINUTE));
    expect(await journal.submitOnce(deployKey, { prepare: prepared("stranger", count), broadcast: net.send("stranger"), chain: net.chain })).toEqual({
      txHash: fixture.registry.txHash,
      state: "landed",
      ttl: TTL,
      broadcasts: 1,
    });
    expect(net.asked).toEqual([[fixture.registry.address, INDEXED_HEAD]]);
    expect([count.n, net.arrived]).toEqual([1, [fixture.registry.txHash]]);
    journal.close();
  });

  it("retires a deploy row unseen past its TTL plus the margin only once the node, at that block, holds no contract at the address its bytes deploy", async () => {
    const journal = openJournal(file(), { ttlMarginMillis: 5 * MINUTE });
    const net = network();
    await journal.submitOnce(deployKey, { prepare: prepared("registry", { n: 0 }), broadcast: net.send("registry"), chain: net.chain });
    net.advance(new Date(TTL.getTime() + 6 * MINUTE));
    expect(await journal.reconcile(net.chain)).toEqual([expect.objectContaining({ txHash: fixture.registry.txHash, state: "failed" })]);
    expect(net.asked).toEqual([[fixture.registry.address, INDEXED_HEAD]]);
    expect(journal.live(deployKey)).toBeUndefined();
    journal.close();
  });

  it.each([
    [true, "landed"],
    [false, "failed"],
  ] as const)("keeps a deploy row the indexer reports failed live until chain time is past its TTL plus the margin, then settles it from the node at that block (holds the contract: %s, so %s)", async (holds, state) => {
    const journal = openJournal(file(), { ttlMarginMillis: 5 * MINUTE });
    const net = network();
    await journal.submitOnce(deployKey, { prepare: prepared("registry", { n: 0 }), broadcast: net.send("registry"), chain: net.chain });
    net.index("FAILURE");
    if (holds) net.contracts.add(fixture.registry.address);
    net.advance(new Date(TTL.getTime() + 4 * MINUTE));
    expect(await journal.reconcile(net.chain)).toEqual([expect.objectContaining({ txHash: fixture.registry.txHash, state: "pending" })]);
    expect(net.asked).toEqual([]);
    net.advance(new Date(TTL.getTime() + 6 * MINUTE));
    expect(await journal.reconcile(net.chain)).toEqual([expect.objectContaining({ txHash: fixture.registry.txHash, state })]);
    expect(net.asked).toEqual([[fixture.registry.address, INDEXED_HEAD]]);
    journal.close();
  });

  it("settles a row only from a chain view of its own network: a preprod view past a mainnet deploy's TTL plus the margin leaves it pending and asks preprod's node nothing", async () => {
    const journal = openJournal(file(), { ttlMarginMillis: 5 * MINUTE });
    const mainnet = network("mainnet");
    const preprod = network("preprod");
    const mainnetDeploy: AnchorKey = { ...deployKey, network: "mainnet" };
    await journal.submitOnce(mainnetDeploy, { prepare: prepared("registry", { n: 0 }), broadcast: mainnet.send("registry"), chain: mainnet.chain });
    await journal.submitOnce(key, { prepare: prepared("anchor", { n: 0 }), broadcast: preprod.send("anchor"), chain: preprod.chain });
    mainnet.contracts.add(fixture.registry.address);
    preprod.index();
    preprod.advance(new Date(TTL.getTime() + 6 * MINUTE));
    expect(await journal.reconcile(preprod.chain)).toEqual([expect.objectContaining({ txHash: fixture.anchor.txHash, state: "landed" })]);
    expect(preprod.asked).toEqual([]);
    expect(journal.live(mainnetDeploy)).toMatchObject({ txHash: fixture.registry.txHash, state: "pending" });
    mainnet.advance(new Date(TTL.getTime() + 6 * MINUTE));
    expect(await journal.reconcile(mainnet.chain)).toEqual([expect.objectContaining({ txHash: fixture.registry.txHash, state: "landed" })]);
    expect(mainnet.asked).toEqual([[fixture.registry.address, INDEXED_HEAD]]);
    journal.close();
  });

  it("refuses a key of another network than its chain view's before preparing or sending anything", async () => {
    const journal = openJournal(file());
    const preprod = network("preprod");
    const count = { n: 0 };
    const mainnetKey: AnchorKey = { ...key, network: "mainnet" };
    await expect(journal.submitOnce(mainnetKey, { prepare: prepared("anchor", count), broadcast: preprod.send("anchor"), chain: preprod.chain })).rejects.toThrow(
      "a preprod chain view settles no mainnet attempt; nothing was prepared or sent",
    );
    expect([count.n, preprod.arrived, journal.history(mainnetKey)]).toEqual([0, [], []]);
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
    expect(net.asked).toEqual([]);
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

  it("returns another attempt's live row unsent to a call naming the hash of the bytes it holds, and resends a row of exactly those bytes", async () => {
    const path = file();
    const net = network();
    const first = openJournal(path);
    await expect(
      first.submitOnce(key, {
        prepare: prepared("anchor", { n: 0 }),
        broadcast: async () => {
          throw new Error("process killed before the broadcast left");
        },
        chain: net.chain,
      }),
    ).rejects.toThrow(/process killed/);
    first.close();

    const restarted = openJournal(path);
    const count = { n: 0 };
    const sent: string[] = [];
    const row = await restarted.submitOnce(key, {
      prepare: prepared("hiding", count),
      broadcast: async (bytes) => void sent.push(Buffer.from(bytes).toString("hex")),
      chain: net.chain,
      txHash: fixture.hiding.txHash,
    });
    expect(row).toMatchObject({ txHash: fixture.anchor.txHash, state: "pending", broadcasts: 0 });
    expect([count.n, sent]).toEqual([0, []]);
    expect(await restarted.submitOnce(key, { prepare: prepared("anchor", count), broadcast: net.send("anchor"), chain: net.chain, txHash: fixture.anchor.txHash })).toMatchObject({
      txHash: fixture.anchor.txHash,
      broadcasts: 1,
    });
    expect([count.n, net.arrived]).toEqual([0, [fixture.anchor.txHash]]);
    restarted.close();
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

  it("keeps with each attempt the wallet that paid its fee, so a caller resuming it can name that wallet", async () => {
    const path = file();
    const net = network();
    const first = openJournal(path);
    await first.submitOnce(key, { prepare: async () => ({ bytes: bytesOf("anchor"), ttl: TTL, payer: "mn_addr_preprod1payer" }), broadcast: net.send("anchor"), chain: net.chain });
    first.close();

    const restarted = openJournal(path);
    expect(restarted.live(key)).toMatchObject({ txHash: fixture.anchor.txHash, payer: "mn_addr_preprod1payer" });
    expect(restarted.history(key)).toEqual([expect.objectContaining({ payer: "mn_addr_preprod1payer" })]);
    restarted.close();
  });

  it("opens a journal whose attempts name no payer, keeping its rows, and records the payer of the attempts after", async () => {
    const path = file();
    const older = new DatabaseSync(path);
    older.exec(`
      create table attempts (
        id integer primary key, key text not null, tx_hash text not null unique, bytes blob not null, ttl_ms integer not null,
        state text not null check (state in ('pending', 'landed', 'failed')), broadcasts integer not null default 0, height integer, block_hash text
      );
      create unique index one_live_attempt on attempts(key) where state != 'failed';
    `);
    const olderKey = { ...key, kind: 2 };
    const keyText = [olderKey.network, olderKey.registry, olderKey.author, olderKey.kind, olderKey.commitment, olderKey.attribute].join("/");
    older.prepare("insert into attempts (key, tx_hash, bytes, ttl_ms, state, broadcasts) values (?, ?, ?, ?, 'failed', 1)").run(keyText, fixture.hiding.txHash, bytesOf("hiding"), TTL.getTime());
    older.close();
    chmodSync(path, 0o600);

    const journal = openJournal(path);
    const net = network();
    expect(journal.history(olderKey)).toEqual([{ txHash: fixture.hiding.txHash, state: "failed", ttl: TTL, broadcasts: 1 }]);
    await journal.submitOnce(key, { prepare: async () => ({ bytes: bytesOf("anchor"), ttl: TTL, payer: "mn_addr_preprod1payer" }), broadcast: net.send("anchor"), chain: net.chain });
    expect(journal.live(key)).toMatchObject({ payer: "mn_addr_preprod1payer" });
    const rows = new DatabaseSync(path, { readOnly: true });
    expect(rows.prepare("select tx_hash, payer from attempts order by id").all()).toEqual([
      { tx_hash: fixture.hiding.txHash, payer: null },
      { tx_hash: fixture.anchor.txHash, payer: "mn_addr_preprod1payer" },
    ]);
    rows.close();
    journal.close();
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

describe("a landed row whose block the node's finalized chain does not hold", () => {
  const ORPHANED = "ab".repeat(32);
  const ELSEWHERE = "ef".repeat(32);
  const landedAnchor = async () => {
    const journal = openJournal(file());
    const net = network();
    await journal.submitOnce(key, { prepare: prepared("anchor", { n: 0 }), broadcast: net.send("anchor"), chain: net.chain });
    net.index();
    expect(await journal.reconcile(net.chain)).toEqual([expect.objectContaining({ state: "landed", height: 7, blockHash: ORPHANED })]);
    return { journal, net };
  };

  it("stays as it is while the node has not finalized its height, or finalized the very block it names, wherever the indexer now places it", async () => {
    const { journal, net } = await landedAnchor();
    net.place(fixture.anchor.txHash, 9, ELSEWHERE);
    expect(await journal.relocate(fixture.anchor.txHash, net.chain)).toMatchObject({ state: "landed", height: 7, blockHash: ORPHANED });
    net.finalize(7, ORPHANED);
    expect(await journal.relocate(fixture.anchor.txHash, net.chain)).toMatchObject({ state: "landed", height: 7, blockHash: ORPHANED });
    journal.close();
  });

  it("is settled afresh once the node finalized another block at its height: landed where the indexer now places it, and sent nowhere again", async () => {
    const { journal, net } = await landedAnchor();
    net.finalize(7, "11".repeat(32));
    net.place(fixture.anchor.txHash, 9, ELSEWHERE);
    expect(await journal.relocate(fixture.anchor.txHash, net.chain)).toEqual({ txHash: fixture.anchor.txHash, state: "landed", ttl: TTL, broadcasts: 1, height: 9, blockHash: ELSEWHERE });
    expect(journal.live(key)).toMatchObject({ state: "landed", height: 9, blockHash: ELSEWHERE });
    expect(net.arrived).toEqual([fixture.anchor.txHash]);
    journal.close();
  });

  it("is pending again while the indexer lists it nowhere, then retired once the chain carried it past its TTL plus the margin unseen, which frees its key", async () => {
    const { journal, net } = await landedAnchor();
    net.finalize(7, "11".repeat(32));
    net.forget(fixture.anchor.txHash);
    expect(await journal.relocate(fixture.anchor.txHash, net.chain)).toEqual({ txHash: fixture.anchor.txHash, state: "pending", ttl: TTL, broadcasts: 1 });
    net.advance(new Date(TTL.getTime() + 5 * MINUTE + 1));
    expect(await journal.reconcile(net.chain)).toEqual([expect.objectContaining({ txHash: fixture.anchor.txHash, state: "failed" })]);
    expect(journal.live(key)).toBeUndefined();
    expect(net.arrived).toEqual([fixture.anchor.txHash]);
    journal.close();
  });

  it("is settled only from a chain view of its own network, and only a row the journal holds", async () => {
    const { journal } = await landedAnchor();
    const mainnet = network("mainnet");
    mainnet.finalize(7, "11".repeat(32));
    await expect(journal.relocate(fixture.anchor.txHash, mainnet.chain)).rejects.toThrow("a mainnet chain view settles no preprod attempt");
    expect(journal.live(key)).toMatchObject({ state: "landed", height: 7, blockHash: ORPHANED });
    await expect(journal.relocate(fixture.hiding.txHash, mainnet.chain)).rejects.toThrow(`the journal holds no transaction ${fixture.hiding.txHash}`);
    journal.close();
  });
});

describe("chainView over a Midnight source", () => {
  const TIMESTAMP_NOW = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";
  const HEAD = { height: 10, hash: "ef".repeat(32), timestamp: Date.UTC(2030, 0, 2) };
  const FINALIZED = `0x${"fa".repeat(32)}`;
  const timestamp = (ms: number) => `0x${Buffer.from(u64le(BigInt(ms))).toString("hex")}`;
  // An indexer whose newest block is HEAD, and a node that holds `nodeHash` at HEAD's height and
  // `below` at the height under it, records `nodeNow` (by default `nodeTime`, encoded) as HEAD's
  // Timestamp.Now, has finalized its chain up to height `finalized` (holding no header for its
  // finalized head when null), and reads its ledger in the blocks `ledgerIn`, by default HEAD,
  // holding a contract at each address in `contracts` and answering for any other as
  // midnight-node `version` does.
  const source = ({
    nodeHash = `0x${HEAD.hash}`,
    below = `0x${"99".repeat(32)}`,
    nodeTime = HEAD.timestamp,
    nodeNow = nodeTime === null ? null : timestamp(nodeTime),
    finalized = HEAD.height,
    ledgerIn = [HEAD.hash],
    contracts = [fixture.registry.address],
    version = "2.1.0",
  }: {
    nodeHash?: string | null;
    below?: string | null;
    nodeTime?: number | null;
    nodeNow?: string | null;
    finalized?: number | null;
    ledgerIn?: string[];
    contracts?: string[];
    version?: NodeVersion;
  } = {}) => {
    const calls: Array<[string, unknown[]]> = [];
    const ledger = ledgerNode({ blocks: ledgerIn, contracts: (address) => (contracts.includes(address) ? "0102" : undefined), version });
    const call = async (method: string, params: unknown[] = []) => {
      calls.push([method, params]);
      if (method === "chain_getBlockHash" && params[0] === HEAD.height) return nodeHash;
      if (method === "chain_getBlockHash" && params[0] === HEAD.height - 1) return below;
      if (method === "chain_getFinalizedHead") return FINALIZED;
      if (method === "chain_getHeader" && params[0] === FINALIZED) return finalized === null ? null : { number: `0x${finalized.toString(16)}` };
      if (method === "state_getStorage" && params[0] === TIMESTAMP_NOW && params[1] === `0x${HEAD.hash}`) return nodeNow;
      if (method === "midnight_zswapStateRoot" || method === "midnight_contractState") return ledger.call("test", method, params);
      throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
    };
    const s = {
      indexer: {
        transactions: async (hash: string) =>
          hash === fixture.anchor.txHash
            ? [{ hash, raw: "", block: { height: 9, hash: "cd".repeat(32), timestamp: 0 }, status: "SUCCESS", contractActions: [] }]
            : [],
        head: async () => HEAD,
      },
      node: { call, batch: batchOver(call) },
    } as unknown as MidnightSource;
    return { s, calls };
  };

  it("reads a transaction's status and block from the indexer", async () => {
    const view = chainView(source().s, "preprod");
    expect(await view.lookup(fixture.anchor.txHash)).toEqual({ status: "SUCCESS", height: 9, blockHash: "cd".repeat(32) });
    expect(await view.lookup(fixture.hiding.txHash)).toBeNull();
  });

  it("reads chain time from the indexer's newest block only as the node records that block: on its chain, at its own Timestamp.Now", async () => {
    const agreed = source();
    expect(await chainView(agreed.s, "preprod").indexedThrough()).toEqual({ hash: HEAD.hash, time: new Date(HEAD.timestamp) });
    expect(agreed.calls).toEqual([
      ["chain_getBlockHash", [HEAD.height]],
      ["state_getStorage", [TIMESTAMP_NOW, `0x${HEAD.hash}`]],
    ]);
    expect(await chainView(source({ nodeTime: HEAD.timestamp - 60_000 }).s, "preprod").indexedThrough()).toEqual({ hash: HEAD.hash, time: new Date(HEAD.timestamp - 60_000) });
  });

  it("reads the indexer's time for its newest block when the node records a later one there", async () => {
    expect(await chainView(source({ nodeTime: HEAD.timestamp + 60_000 }).s, "preprod").indexedThrough()).toEqual({ hash: HEAD.hash, time: new Date(HEAD.timestamp) });
  });

  it("refuses a node that records no Timestamp.Now in a block it holds", async () => {
    await expect(chainView(source({ nodeTime: null }).s, "preprod").indexedThrough()).rejects.toThrow(`the node holds no Timestamp.Now in block ${HEAD.height}`);
  });

  it("refuses a Timestamp.Now that is not exactly a u64", async () => {
    await expect(chainView(source({ nodeNow: `${timestamp(HEAD.timestamp)}00` }).s, "preprod").indexedThrough()).rejects.toThrow("Timestamp.Now has 1 trailing byte");
  });

  it.each(["2.1.0", "1.0.400"] as const)("asks node %s whether it holds a contract at an address in a given block, behind the ledger's zswap root there", async (version) => {
    const { s, calls } = source({ version });
    const view = chainView(s, "preprod");
    expect(await view.holdsContract(fixture.registry.address, HEAD.hash)).toBe(true);
    expect(await view.holdsContract("12".repeat(32), HEAD.hash)).toBe(false);
    expect(calls).toEqual([
      ["midnight_zswapStateRoot", [`0x${HEAD.hash}`]],
      ["midnight_contractState", [fixture.registry.address, `0x${HEAD.hash}`]],
      ["midnight_zswapStateRoot", [`0x${HEAD.hash}`]],
      ["midnight_contractState", ["12".repeat(32), `0x${HEAD.hash}`]],
    ]);
  });

  it("settles a deploy row past its TTL plus the margin from the node's ledger at the indexer's newest block: pending while the node cannot read it there, landed while node 2.1.0 holds the contract, retired once it answers that none is there", async () => {
    const journal = openJournal(file(), { ttlMarginMillis: 5 * MINUTE });
    const net = network();
    await journal.submitOnce(deployKey, { prepare: prepared("registry", { n: 0 }), broadcast: net.send("registry"), chain: net.chain });
    const behind = source({ ledgerIn: [], contracts: [] });
    await expect(journal.reconcile(chainView(behind.s, "preprod"))).rejects.toThrow('test node: midnight_zswapStateRoot failed: {"code":-32602,"message":"Unable to get requested zswap state root"}');
    expect(journal.live(deployKey)).toMatchObject({ txHash: fixture.registry.txHash, state: "pending" });
    expect(await journal.reconcile(chainView(source({ contracts: [] }).s, "preprod"))).toEqual([expect.objectContaining({ txHash: fixture.registry.txHash, state: "failed" })]);
    expect(journal.live(deployKey)).toBeUndefined();

    const landed = openJournal(file(), { ttlMarginMillis: 5 * MINUTE });
    await landed.submitOnce(deployKey, { prepare: prepared("registry", { n: 0 }), broadcast: net.send("registry"), chain: net.chain });
    expect(await landed.reconcile(chainView(source().s, "preprod"))).toEqual([expect.objectContaining({ txHash: fixture.registry.txHash, state: "landed" })]);
    journal.close();
    landed.close();
  });

  it("names the block the node's finalized chain holds at a height up to its finalized head, and none above it", async () => {
    const below = source({ finalized: HEAD.height - 1 });
    const view = chainView(below.s, "preprod");
    expect(await view.finalHash(HEAD.height - 1)).toBe("99".repeat(32));
    expect(await view.finalHash(HEAD.height)).toBeNull();
    expect(below.calls.filter(([method]) => method === "chain_getBlockHash")).toEqual([["chain_getBlockHash", [HEAD.height - 1]]]);
    expect(await chainView(source().s, "preprod").finalHash(HEAD.height)).toBe(HEAD.hash);
  });

  it("refuses a node that holds no header for its finalized head, or no block below it", async () => {
    await expect(chainView(source({ finalized: null }).s, "preprod").finalHash(HEAD.height)).rejects.toThrow(`the node holds no header for its finalized head ${FINALIZED}`);
    await expect(chainView(source({ below: null }).s, "preprod").finalHash(HEAD.height - 1)).rejects.toThrow(`the node holds no block ${HEAD.height - 1}, below its finalized head ${HEAD.height}`);
  });

  it("proves no chain time while the node holds another block at the indexer's newest height, or none yet", async () => {
    expect(await chainView(source({ nodeHash: `0x${"12".repeat(32)}` }).s, "preprod").indexedThrough()).toBeNull();
    expect(await chainView(source({ nodeHash: null }).s, "preprod").indexedThrough()).toBeNull();
  });

  it("names the network it reads, and settles none of another network's rows: a preprod node holding a contract at a mainnet deploy's address leaves that deploy pending", async () => {
    const journal = openJournal(file());
    const mainnet = network("mainnet");
    const mainnetDeploy: AnchorKey = { ...deployKey, network: "mainnet" };
    await journal.submitOnce(mainnetDeploy, { prepare: prepared("registry", { n: 0 }), broadcast: mainnet.send("registry"), chain: mainnet.chain });
    const { s, calls } = source();
    const preprod = chainView(s, "preprod");
    expect(await journal.reconcile(preprod)).toEqual([]);
    expect(calls).toEqual([]);
    expect(journal.live(mainnetDeploy)).toMatchObject({ txHash: fixture.registry.txHash, state: "pending" });
    expect(preprod.network).toBe("preprod");
    journal.close();
  });

  it("keeps a row pending past its TTL by the indexer's clock while the node does not hold the indexer's newest block", async () => {
    const journal = openJournal(file());
    const net = network();
    const count = { n: 0 };
    await journal.submitOnce(key, { prepare: prepared("hiding", count), broadcast: net.send("hiding"), chain: net.chain });
    const forked = source({ nodeHash: `0x${"12".repeat(32)}`, nodeTime: TTL.getTime() + 60 * MINUTE });
    const pastTtl = { ...forked.s, indexer: { ...forked.s.indexer, head: async () => ({ ...HEAD, timestamp: TTL.getTime() + 60 * MINUTE }) } } as MidnightSource;
    expect(await journal.reconcile(chainView(pastTtl, "preprod"))).toEqual([expect.objectContaining({ txHash: fixture.hiding.txHash, state: "pending" })]);
    journal.close();
  });
});
