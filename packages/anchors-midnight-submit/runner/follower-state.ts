import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkpointAdvanceId, checkpointId, decodeAnchorTransaction, type CheckpointAdvance, type FinalityCheckpoint, type KnownAuthors, type MidnightNetwork } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { TTL_MARGIN_MILLIS, type ChainView } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { declaredFee, finalTransaction } from "../src/submission.js";
import { followerPolicyDigest, type FollowerBlock } from "./follower-block.js";
import { assertStandingFeeBudget, type ConfirmedFee, type StandingFeeFacts } from "./standing-budget.js";
import { assertStandingClock, type StandingClockPoint } from "./standing-clock.js";
import { assertStandingTransaction } from "./standing-transaction.js";
import { authenticateCheckpointHistory } from "./checkpoint-history.js";

interface Scope { network: MidnightNetwork; genesis: string; registry: string; author: string; policyDigest: string; runtimeSpecVersion: number }
interface BlockRow { height: number; hash: string; parent_hash: string; timestamp: number; digest: string }
interface Observation { height: number; blockHash: string; extrinsicIndex: number; txHash: string; status: "SUCCESS" | "PARTIAL_SUCCESS" | "FAILURE"; fee: bigint; policyKey: boolean }
interface AttemptRow { tx_hash: string; bytes: Uint8Array; ttl: number; fee: string; commitment: string; boundary_height: number; boundary_hash: string }
interface Admission { txHash: string; policySerial: number; head: { height: number; hash: string } }
export class StandingHistoryLost extends Error {
  constructor() { super("Standing admitted reservation history was lost"); }
}
export class StandingHeadAdvanced extends Error {
  constructor() { super("Standing follower advanced during the check; retry with its new head"); }
}
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
const ADMISSION_SCHEMA = `
alter table follower_blocks add column batch_indexed integer not null default 0 check(batch_indexed in (0,1));
create table follower_batch_calls(block_hash text not null,extrinsic_index integer not null,commitment text not null,ttl integer not null,primary key(block_hash,extrinsic_index,commitment),foreign key(block_hash,extrinsic_index) references follower_observations(block_hash,extrinsic_index)) without rowid;
create index follower_commitments on follower_batch_calls(commitment);
create table follower_admissions(tx_hash text primary key references follower_attempts(tx_hash),policy_serial integer not null,head_height integer not null,head_hash text not null);
create table follower_policies(id integer primary key check(id=1),serial integer not null,digest text not null,conflicted integer not null check(conflicted in (0,1)));
`;
const CHECKPOINT_SCHEMA = `
create table follower_checkpoints(root_id text not null,sequence integer not null check(sequence>0),digest text not null unique,artifact text not null,primary key(root_id,sequence)) without rowid;
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
      db.exec(SCHEMA); db.prepare("insert into follower_scope(id,scope) values(1,?)").run(JSON.stringify(scope));
    } else if (version !== 1 && version !== 2 && version !== 3) throw new Error("Unsupported follower schema version");
    if (version === 0 || version === 1) { db.exec(ADMISSION_SCHEMA); db.exec("pragma user_version=2"); }
    if (version === 0 || version === 1 || version === 2) { db.exec(CHECKPOINT_SCHEMA); db.exec("pragma user_version=3"); }
    const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all().map(row => row.name).join(",");
    if (tables !== "follower_admissions,follower_attempts,follower_batch_calls,follower_blocks,follower_checkpoints,follower_observations,follower_policies,follower_scope") throw new Error("Follower schema tables differ");
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
  function recordProvenance(bytes: Uint8Array, facts: { txHash: string; ttl: number; fee: bigint; commitment: string }) {
    const previous = attemptRow(facts.txHash), fee = facts.fee.toString();
    if (previous) {
      if (!Buffer.from(previous.bytes).equals(bytes) || previous.ttl !== facts.ttl || previous.fee !== fee || previous.commitment !== facts.commitment) throw new Error("Immutable attempt provenance differs");
      return;
    }
    const boundary = headRow(); if (!boundary) throw new Error("Attempt needs a verified prebroadcast boundary");
    db.prepare("insert into follower_attempts(tx_hash,bytes,ttl,fee,commitment,boundary_height,boundary_hash) values(?,?,?,?,?,?,?)").run(facts.txHash, bytes, facts.ttl, fee, facts.commitment, boundary.height, boundary.hash);
  }
  function observePolicy(authors: KnownAuthors, remembered = false) {
    if (!Number.isSafeInteger(authors.serial) || authors.serial < 1) throw new Error("Invalid standing author policy serial");
    const digest = hash(JSON.stringify([authors.serial, authors.authors(scope.network), authors.checkpoints(scope.network).map(checkpointId)]));
    const previous = db.prepare("select serial,digest,conflicted from follower_policies where id=1").get();
    if (previous && Number(previous.serial) > authors.serial) return remembered && previous.conflicted !== 1 ? null : "Standing author policy serial rewound or conflicted";
    if (previous && previous.serial === authors.serial && (previous.digest !== digest || previous.conflicted === 1)) {
      db.prepare("update follower_policies set conflicted=1 where id=1").run();
      return "Standing author policy conflict requires a newer authoritative serial";
    }
    db.prepare("insert into follower_policies(id,serial,digest,conflicted) values(1,?,?,0) on conflict(id) do update set serial=excluded.serial,digest=excluded.digest,conflicted=0").run(authors.serial, digest);
    return null;
  }
  function retainPolicy(authors: KnownAuthors, remembered = false) {
    const failure = transaction(() => observePolicy(authors, remembered));
    if (failure) throw new Error(failure);
  }
  function admissions(): Admission[] {
    return db.prepare("select a.tx_hash,a.policy_serial,a.head_height,a.head_hash from follower_admissions a join follower_attempts t on t.tx_hash=a.tx_hash order by a.tx_hash").all().map(row => ({ txHash: String(row.tx_hash), policySerial: Number(row.policy_serial), head: { height: Number(row.head_height), hash: String(row.head_hash) } }));
  }
  function assertAdmissionHistory(previous: readonly Admission[]) {
    if (!previous.length) return;
    const retained = new Map(admissions().map(row => [row.txHash, row]));
    for (const row of previous) {
      const current = retained.get(row.txHash);
      if (!current || current.policySerial < row.policySerial || current.head.height < row.head.height || (current.head.height === row.head.height && current.head.hash !== row.head.hash)) throw new StandingHistoryLost();
    }
  }
  function checkpointHistory(): CheckpointAdvance[] {
    const bounds = db.prepare("select count(*) as count,coalesce(sum(length(artifact)),0) as bytes,max(length(artifact)) as largest from follower_checkpoints").get()!;
    if (Number(bounds.count) > 4096 || Number(bounds.bytes) > 512 * 1024 * 1024 || Number(bounds.largest ?? 0) > 64 * 1024 * 1024) throw new Error("Retained checkpoint history exceeds its bounds");
    return db.prepare("select root_id,sequence,digest,artifact from follower_checkpoints order by root_id,sequence").all().map(row => {
      const artifact = JSON.parse(String(row.artifact)) as CheckpointAdvance;
      if (artifact.rootId !== row.root_id || artifact.sequence !== row.sequence || checkpointAdvanceId(artifact) !== row.digest) throw new Error("Retained checkpoint identity differs");
      return artifact;
    });
  }
  function assertRetainedHistory() {
    if (db.prepare("pragma foreign_key_check").get()) throw new Error("Checkpoint advancement found inconsistent retained references");
    const snapshot = headRow(), floor = db.prepare("select height,hash from follower_blocks order by height limit 1").get();
    if (snapshot && floor) complete({ height: Number(floor.height), hash: String(floor.hash) }, snapshot);
    for (const row of db.prepare("select boundary_height,boundary_hash from follower_attempts").all()) {
      if (!snapshot || db.prepare("select hash from follower_blocks where height=?").get(Number(row.boundary_height))?.hash !== row.boundary_hash) throw new Error("Checkpoint advancement found missing attempt history");
    }
    for (const row of db.prepare("select head_height,head_hash from follower_admissions").all()) {
      if (!snapshot || db.prepare("select hash from follower_blocks where height=?").get(Number(row.head_height))?.hash !== row.head_hash) throw new Error("Checkpoint advancement found missing admission history");
    }
  }
  return {
    scope: () => ({ ...scope }),
    coverage: () => transaction(() => {
      const floor = db.prepare("select * from follower_blocks order by height limit 1").get() as unknown as BlockRow | undefined;
      const snapshot = headRow(), boundary = db.prepare("select boundary_height,boundary_hash from follower_attempts order by boundary_height limit 1").get();
      const first = db.prepare("select * from follower_blocks where batch_indexed<>1 order by height limit 1").get() as unknown as BlockRow | undefined;
      const end = first && db.prepare("select height,hash from follower_blocks where height=?").get(Math.min(first.height + 31, snapshot!.height));
      if (first && !end) throw new Error("Follower replay interval is incomplete");
      const point = (row: BlockRow | undefined) => row ? { height: row.height, hash: row.hash, parentHash: row.parent_hash, timestamp: row.timestamp } : null;
      return { floor: point(floor), head: point(snapshot), earliestAttempt: boundary ? { height: Number(boundary.boundary_height), hash: String(boundary.boundary_hash) } : null,
        replay: first ? { after: { height: first.height - 1, hash: first.parent_hash }, end: { height: Number(end!.height), hash: String(end!.hash) } } : null };
    }),
    head,
    checkpointHistory,
    async retainCheckpointHistory(originals: readonly FinalityCheckpoint[], input: readonly CheckpointAdvance[]) {
      if (followerPolicyDigest(originals) !== scope.policyDigest) throw new Error("Checkpoint advancement original policy differs");
      // Verification happens outside SQLite's lock; the transaction rechecks every retained
      // identity afterwards, then commits the complete extension or none of it on interruption.
      const verified = await authenticateCheckpointHistory(scope.network, originals, input);
      const candidate = new Map(verified.artifacts.map(artifact => [`${artifact.rootId}:${artifact.sequence}`, checkpointAdvanceId(artifact)]));
      transaction(() => {
        assertRetainedHistory();
        for (const artifact of checkpointHistory()) if (candidate.get(`${artifact.rootId}:${artifact.sequence}`) !== checkpointAdvanceId(artifact)) throw new Error("Checkpoint history rollback, conflict or missing retained prefix");
        const insert = db.prepare("insert into follower_checkpoints(root_id,sequence,digest,artifact) values(?,?,?,?) on conflict(root_id,sequence) do nothing");
        for (const artifact of verified.artifacts) insert.run(artifact.rootId, artifact.sequence, checkpointAdvanceId(artifact), JSON.stringify(artifact));
        checkpointHistory();
      });
      return verified;
    },
    observations,
    feeFacts: () => transaction(feeFacts),
    admissions,
    commitments: () => {
      const rows = db.prepare("select commitment from follower_attempts union select commitment from follower_batch_calls order by commitment limit 262145").all();
      if (rows.length > 262144) throw new Error("Follower commitment history exceeds repair bounds");
      return rows.map(row => String(row.commitment));
    },
    assertAdmissionHistory,
    observeStandingPolicy: (authors: KnownAuthors) => retainPolicy(authors),
    rememberStandingPolicy: (authors: KnownAuthors) => retainPolicy(authors, true),
    recordVerifiedBlock(block: FollowerBlock) {
      if (block.network !== scope.network || block.policyDigest !== scope.policyDigest) throw new Error("Verified follower block scope differs from the durable trust policy");
      if (!Number.isSafeInteger(block.block.height) || block.block.height < 1 || !isHash(block.block.hash) || !isHash(block.parentHash) || !Number.isSafeInteger(block.timestamp) || block.timestamp < 0 || block.runtimeSpecVersion !== scope.runtimeSpecVersion || !Array.isArray(block.sends) || block.sends.length > 65_536) throw new Error("Invalid follower block facts");
      const indices = new Set<number>();
      const sends = block.sends.map(send => {
        if (!Number.isSafeInteger(send.extrinsicIndex) || send.extrinsicIndex < 0 || send.extrinsicIndex >= 65_536 || indices.has(send.extrinsicIndex) || !["SUCCESS", "PARTIAL_SUCCESS", "FAILURE"].includes(send.status)) throw new Error("Invalid follower send facts");
        indices.add(send.extrinsicIndex);
        const decoded = decodeAnchorTransaction(send.bytes, []), final = finalTransaction(send.bytes);
        if (decoded.txHash !== send.txHash) throw new Error("Follower send hash differs");
        let commitments: string[] = [];
        try { commitments = decodeAnchorTransaction(send.bytes, [scope.registry]).calls.filter(call => call.author === scope.author && call.kind === 3 && call.entryPoint === "anchor").map(call => call.commitment); }
        catch { commitments = []; }
        const deadlines = [...(final.intents?.values() ?? [])].map(intent => intent.ttl.getTime());
        if (commitments.length && (!deadlines.length || deadlines.some(ttl => !Number.isSafeInteger(ttl) || ttl < 0))) throw new Error("Observed batch has invalid serialized TTL");
        return { ...send, bytes: new Uint8Array(send.bytes), fee: declaredFee(final), policyKey: commitments.length !== 0, commitments: [...new Set(commitments)], ttl: Math.max(...deadlines) };
      });
      const digest = hash(JSON.stringify({ height: block.block.height, hash: block.block.hash, parent: block.parentHash, timestamp: block.timestamp, runtime: block.runtimeSpecVersion, sends: sends.map(send => [send.extrinsicIndex, send.txHash, hash(send.bytes), send.status, send.fee.toString(), send.policyKey]) }));
      transaction(() => {
        const previous = headRow();
        const existing = db.prepare("select hash,digest from follower_blocks where height=?").get(block.block.height);
        if (existing && (existing.hash !== block.block.hash || existing.digest !== digest)) throw new Error("Verified replay differs from its durable block");
        if (!existing) {
          if (previous && (block.block.height !== previous.height + 1 || block.parentHash !== previous.hash || block.timestamp < previous.timestamp)) throw new Error("Follower block is not contiguous with its durable cursor");
          db.prepare("insert into follower_blocks(height,hash,parent_hash,timestamp,digest) values(?,?,?,?,?)").run(block.block.height, block.block.hash, block.parentHash, block.timestamp, digest);
          const insert = db.prepare("insert into follower_observations(block_hash,extrinsic_index,tx_hash,status,fee,policy_key) values(?,?,?,?,?,?)");
          for (const send of sends) insert.run(block.block.hash, send.extrinsicIndex, send.txHash, send.status, send.fee.toString(), Number(send.policyKey));
        }
        const insertCall = db.prepare("insert into follower_batch_calls(block_hash,extrinsic_index,commitment,ttl) values(?,?,?,?) on conflict do nothing");
        for (const send of sends) for (const commitment of send.commitments) insertCall.run(block.block.hash, send.extrinsicIndex, commitment, send.ttl);
        db.prepare("update follower_blocks set batch_indexed=1 where height=?").run(block.block.height);
      });
    },
    // Never assign new provenance to an unregistered restored journal row.
    recordAttempt(inputBytes: Uint8Array) {
      const bytes = new Uint8Array(inputBytes), decoded = decodeAnchorTransaction(bytes, [scope.registry]), final = finalTransaction(bytes), call = decoded.calls[0];
      if (decoded.touches.length || decoded.calls.length !== 1 || call!.kind !== 3 || call!.entryPoint !== "anchor" || call!.author !== scope.author) throw new Error("Attempt is outside the standing batch scope");
      const deadlines = [...(final.intents?.values() ?? [])].map(intent => intent.ttl.getTime());
      if (!deadlines.length || deadlines.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("Attempt has no valid serialized TTL");
      transaction(() => recordProvenance(bytes, { txHash: decoded.txHash, ttl: Math.max(...deadlines), fee: declaredFee(final), commitment: call!.commitment }));
    },
    reserveStandingAttempt(inputBytes: Uint8Array, policy: { commitment: string; authors: KnownAuthors; started: StandingClockPoint; current: StandingClockPoint & { height: number; hash: string }; retainedAdmissions?: readonly Admission[] }) {
      const bytes = new Uint8Array(inputBytes);
      // A newer revocation must survive refusal of this admission.
      retainPolicy(policy.authors);
      return transaction(() => {
        assertAdmissionHistory(policy.retainedAdmissions ?? []);
        const policyFailure = observePolicy(policy.authors); if (policyFailure) throw new Error(policyFailure);
        const snapshot = headRow();
        if (!snapshot || policy.current.height !== snapshot.height || policy.current.hash !== snapshot.hash || policy.current.chainTime !== snapshot.timestamp) {
          const previous = db.prepare("select hash,timestamp from follower_blocks where height=?").get(policy.current.height);
          if (snapshot && snapshot.height > policy.current.height && previous?.hash === policy.current.hash && previous.timestamp === policy.current.chainTime && snapshot.timestamp >= policy.current.chainTime) throw new StandingHeadAdvanced();
          throw new Error("Standing clock evidence differs from the durable head");
        }
        assertStandingClock(policy.started, policy.current);
        if (followerPolicyDigest(policy.authors.checkpoints(scope.network)) !== scope.policyDigest) throw new Error("Standing author checkpoints differ from the follower finality policy");
        const admitted = assertStandingTransaction(bytes, { ...scope, commitment: policy.commitment }, { height: snapshot.height, timestamp: snapshot.timestamp, runtimeSpecVersion: scope.runtimeSpecVersion }, policy.authors);
        if (admitted.earliestTtl <= policy.current.wallTime) throw new Error("Standing serialized TTL has passed on the host clock");
        const floor = db.prepare("select height from follower_blocks order by height limit 1").get()!;
        const windows = policy.authors.authors(scope.network).filter(author => author.key === scope.author && author.role === "batch");
        if (!windows.length || Number(floor.height) > Math.max(1, Math.min(...windows.map(author => author.validFrom)))) throw new Error("Standing author commitment history is incomplete");
        if (db.prepare("select 1 from follower_blocks where batch_indexed<>1 limit 1").get()) throw new Error("Standing batch history requires authenticated indexing replay");
        const facts = feeFacts(), states = new Map(facts.confirmations.map(row => [row.txHash, row.state]));
        for (const row of db.prepare("select tx_hash from follower_attempts where commitment=? and tx_hash<>?").all(admitted.commitment, admitted.txHash)) {
          if (states.get(String(row.tx_hash)) !== "absent") throw new Error("Standing commitment has an unresolved or landed claim");
        }
        const observed = db.prepare("select o.tx_hash,o.status,c.ttl from follower_batch_calls c join follower_observations o on o.block_hash=c.block_hash and o.extrinsic_index=c.extrinsic_index where c.commitment=?").all(admitted.commitment);
        if (observed.some(row => row.status !== "FAILURE" || (row.tx_hash !== admitted.txHash && snapshot.timestamp <= Number(row.ttl) + TTL_MARGIN_MILLIS))) throw new Error("Standing commitment is held by an observed chain claim");
        assertStandingFeeBudget(facts, admitted);
        recordProvenance(bytes, admitted);
        db.prepare("insert into follower_admissions(tx_hash,policy_serial,head_height,head_hash) values(?,?,?,?) on conflict(tx_hash) do update set policy_serial=excluded.policy_serial,head_height=excluded.head_height,head_hash=excluded.head_hash").run(admitted.txHash, policy.authors.serial, snapshot.height, snapshot.hash);
        return admitted;
      });
    },
    assertAdmitted(bytes: Uint8Array) {
      const decoded = decodeAnchorTransaction(bytes, []), row = attemptRow(decoded.txHash);
      if (!row || !Buffer.from(row.bytes).equals(bytes) || !db.prepare("select 1 from follower_admissions where tx_hash=?").get(decoded.txHash)) throw new Error("Exact broadcast bytes have no standing admission");
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
