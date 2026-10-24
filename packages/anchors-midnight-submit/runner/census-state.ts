import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { censusBatch, certHash, memberSnapshot, parseMemberSnapshot, type ReceiptRecord } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { batchAnchorCommitment, type BatchMember } from "../src/batch-plan.js";
import type { Census } from "./census.js";

interface BatchEntry { kind: 3; label: string; materiosGenesis: string; batches: BatchMember[] }
export interface CensusPlan {
  commitment: string;
  state: "planned" | "confirmed" | "landed" | "abandoned";
  finalizedHash: string;
  finalizedHeight: number;
  plan: { registry: string; entries: [BatchEntry] };
  snapshots: { anchorId: string; key: string; sha256: string; body: string }[];
}
interface PlanRow { commitment: string; state: CensusPlan["state"]; finalized_hash: string; finalized_height: number; plan_json: string }
interface ObjectRow { key: string; kind: string; sha256: string; body: string; published: number; anchor_id?: string | null }
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const bare = (value: string) => value.replace(/^0x/, "");
function plannedBody(network: "mainnet" | "preprod", plan: CensusPlan["plan"], finalizedHash: string, finalizedHeight: number, snapshots: { anchorId: string; key: string; sha256: string }[]) {
  return JSON.stringify({ format: "orynq-midnight-plan/v1", network, census: { genesis: plan.entries[0].materiosGenesis, blockHeight: finalizedHeight, blockHash: finalizedHash }, plan, snapshots: snapshots.map(({ anchorId, key, sha256 }) => ({ anchorId, key, sha256 })) });
}

const SCHEMA = `
create table if not exists census_scope (id integer primary key check(id = 1), network text not null check(network in ('mainnet','preprod')), genesis text not null, registry text not null);
create table if not exists census_head (id integer primary key check(id = 1), height integer not null, hash text not null);
create table if not exists observations (receipt_id text primary key, status text not null, cert_hash text, created_ms text);
create table if not exists objects (key text primary key, kind text not null, sha256 text not null, body text not null, published integer not null default 0 check(published in (0,1)));
create table if not exists plans (commitment text primary key, state text not null check(state in ('planned','confirmed','landed','abandoned')), finalized_hash text not null, finalized_height integer not null, plan_json text not null);
create unique index if not exists one_active_plan on plans((1)) where state in ('planned','confirmed');
create table if not exists plan_objects (commitment text not null references plans(commitment), key text not null references objects(key), anchor_id text, primary key(commitment,key), unique(commitment,anchor_id));
create table if not exists claims (receipt_id text primary key, cert_hash text not null, commitment text not null references plans(commitment));
`;

export function openCensusState(path: string, scope: { network: "mainnet" | "preprod"; genesis: string; registry: string }) {
  if (!["mainnet", "preprod"].includes(scope.network) || !HASH.test(scope.genesis) || !HASH.test(scope.registry)) throw new Error("Invalid census state scope");
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.mode & 0o077 || (process.getuid && parent.uid !== process.getuid())) throw new Error("Census state directory must be private and owned by the caller");
  try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Census state file must be private and owned by the caller");
  const db = new DatabaseSync(path);
  let initializing = false;
  try {
    db.exec("pragma busy_timeout=10000; pragma foreign_keys=on; pragma synchronous=full; begin immediate;");
    initializing = true;
    const version = db.prepare("pragma user_version").get()!.user_version;
    if (version !== 0 && version !== 1) throw new Error("Unsupported census state schema version");
    const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all();
    if (version === 0) {
      if (tables.length) throw new Error("Existing database has no census schema version");
      db.exec(SCHEMA);
      db.prepare("insert into census_scope(id,network,genesis,registry) values(1,?,?,?)").run(scope.network, scope.genesis, scope.registry);
      db.exec("pragma user_version=1");
    } else if (tables.map(row => row.name).sort().join(",") !== "census_head,census_scope,claims,objects,observations,plan_objects,plans") {
      throw new Error("Census state schema tables differ");
    }
    const saved = db.prepare("select network,genesis,registry from census_scope where id=1").get();
    if (saved?.network !== scope.network || saved.genesis !== scope.genesis || saved.registry !== scope.registry) throw new Error("Census state scope differs from network, genesis or registry");
    db.exec("commit");
    initializing = false;
    db.exec("pragma journal_mode=wal;");
  } catch (error) {
    try { if (initializing) db.exec("rollback"); }
    finally { db.close(); }
    throw error;
  }

  function transaction<T>(run: () => T): T {
    db.exec("begin immediate");
    try { const result = run(); db.exec("commit"); return result; }
    catch (error) { db.exec("rollback"); throw error; }
  }
  function observe(census: Census) {
    if (census.genesis !== scope.genesis || !/^0x[a-f0-9]{64}$/.test(census.finalizedHash) || !Number.isSafeInteger(census.finalizedHeight) || census.finalizedHeight < 0) throw new Error("Invalid census epoch");
    const previous = db.prepare("select height,hash from census_head where id=1").get();
    if (previous && census.finalizedHeight < Number(previous.height)) throw new Error("Census epoch rewind refused");
    if (previous && census.finalizedHeight === previous.height && census.finalizedHash !== previous.hash) throw new Error("Conflicting finalized census epoch hash");
    const ids = new Set(census.entries.map(entry => entry.receiptId));
    if (ids.size !== census.entries.length || [...ids].some(id => !HASH.test(id))) throw new Error("Duplicate or invalid census receipt identity");
    for (const row of db.prepare("select receipt_id from observations").all()) if (!ids.has(row.receipt_id as string)) throw new Error("Previously observed receipt disappeared from census");
    const claim = db.prepare("select c.cert_hash,p.state from claims c join plans p using(commitment) where c.receipt_id=?");
    const insert = db.prepare("insert into observations(receipt_id,status,cert_hash,created_ms) values(?,?,?,?) on conflict(receipt_id) do update set status=excluded.status,cert_hash=excluded.cert_hash,created_ms=excluded.created_ms");
    for (const entry of census.entries) {
      const record = entry.status === "pending" ? null : entry.record;
      const cert = record ? bare(record.availabilityCertHash) : null;
      const prior = claim.get(entry.receiptId);
      if (prior && prior.state !== "planned" && cert !== null && cert !== prior.cert_hash) throw new Error("Claimed receipt was recertified; reconciliation required");
      insert.run(entry.receiptId, entry.status, cert, record?.createdAtMillis.toString() ?? null);
    }
    db.prepare("insert into census_head(id,height,hash) values(1,?,?) on conflict(id) do update set height=excluded.height,hash=excluded.hash").run(census.finalizedHeight, census.finalizedHash);
  }
  function putObject(kind: "members" | "plans", body: string) {
    const sha256 = digest(body), key = `${kind}/${sha256}`;
    db.prepare("insert into objects(key,kind,sha256,body) values(?,?,?,?) on conflict(key) do nothing").run(key, kind, sha256, body);
    const existing = db.prepare("select body from objects where key=?").get(key);
    if (existing?.body !== body) throw new Error("Immutable proof object conflict");
    return { key, sha256, body };
  }
  function checkedObject(row: ObjectRow) {
    if (row.sha256 !== digest(row.body) || row.key !== `${row.kind}/${row.sha256}`) throw new Error("Stored proof object digest differs");
    return { key: row.key, sha256: row.sha256, body: row.body };
  }
  function getPlan(commitment: string): CensusPlan {
    const row = db.prepare("select * from plans where commitment=?").get(commitment) as unknown as PlanRow | undefined;
    if (!row) throw new Error("Census plan does not exist");
    let plan: CensusPlan["plan"];
    try { plan = JSON.parse(row.plan_json) as CensusPlan["plan"]; }
    catch { throw new Error("Stored census plan is unreadable"); }
    if (Object.keys(plan).sort().join(",") !== "entries,registry" || plan.registry !== scope.registry || !Array.isArray(plan.entries) || plan.entries.length !== 1) throw new Error("Stored census plan scope differs");
    const entry = plan.entries[0];
    if (Object.keys(entry).sort().join(",") !== "batches,kind,label,materiosGenesis" || entry.kind !== 3 || entry.label !== commitment || entry.materiosGenesis !== scope.genesis || Buffer.from(batchAnchorCommitment(entry)).toString("hex") !== commitment) throw new Error("Stored census plan commitment differs");
    const rows = db.prepare("select o.*,r.anchor_id from plan_objects r join objects o using(key) where r.commitment=? and o.kind='members' order by r.anchor_id").all(commitment) as unknown as ObjectRow[];
    if (rows.length !== entry.batches.length) throw new Error("Census plan snapshot count differs");
    const expectedClaims = new Map<string, string>();
    const snapshots = rows.map((object, i) => {
      const checked = checkedObject(object), batch = parseMemberSnapshot(checked.body), member = entry.batches[i]!;
      if (object.anchor_id !== member.anchorId || bare(batch.anchorId) !== member.anchorId || bare(batch.rootHash) !== member.rootHash || bare(batch.manifestHash) !== member.manifestHash || batch.genesis !== scope.genesis || batch.finalizedHeight !== row.finalized_height) throw new Error("Census plan snapshot derivation differs");
      for (const receipt of batch.receipts) {
        if (expectedClaims.has(receipt.receiptId)) throw new Error("Duplicate receipt claim across snapshots");
        expectedClaims.set(receipt.receiptId, bare(certHash(receipt.certFormat, scope.genesis, receipt.receiptId, receipt)));
      }
      return { anchorId: member.anchorId, ...checked };
    });
    const planned = db.prepare("select o.*,r.anchor_id from plan_objects r join objects o using(key) where r.commitment=? and o.kind='plans'").all(commitment) as unknown as ObjectRow[];
    if (planned.length !== 1 || planned[0]!.anchor_id !== null || checkedObject(planned[0]!).body !== plannedBody(scope.network, plan, row.finalized_hash, row.finalized_height, snapshots)) throw new Error("Census planned mapping differs or is missing");
    const claims = db.prepare("select receipt_id,cert_hash from claims where commitment=?").all(commitment);
    if (row.state === "abandoned") {
      if (claims.length) throw new Error("Abandoned census plan retains claims");
    } else if (claims.length !== expectedClaims.size || claims.some(claim => expectedClaims.get(claim.receipt_id as string) !== claim.cert_hash)) {
      throw new Error("Census plan receipt claims differ from its snapshots");
    }
    return { commitment, state: row.state, finalizedHash: row.finalized_hash, finalizedHeight: row.finalized_height, plan, snapshots };
  }
  function currentPlan() {
    const row = db.prepare("select commitment from plans where state in ('planned','confirmed')").get();
    return row ? getPlan(row.commitment as string) : null;
  }

  return {
    currentPlan,
    prepare(census: Census, nowMillis: bigint): CensusPlan | null {
      if (typeof nowMillis !== "bigint" || nowMillis < 0n) throw new Error("Invalid planning chain time");
      return transaction(() => {
        observe(census);
        const active = currentPlan();
        if (active) return active;
        const claimed = new Set(db.prepare("select receipt_id from claims").all().map(row => row.receipt_id));
        const eligible = census.entries.filter((entry): entry is { receiptId: string; status: "certified"; record: ReceiptRecord } => entry.status === "certified" && !claimed.has(entry.receiptId));
        const cutoff = nowMillis - 2n * 60n * 60n * 1000n;
        eligible.sort((a, b) => {
          const recentA = a.record.createdAtMillis >= cutoff, recentB = b.record.createdAtMillis >= cutoff;
          if (recentA !== recentB) return recentA ? -1 : 1;
          if (a.record.createdAtMillis !== b.record.createdAtMillis) return a.record.createdAtMillis < b.record.createdAtMillis ? -1 : 1;
          return a.receiptId < b.receiptId ? -1 : a.receiptId > b.receiptId ? 1 : 0;
        });
        if (!eligible.length) return null;
        const selected = eligible.slice(0, 64 * 4096);
        const batches = [];
        for (let i = 0; i < selected.length; i += 4096) {
          const batch = censusBatch({ genesis: scope.genesis, finalizedHeight: census.finalizedHeight, receipts: selected.slice(i, i + 4096).map(entry => ({ ...entry.record, receiptId: entry.receiptId })) });
          batches.push({ batch, object: putObject("members", memberSnapshot(batch)) });
        }
        batches.sort((a, b) => a.batch.anchorId < b.batch.anchorId ? -1 : a.batch.anchorId > b.batch.anchorId ? 1 : 0);
        const members = batches.map(({ batch }) => ({ anchorId: bare(batch.anchorId), rootHash: bare(batch.rootHash), manifestHash: bare(batch.manifestHash) }));
        const data = { materiosGenesis: scope.genesis, batches: members };
        const commitment = Buffer.from(batchAnchorCommitment(data)).toString("hex");
        const entry: BatchEntry = { kind: 3, label: commitment, ...data };
        const plan: CensusPlan["plan"] = { registry: scope.registry, entries: [entry] };
        const previous = db.prepare("select * from plans where commitment=?").get(commitment) as unknown as PlanRow | undefined;
        if (previous) {
          if (previous.state !== "abandoned" || previous.finalized_hash !== census.finalizedHash || previous.finalized_height !== census.finalizedHeight || previous.plan_json !== JSON.stringify(plan)) throw new Error("Historical census commitment cannot be replanned");
          getPlan(commitment);
          db.prepare("update plans set state='planned' where commitment=?").run(commitment);
        } else {
          db.prepare("insert into plans(commitment,state,finalized_hash,finalized_height,plan_json) values(?,'planned',?,?,?)").run(commitment, census.finalizedHash, census.finalizedHeight, JSON.stringify(plan));
        }
        const link = db.prepare("insert into plan_objects(commitment,key,anchor_id) values(?,?,?) on conflict(commitment,key) do nothing");
        for (const { batch, object } of batches) link.run(commitment, object.key, bare(batch.anchorId));
        const planned = putObject("plans", plannedBody(scope.network, plan, census.finalizedHash, census.finalizedHeight, batches.map(({ batch, object }) => ({ anchorId: bare(batch.anchorId), key: object.key, sha256: object.sha256 }))));
        link.run(commitment, planned.key, null);
        const claim = db.prepare("insert into claims(receipt_id,cert_hash,commitment) values(?,?,?)");
        for (const entry of selected) claim.run(entry.receiptId, bare(entry.record.availabilityCertHash), commitment);
        return getPlan(commitment);
      });
    },
    pendingObjects() {
      const rows = db.prepare("select distinct o.* from objects o join plan_objects r using(key) join plans p using(commitment) where o.published=0 and p.state!='abandoned' order by o.kind,o.key").all() as unknown as ObjectRow[];
      return rows.map(row => ({ kind: row.kind, ...checkedObject(row) }));
    },
    acknowledgePublication(key: string, sha256: string) {
      const row = db.prepare("select * from objects where key=?").get(key) as unknown as ObjectRow | undefined;
      if (!row || checkedObject(row).sha256 !== sha256) throw new Error("Publication digest differs from durable object");
      db.prepare("update objects set published=1 where key=?").run(key);
    },
    confirm(commitment: string, census: Census) {
      transaction(() => {
        observe(census);
        const plan = getPlan(commitment);
        if (plan.state !== "planned" && plan.state !== "confirmed") throw new Error("Census plan is not confirmable");
        if (db.prepare("select 1 from plan_objects r join objects o using(key) where r.commitment=? and o.published=0 limit 1").get(commitment)) throw new Error("Census plan publication is incomplete");
        const current = new Map(census.entries.map(entry => [entry.receiptId, entry]));
        for (const row of db.prepare("select receipt_id,cert_hash from claims where commitment=?").all(commitment)) {
          const entry = current.get(row.receipt_id as string);
          if (!entry || entry.status !== "certified" || bare(entry.record.availabilityCertHash) !== row.cert_hash) throw new Error("Census member certification changed before confirmation");
        }
        db.prepare("update plans set state='confirmed' where commitment=?").run(commitment);
      });
    },
    abandon(commitment: string) {
      transaction(() => {
        if (getPlan(commitment).state !== "planned") throw new Error("A confirmed census plan cannot release receipt claims");
        db.prepare("update plans set state='abandoned' where commitment=?").run(commitment);
        db.prepare("delete from claims where commitment=?").run(commitment);
      });
    },
    close() { db.close(); },
  };
}
