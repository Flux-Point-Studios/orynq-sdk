import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeAnchorTransaction, type MidnightNetwork } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { TTL_MARGIN_MILLIS, type ChainView } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { declaredFee, finalTransaction } from "../src/submission.js";
import type { FollowerBlock } from "./follower-block.js";
import type { ConfirmedFee, StandingFeeFacts } from "./standing-budget.js";

interface Scope { network: MidnightNetwork; genesis: string; registry: string; author: string; policyDigest: string; runtimeSpecVersion: number }
interface BlockRow { height: number; hash: string; parent_hash: string; timestamp: number; digest: string }
interface Observation { height: number; blockHash: string; extrinsicIndex: number; txHash: string; status: "SUCCESS" | "PARTIAL_SUCCESS" | "FAILURE"; fee: bigint; policyKey: boolean }
interface AttemptRow { tx_hash: string; bytes: Uint8Array; ttl: number; fee: string; commitment: string; boundary_height: number; boundary_hash: string }
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const SCHEMA = `
create table follower_scope(id integer primary key check(id=1),scope text not null);
create table follower_blocks(height integer primary key,hash text not null unique,parent_hash text not null,timestamp integer not null,digest text not null);
create table follower_observations(block_hash text not null references follower_blocks(hash),extrinsic_index integer not null,tx_hash text not null,status text not null check(status in ('SUCCESS','PARTIAL_SUCCESS','FAILURE')),fee text not null,policy_key integer not null check(policy_key in (0,1)),primary key(block_hash,extrinsic_index)) without rowid;
create index follower_transactions on follower_observations(tx_hash);
create index follower_policy_fees on follower_observations(policy_key,block_hash);
create table follower_attempts(tx_hash text primary key,bytes blob not null,ttl integer not null,fee text not null,commitment text not null,boundary_height integer not null,boundary_hash text not null);
`;

// The caller records only complete results returned by verifyFollowerBlock.
export function openFollowerState(path: string, input: Scope) {
  const scope: Scope = { network: input.network, genesis: input.genesis, registry: input.registry, author: input.author, policyDigest: input.policyDigest, runtimeSpecVersion: input.runtimeSpecVersion };
  if (!["mainnet", "preprod"].includes(scope.network) || ![scope.genesis, scope.registry, scope.author, scope.policyDigest].every(isHash) || scope.runtimeSpecVersion !== 1000300) throw new Error("Invalid follower scope");
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.mode & 0o077 || (process.getuid && parent.uid !== process.getuid())) throw new Error("Follower directory must be private and owned by the caller");
  const guard = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let db: DatabaseSync;
  try {
    const stat = fstatSync(guard);
    if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Follower file must be private and owned by the caller");
    db = new DatabaseSync(path);
  } finally { closeSync(guard); }
  let initializing = false;
  try {
    db.exec("pragma busy_timeout=10000; pragma foreign_keys=on; pragma synchronous=full; begin immediate"); initializing = true;
    const version = db.prepare("pragma user_version").get()!.user_version;
    if (version === 0) {
      if (db.prepare("select 1 from sqlite_master where type='table' and name not like 'sqlite_%'").get()) throw new Error("Existing follower database has no schema version");
      db.exec(SCHEMA); db.prepare("insert into follower_scope(id,scope) values(1,?)").run(JSON.stringify(scope)); db.exec("pragma user_version=1");
    } else if (version !== 1) throw new Error("Unsupported follower schema version");
    const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all().map(row => row.name).join(",");
    if (tables !== "follower_attempts,follower_blocks,follower_observations,follower_scope") throw new Error("Follower schema tables differ");
    if (db.prepare("select scope from follower_scope where id=1").get()?.scope !== JSON.stringify(scope)) throw new Error("Follower scope differs");
    db.exec("commit"); initializing = false; db.exec("pragma journal_mode=wal");
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) { try { if (initializing) db.exec("rollback"); } finally { db.close(); } throw error; }
  const transaction = <T>(run: () => T) => {
    db.exec("begin immediate"); try { const result = run(); db.exec("commit"); return result; } catch (error) { db.exec("rollback"); throw error; }
  };
  const headRow = () => db.prepare("select * from follower_blocks order by height desc limit 1").get() as unknown as BlockRow | undefined;
  const head = () => { const row = headRow(); return row ? { height: row.height, hash: row.hash } : null; };
  const attemptRow = (txHash: string) => db.prepare("select * from follower_attempts where tx_hash=?").get(txHash) as unknown as AttemptRow | undefined;
  function observations(txHash: string, through = Number.MAX_SAFE_INTEGER): Observation[] {
    return db.prepare("select o.*,b.height from follower_observations o join follower_blocks b on b.hash=o.block_hash where o.tx_hash=? and b.height<=? order by b.height,o.extrinsic_index").all(txHash, through).map(row => ({ height: Number(row.height), blockHash: String(row.block_hash), extrinsicIndex: Number(row.extrinsic_index), txHash: String(row.tx_hash), status: row.status as Observation["status"], fee: BigInt(String(row.fee)), policyKey: row.policy_key === 1 }));
  }
  function complete(boundary: { height: number; hash: string }, through: BlockRow) {
    const first = db.prepare("select hash from follower_blocks where height=?").get(boundary.height), last = db.prepare("select hash from follower_blocks where height=?").get(through.height);
    const count = db.prepare("select count(*) as count from follower_blocks where height>=? and height<=?").get(boundary.height, through.height)!.count;
    if (count !== through.height - boundary.height + 1 || first?.hash !== boundary.hash || last?.hash !== through.hash) throw new Error("Follower coverage interval is incomplete");
    if (db.prepare("select 1 from follower_blocks b left join follower_blocks p on p.height=b.height-1 where b.height>? and b.height<=? and (p.height is null or b.parent_hash<>p.hash or b.timestamp<p.timestamp) limit 1").get(boundary.height, through.height)) throw new Error("Follower coverage interval is not contiguous");
  }
  function feeFacts(): StandingFeeFacts {
    const snapshot = headRow(), floor = db.prepare("select * from follower_blocks order by height limit 1").get() as unknown as BlockRow | undefined;
    if (!snapshot || !floor || floor.timestamp > snapshot.timestamp - 24 * 60 * 60_000) throw new Error("Standing accounting requires a complete authenticated 24-hour day");
    complete({ height: floor.height, hash: floor.hash }, snapshot);
    const confirmations: ConfirmedFee[] = [];
    for (const row of db.prepare("select * from follower_attempts order by tx_hash").all() as unknown as AttemptRow[]) {
      const parsed = finalTransaction(row.bytes), deadlines = [...(parsed.intents?.values() ?? [])].map(intent => intent.ttl.getTime());
      if (parsed.transactionHash() !== row.tx_hash || !deadlines.length || Math.max(...deadlines) !== row.ttl) throw new Error("Stored attempt identity or serialized TTL differs");
      const boundary = db.prepare("select timestamp from follower_blocks where height=? and hash=?").get(row.boundary_height, row.boundary_hash);
      if (!boundary || row.boundary_height < floor.height || row.boundary_height > snapshot.height) throw new Error("Stored attempt boundary is outside authenticated coverage");
      const seen = observations(row.tx_hash, snapshot.height);
      const state: ConfirmedFee["state"] = seen.some(observation => observation.status === "PARTIAL_SUCCESS") ? "unknown" : seen.some(observation => observation.status === "SUCCESS") ? "landed" : snapshot.timestamp > row.ttl + TTL_MARGIN_MILLIS ? "absent" : "unknown";
      const confirmation = { txHash: row.tx_hash, fee: BigInt(row.fee), confirmedAt: Number(boundary.timestamp), validUntil: row.ttl, state };
      confirmations.push(confirmation);
      const exactFee = declaredFee(parsed);
      if (exactFee !== confirmation.fee) confirmations.push({ ...confirmation, fee: exactFee });
    }
    const paid = db.prepare("select o.tx_hash,o.fee,b.timestamp from follower_observations o join follower_blocks b on b.hash=o.block_hash where o.policy_key=1 and b.height<=? and b.timestamp>=? order by b.height,o.extrinsic_index").all(snapshot.height, snapshot.timestamp - 24 * 60 * 60_000);
    return { chainTime: snapshot.timestamp, confirmations, observations: paid.map(row => ({ txHash: String(row.tx_hash), fee: BigInt(String(row.fee)), atMillis: Number(row.timestamp) })) };
  }
  return {
    head,
    observations,
    feeFacts: () => transaction(feeFacts),
    recordVerifiedBlock(block: FollowerBlock) {
      if (block.network !== scope.network || block.policyDigest !== scope.policyDigest) throw new Error("Verified follower block scope differs from the durable trust policy");
      if (!Number.isSafeInteger(block.block.height) || block.block.height < 1 || !isHash(block.block.hash) || !isHash(block.parentHash) || !Number.isSafeInteger(block.timestamp) || block.timestamp < 0 || block.runtimeSpecVersion !== scope.runtimeSpecVersion || !Array.isArray(block.sends) || block.sends.length > 65_536) throw new Error("Invalid follower block facts");
      const indices = new Set<number>();
      const sends = block.sends.map(send => {
        if (!Number.isSafeInteger(send.extrinsicIndex) || send.extrinsicIndex < 0 || send.extrinsicIndex >= 65_536 || indices.has(send.extrinsicIndex) || !["SUCCESS", "PARTIAL_SUCCESS", "FAILURE"].includes(send.status)) throw new Error("Invalid follower send facts");
        indices.add(send.extrinsicIndex);
        const decoded = decodeAnchorTransaction(send.bytes, []), final = finalTransaction(send.bytes);
        if (decoded.txHash !== send.txHash) throw new Error("Follower send hash differs");
        let policyKey = false;
        try { policyKey = decodeAnchorTransaction(send.bytes, [scope.registry]).calls.some(call => call.author === scope.author && call.kind === 3 && call.entryPoint === "anchor"); }
        catch { policyKey = false; }
        return { ...send, bytes: new Uint8Array(send.bytes), fee: declaredFee(final), policyKey };
      });
      const digest = hash(JSON.stringify({ height: block.block.height, hash: block.block.hash, parent: block.parentHash, timestamp: block.timestamp, runtime: block.runtimeSpecVersion, sends: sends.map(send => [send.extrinsicIndex, send.txHash, hash(send.bytes), send.status, send.fee.toString(), send.policyKey]) }));
      transaction(() => {
        const previous = headRow();
        if (previous?.height === block.block.height && previous.hash === block.block.hash && previous.digest === digest) return;
        if (previous && (block.block.height !== previous.height + 1 || block.parentHash !== previous.hash || block.timestamp < previous.timestamp)) throw new Error("Follower block is not contiguous with its durable cursor");
        db.prepare("insert into follower_blocks(height,hash,parent_hash,timestamp,digest) values(?,?,?,?,?)").run(block.block.height, block.block.hash, block.parentHash, block.timestamp, digest);
        const insert = db.prepare("insert into follower_observations(block_hash,extrinsic_index,tx_hash,status,fee,policy_key) values(?,?,?,?,?,?)");
        for (const send of sends) insert.run(block.block.hash, send.extrinsicIndex, send.txHash, send.status, send.fee.toString(), Number(send.policyKey));
      });
    },
    // Never assign new provenance to an unregistered restored journal row.
    recordAttempt(inputBytes: Uint8Array) {
      const bytes = new Uint8Array(inputBytes), decoded = decodeAnchorTransaction(bytes, [scope.registry]), final = finalTransaction(bytes), call = decoded.calls[0];
      if (decoded.touches.length || decoded.calls.length !== 1 || call!.kind !== 3 || call!.entryPoint !== "anchor" || call!.author !== scope.author) throw new Error("Attempt is outside the standing batch scope");
      const deadlines = [...(final.intents?.values() ?? [])].map(intent => intent.ttl.getTime());
      if (!deadlines.length || deadlines.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("Attempt has no valid serialized TTL");
      const ttl = Math.max(...deadlines), fee = declaredFee(final).toString();
      transaction(() => {
        const previous = attemptRow(decoded.txHash);
        if (previous) {
          if (!Buffer.from(previous.bytes).equals(bytes) || previous.ttl !== ttl || previous.fee !== fee || previous.commitment !== call!.commitment) throw new Error("Immutable attempt provenance differs");
          return;
        }
        const boundary = headRow(); if (!boundary) throw new Error("Attempt needs a verified prebroadcast boundary");
        db.prepare("insert into follower_attempts(tx_hash,bytes,ttl,fee,commitment,boundary_height,boundary_hash) values(?,?,?,?,?,?,?)").run(decoded.txHash, bytes, ttl, fee, call!.commitment, boundary.height, boundary.hash);
      });
    },
    assertRecorded(bytes: Uint8Array) {
      const decoded = decodeAnchorTransaction(bytes, []), row = attemptRow(decoded.txHash);
      if (!row || !Buffer.from(row.bytes).equals(bytes)) throw new Error("Exact broadcast bytes have no recorded provenance");
    },
    attempt(txHash: string) {
      const row = attemptRow(txHash); return row ? { txHash: row.tx_hash, ttl: row.ttl, fee: BigInt(row.fee), commitment: row.commitment, boundary: { height: row.boundary_height, hash: row.boundary_hash } } : null;
    },
    chainView(): ChainView {
      const snapshot = headRow();
      return {
        network: scope.network,
        async lookup(txHash) {
          if (!snapshot) throw new Error("Follower has no authenticated head");
          const seen = observations(txHash, snapshot.height);
          if (seen.some(row => row.status === "PARTIAL_SUCCESS")) throw new Error("HOLD: partial execution retains its claims and fee");
          const success = seen.find(row => row.status === "SUCCESS");
          if (success) return { status: "SUCCESS", height: success.height, blockHash: success.blockHash };
          const attempt = attemptRow(txHash);
          if (!attempt) throw new Error("HOLD: unknown transaction has no prebroadcast provenance");
          complete({ height: attempt.boundary_height, hash: attempt.boundary_hash }, snapshot);
          if (seen.length && snapshot.timestamp <= attempt.ttl + TTL_MARGIN_MILLIS) throw new Error("HOLD: failed dispatch may replay before expiry");
          return null;
        },
        async indexedThrough() { return snapshot ? { hash: snapshot.hash, time: new Date(snapshot.timestamp) } : null; },
        async finalHash(height) { if (!snapshot || !Number.isSafeInteger(height) || height < 0 || height > snapshot.height) return null; const row = db.prepare("select hash from follower_blocks where height=?").get(height); return row ? String(row.hash) : null; },
        async holdsContract() { throw new Error("Standing reconciliation does not authorize deploys"); },
      };
    },
    close() { db.close(); },
  };
}
