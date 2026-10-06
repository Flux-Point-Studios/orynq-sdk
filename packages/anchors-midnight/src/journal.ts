import { closeSync, constants, openSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as L from "@midnight-ntwrk/ledger-v8";
import { fromHex, ScaleReader } from "./scale.js";
import type { MidnightSource } from "./source.js";

// One anchor request: at most one live (pending or landed) attempt exists per key.
export interface AnchorKey {
  network: string;
  registry: string;
  author: string;
  kind: number;
  commitment: string;
  attribute: string;
}

// A transaction ready to send: its final, balanced, bound bytes and its intent's TTL.
export interface Submission {
  bytes: Uint8Array;
  ttl: Date;
}

export interface ChainView {
  lookup(txHash: string): Promise<{ status: "SUCCESS" | "PARTIAL_SUCCESS" | "FAILURE"; height: number; blockHash: string } | null>;
  // The newest block the indexer has read, once the node holds it: its hash, and its time as the
  // node records it. A transaction the indexer has not seen by a time past its TTL can no longer
  // be included. Null while the node holds no such block.
  indexedThrough(): Promise<{ hash: string; time: Date } | null>;
  // Whether the node's own state at block `at` shows that `bytes` took effect. Asked at the block
  // whose time would retire a row the indexer has not seen, so a lookup answered from an older
  // indexer snapshot than that block never retires a transaction that landed. Without it, the
  // indexer's word alone retires the row.
  tookEffect?(bytes: Uint8Array, at: string): Promise<boolean>;
}

export interface JournalRow {
  txHash: string;
  state: "pending" | "landed" | "failed";
  ttl: Date;
  broadcasts: number;
  height?: number;
  blockHash?: string;
}

const SCHEMA = `
create table if not exists attempts (
  id integer primary key,
  key text not null,
  tx_hash text not null unique,
  bytes blob not null,
  ttl_ms integer not null,
  state text not null check (state in ('pending', 'landed', 'failed')),
  broadcasts integer not null default 0,
  height integer,
  block_hash text
);
create unique index if not exists one_live_attempt on attempts(key) where state != 'failed';
`;

interface Row {
  tx_hash: string;
  bytes: Uint8Array;
  ttl_ms: number;
  state: JournalRow["state"];
  broadcasts: number;
  height: number | null;
  block_hash: string | null;
}

const keyOf = (k: AnchorKey) => [k.network, k.registry, k.author, k.kind, k.commitment, k.attribute].join("/");
const view = (r: Row): JournalRow => ({
  txHash: r.tx_hash,
  state: r.state,
  ttl: new Date(r.ttl_ms),
  broadcasts: r.broadcasts,
  ...(r.height === null ? {} : { height: r.height }),
  ...(r.block_hash === null ? {} : { blockHash: r.block_hash }),
});

const hashOf = (bytes: Uint8Array) => {
  try {
    return L.Transaction.deserialize("signature", "proof", "binding", bytes).transactionHash();
  } catch (error) {
    throw new Error(`the prepared bytes are not a final Midnight transaction: ${(error as Error).message}`);
  }
};

// A write-ahead journal of anchor submissions in SQLite. A row is written, with the hash of
// the exact bytes, before those bytes are broadcast, so a broadcast that fails, times out after
// the node accepted it, or dies with the process is answered later by its hash and never sent
// as a second transaction. A pending row is retired only when the indexer reports its
// transaction, or has read past its TTL plus `ttlMarginMillis` in chain time without seeing it
// and the chain view, where it can tell, finds that its bytes took no effect by then. A row whose
// bytes did take effect is landed, with no block until the indexer lists its transaction.
export function openJournal(path: string, { ttlMarginMillis = 5 * 60_000 }: { ttlMarginMillis?: number } = {}) {
  // Final bytes are a bearer instrument until they land or expire, so only the owner may read
  // the journal; SQLite gives its -wal and -shm files the same mode.
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (statSync(path).mode & 0o077) throw new Error(`${path} can be read or written by group or others`);
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma synchronous = full; pragma busy_timeout = 10000;");
  db.exec(SCHEMA);
  const live = db.prepare("select * from attempts where key = ? and state != 'failed'");
  const insert = db.prepare("insert into attempts (key, tx_hash, bytes, ttl_ms, state) values (?, ?, ?, ?, 'pending')");
  const settle = db.prepare("update attempts set state = ?, height = ?, block_hash = ? where tx_hash = ?");
  const sent = db.prepare("update attempts set broadcasts = broadcasts + 1 where tx_hash = ?");
  const byHash = db.prepare("select * from attempts where tx_hash = ?");
  const history = db.prepare("select * from attempts where key = ? order by id");
  const pending = db.prepare("select * from attempts where state = 'pending' order by id");
  let queue: Promise<unknown> = Promise.resolve();

  // Counts only a broadcast that returned: a row with none is resent, since its bytes may never
  // have left; a row with one waits for the indexer instead.
  const broadcastRow = async (row: Row, broadcast: (bytes: Uint8Array) => Promise<void>) => {
    await broadcast(new Uint8Array(row.bytes));
    sent.run(row.tx_hash);
    return view(byHash.get(row.tx_hash) as unknown as Row);
  };

  // Settles a pending row from the chain; returns it when it stays live, null once it failed.
  const reconcile = async (row: Row, chain: ChainView): Promise<Row | null> => {
    const seen = await chain.lookup(row.tx_hash);
    if (seen?.status === "SUCCESS") settle.run("landed", seen.height, seen.blockHash, row.tx_hash);
    else if (seen) settle.run("failed", seen.height, seen.blockHash, row.tx_hash);
    else {
      const head = await chain.indexedThrough();
      if (head && head.time.getTime() > row.ttl_ms + ttlMarginMillis) {
        const tookEffect = (await chain.tookEffect?.(new Uint8Array(row.bytes), head.hash)) ?? false;
        settle.run(tookEffect ? "landed" : "failed", null, null, row.tx_hash);
      }
    }
    const after = byHash.get(row.tx_hash) as unknown as Row;
    return after.state === "failed" ? null : after;
  };

  const once = async (
    key: AnchorKey,
    { prepare, broadcast, chain }: { prepare: () => Promise<Submission>; broadcast: (bytes: Uint8Array) => Promise<void>; chain: ChainView },
  ): Promise<JournalRow> => {
    const k = keyOf(key);
    const existing = live.get(k) as unknown as Row | undefined;
    if (existing) {
      const row = existing.state === "pending" ? await reconcile(existing, chain) : existing;
      if (row?.state === "landed" || (row && row.broadcasts > 0)) return view(row);
      if (row) return broadcastRow(row, broadcast);
    }
    const { bytes, ttl } = await prepare();
    const txHash = hashOf(bytes);
    try {
      insert.run(k, txHash, bytes, ttl.getTime());
    } catch (error) {
      const other = live.get(k) as unknown as Row | undefined;
      if (other) return view(other);
      throw error;
    }
    return broadcastRow(byHash.get(txHash) as unknown as Row, broadcast);
  };

  // One operation at a time per journal: a wallet must never balance two at once. The caller
  // receives each operation's error; the queue only waits for it to settle.
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    submitOnce: (key: AnchorKey, how: Parameters<typeof once>[1]): Promise<JournalRow> => serialized(() => once(key, how)),
    // Settles every pending row from the chain by its txHash, after a restart or while waiting
    // for inclusion; nothing is prepared or broadcast. Returns those rows as they now stand.
    reconcile: (chain: ChainView): Promise<JournalRow[]> =>
      serialized(async () => {
        const rows = pending.all() as unknown as Row[];
        for (const row of rows) await reconcile(row, chain);
        return rows.map((row) => view(byHash.get(row.tx_hash) as unknown as Row));
      }),
    history: (key: AnchorKey) => (history.all(keyOf(key)) as unknown as Row[]).map(view),
    // The key's live attempt with the exact bytes it holds, so a caller that lost its own record
    // can resume that attempt instead of preparing one the journal would refuse.
    live: (key: AnchorKey): (JournalRow & { bytes: Uint8Array }) | undefined => {
      const row = live.get(keyOf(key)) as unknown as Row | undefined;
      return row && { ...view(row), bytes: new Uint8Array(row.bytes) };
    },
    pending: () => (pending.all() as unknown as Row[]).map(view),
    close: () => db.close(),
  };
}

export type Journal = ReturnType<typeof openJournal>;

// pallet_timestamp's Now: twox128("Timestamp") ++ twox128("Now").
const TIMESTAMP_NOW = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";

// The chain as a journal reads it through a source: transactions from its indexer, and chain
// time from the indexer's newest block only once the node holds that block on its own chain.
// Until then there is no chain time, so an indexer that is forked, foreign or ahead of the node
// never retires a row.
export function chainView(source: MidnightSource): ChainView {
  return {
    async lookup(txHash) {
      const [tx] = (await source.indexer.transactions(txHash)).filter((t) => t.hash === txHash);
      if (!tx) return null;
      return { status: tx.status ?? "FAILURE", height: tx.block.height, blockHash: tx.block.hash };
    },
    async indexedThrough() {
      const head = await source.indexer.head();
      const onNode = await source.node.call<string | null>("chain_getBlockHash", [head.height]);
      if (onNode?.replace(/^0x/, "") !== head.hash) return null;
      const now = await source.node.call<string | null>("state_getStorage", [TIMESTAMP_NOW, `0x${head.hash}`]);
      if (now === null) throw new Error(`the node holds no Timestamp.Now in block ${head.height}`);
      const reader = new ScaleReader(fromHex(now, "Timestamp.Now"), "Timestamp.Now");
      const recorded = reader.u64();
      reader.end();
      return { hash: head.hash, time: new Date(Math.min(head.timestamp, Number(recorded))) };
    },
  };
}
