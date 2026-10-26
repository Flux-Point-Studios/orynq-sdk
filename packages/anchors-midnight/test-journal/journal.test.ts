import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openJournal, type AnchorKey, type ChainView, type Submission } from "../src/journal.js";
import { fixture } from "../src/__tests__/anchor-chain.js";

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
  const indexed = new Map<string, "SUCCESS" | "PARTIAL_SUCCESS" | "FAILURE">();
  const placed = new Map<string, { height: number; blockHash: string }>();
  const final = new Map<number, string>();
  const contracts = new Set<string>();
  const asked: Array<[string, string]> = [];
  let indexedAt = new Date("2029-12-31T23:00:00Z");
  const chain: ChainView = {
    network: name,
    lookup: async (txHash) => (indexed.has(txHash) ? { status: indexed.get(txHash)!, ...(placed.get(txHash) ?? { height: 7, blockHash: "ab".repeat(32) }) } : null),
    indexedThrough: async () => ({ height: 100, hash: INDEXED_HEAD, time: indexedAt }),
    confirm: async ({ hint }) => hint?.status === "SUCCESS" || hint?.status === "PARTIAL_SUCCESS"
      ? { state: "landed", height: hint.height, blockHash: hint.blockHash }
      : { state: "absent", through: { height: 100, hash: INDEXED_HEAD } },
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
    index: (status: "SUCCESS" | "PARTIAL_SUCCESS" | "FAILURE" = "SUCCESS") => arrived.forEach((h) => indexed.set(h, status)),
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

  it("a transaction independently proved absent through its finalized TTL window frees the key for a new attempt", async () => {
    const journal = openJournal(file());
    const net = network();
    const count = { n: 0 };
    await journal.submitOnce(key, { prepare: prepared("anchor", count), broadcast: net.send("anchor"), chain: net.chain });
    net.index("FAILURE");
    net.advance(new Date(TTL.getTime() + 6 * MINUTE));
    expect(await journal.submitOnce(key, { prepare: prepared("hiding", count), broadcast: net.send("hiding"), chain: net.chain })).toMatchObject({ txHash: fixture.hiding.txHash });
    expect(count.n).toBe(2);
    expect(net.asked).toEqual([]);
    journal.close();
  });

  it.each(["FAILURE", "PARTIAL_SUCCESS", null] as const)("an uncorroborated indexer status %s never frees a pending anchor", async status => {
    const journal = openJournal(file());
    const net = network();
    const count = { n: 0 };
    await journal.submitOnce(key, { prepare: prepared("anchor", count), broadcast: net.send("anchor"), chain: net.chain });
    net.chain.lookup = async () => ({ status, height: 7, blockHash: "ab".repeat(32) });
    net.chain.confirm = async () => ({ state: "pending" });
    net.advance(new Date(TTL.getTime() + 60 * MINUTE));
    expect(await journal.submitOnce(key, { prepare: prepared("hiding", count), broadcast: net.send("hiding"), chain: net.chain })).toMatchObject({ txHash: fixture.anchor.txHash, state: "pending" });
    expect(count.n).toBe(1); expect(net.arrived).toHaveLength(1);
    journal.close();
  });

  it("a guaranteed anchor with PARTIAL_SUCCESS remains landed when node inclusion confirms it", async () => {
    const journal = openJournal(file()); const net = network();
    await journal.submitOnce(key, { prepare: prepared("anchor", { n: 0 }), broadcast: net.send("anchor"), chain: net.chain });
    net.index("PARTIAL_SUCCESS");
    expect(await journal.reconcile(net.chain)).toEqual([expect.objectContaining({ state: "landed", txHash: fixture.anchor.txHash })]);
    journal.close();
  });

  it("legacy anchors without a pre-broadcast boundary stay held when node absence is unavailable", async () => {
    const path = file(); const journal = openJournal(path); const net = network();
    await journal.submitOnce(key, { prepare: prepared("anchor", { n: 0 }), broadcast: net.send("anchor"), chain: net.chain });
    const db = new DatabaseSync(path); db.prepare("update attempts set start_height=null,start_hash=null").run(); db.close();
    net.chain.confirm = async request => {
      expect(request.since).toBeNull(); return { state: "pending" };
    };
    net.advance(new Date(TTL.getTime() + 60 * MINUTE));
    await journal.reconcile(net.chain);
    expect(journal.live(key)?.state).toBe("pending");
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
    refused.advance(new Date(TTL.getTime() + 6 * MINUTE));
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

  it("refuses an existing symlink even when its target is an owner-only journal", () => {
    const target = file(), link = file(); openJournal(target).close(); symlinkSync(target, link);
    expect(() => openJournal(link)).toThrow(/regular journal file/);
    expect(() => openJournal(target).close()).not.toThrow();
  });

  it("never combines an older absence scan with a newer finalized clock to free a key", async () => {
    const journal = openJournal(file()), net = network();
    await journal.submitOnce(key, { prepare: prepared("anchor", { n: 0 }), broadcast: net.send("anchor"), chain: net.chain });
    net.advance(new Date(TTL.getTime() + 6 * MINUTE));
    const newer = { ...net.chain, indexedThrough: async () => ({ height: 101, hash: "ee".repeat(32), time: new Date(TTL.getTime() + 6 * MINUTE) }) };
    await journal.reconcile(newer);
    expect(journal.live(key)?.state).toBe("pending");
    expect(net.arrived).toEqual([fixture.anchor.txHash]); journal.close();
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
    expect(await journal.relocate(fixture.anchor.txHash, net.chain)).toEqual({ txHash: fixture.anchor.txHash, state: "landed", ttl: TTL, broadcasts: 1, height: 9, blockHash: ELSEWHERE, orphaned: { height: 7, hash: ORPHANED } });
    expect(journal.live(key)).toMatchObject({ state: "landed", height: 9, blockHash: ELSEWHERE });
    expect(net.arrived).toEqual([fixture.anchor.txHash]);
    journal.close();
  });

  it("is pending again while the indexer lists it nowhere, then retired once the chain carried it past its TTL plus the margin unseen, which frees its key", async () => {
    const { journal, net } = await landedAnchor();
    net.finalize(7, "11".repeat(32));
    net.forget(fixture.anchor.txHash);
    expect(await journal.relocate(fixture.anchor.txHash, net.chain)).toEqual({ txHash: fixture.anchor.txHash, state: "pending", ttl: TTL, broadcasts: 1, orphaned: { height: 7, hash: ORPHANED } });
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

