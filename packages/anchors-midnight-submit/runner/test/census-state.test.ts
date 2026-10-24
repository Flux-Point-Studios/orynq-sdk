import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { certHash, decodeReceiptRecord, parseMemberSnapshot } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { batchAnchorCommitment } from "../../src/batch-plan.js";
import { openCensusState } from "../census-state.js";
import type { Census } from "../census.js";

const fixture = JSON.parse(readFileSync(new URL("../../../core/src/__tests__/fixtures/checkpoint-receipts.json", import.meta.url), "utf8"));
const G = fixture.genesis as string, R = "43".repeat(32);
const hash = (n: number) => createHash("sha256").update(String(n)).digest("hex");
const base = decodeReceiptRecord(Buffer.from(fixture.receipts[0].raw, "hex"));
function census(count = 3, height = 100): Census {
  return { genesis: G, finalizedHash: "0x" + hash(height), finalizedHeight: height, entries: Array.from({ length: count }, (_, i) => {
    const receiptId = hash(i);
    const record = { ...base, createdAtMillis: BigInt(i) };
    record.availabilityCertHash = certHash({ format: "scale-v1", chainId: null }, G, receiptId, record);
    return { receiptId, status: "certified" as const, record };
  }) };
}
function fixtureState(run: (path: string, state: ReturnType<typeof openCensusState>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "orynq-census-state-"));
  const path = join(dir, "census.sqlite");
  const state = openCensusState(path, { network: "mainnet", genesis: G, registry: R });
  try { run(path, state); } finally { state.close(); rmSync(dir, { recursive: true, force: true }); }
}

it("atomically persists canonical plans, snapshots, publication objects and receipt claims", () => fixtureState((path, state) => {
  const plan = state.prepare(census(), 10n)!;
  expect(plan.state).toBe("planned");
  expect(plan.finalizedHeight).toBe(100);
  expect(plan.snapshots).toHaveLength(1);
  const batch = parseMemberSnapshot(plan.snapshots[0]!.body);
  expect(batch.receipts).toHaveLength(3);
  expect(Buffer.from(batchAnchorCommitment(plan.plan.entries[0]!)).toString("hex")).toBe(plan.commitment);
  expect(state.pendingObjects()).toHaveLength(2);
  const restarted = openCensusState(path, { network: "mainnet", genesis: G, registry: R });
  try {
    expect(restarted.currentPlan()).toEqual(plan);
    expect(restarted.prepare(census(4, 101), 11n)).toEqual(plan);
  } finally { restarted.close(); }
}));

it("splits4097 receipts into bounded canonical snapshots with sorted member identities", () => fixtureState((_path, state) => {
  const plan = state.prepare(census(4097), 5000n)!;
  expect(plan.snapshots).toHaveLength(2);
  expect(plan.snapshots.map(snapshot => parseMemberSnapshot(snapshot.body).receipts.length).sort((a, b) => a - b)).toEqual([1, 4096]);
  const ids = plan.plan.entries[0]!.batches.map(member => member.anchorId);
  expect(ids).toEqual([...ids].sort());
}));

it("confirmation waits for durable publication acknowledgements and revalidates every member", () => fixtureState((_path, state) => {
  const current = census(), plan = state.prepare(current, 10n)!;
  expect(() => state.confirm(plan.commitment, current)).toThrow(/publicat/i);
  for (const object of state.pendingObjects()) state.acknowledgePublication(object.key, object.sha256);
  const missing = { ...census(3, 101), entries: census(3, 101).entries.map((entry, i) => i ? entry : { receiptId: entry.receiptId, status: "pending" as const, reason: "missing" as const }) };
  expect(() => state.confirm(plan.commitment, missing)).toThrow(/member|certif/i);
  state.confirm(plan.commitment, census(3, 101));
  expect(state.currentPlan()!.state).toBe("confirmed");
  expect(() => state.abandon(plan.commitment)).toThrow(/confirm/i);
}));

it("only never-confirmed plans may release claims, while immutable objects survive abandonment", () => fixtureState((_path, state) => {
  const first = state.prepare(census(), 10n)!;
  state.abandon(first.commitment);
  expect(state.currentPlan()).toBeNull();
  const second = state.prepare(census(3, 101), 10n)!;
  expect(second.commitment).not.toBe(first.commitment);
  expect(state.pendingObjects().length).toBeGreaterThanOrEqual(2);
}));

it("claim conflicts roll back snapshots, plans and publication objects together", () => fixtureState((path, state) => {
  const db = new DatabaseSync(path);
  try { db.exec("create trigger reject_claim before insert on claims begin select raise(abort, 'injected claim conflict'); end;"); }
  finally { db.close(); }
  expect(() => state.prepare(census(), 10n)).toThrow(/conflict/i);
  expect(state.currentPlan()).toBeNull();
  expect(state.pendingObjects()).toEqual([]);
}));

it("rejects a chain rewind, disappeared receipt and conflicting epoch hash", () => fixtureState((_path, state) => {
  state.prepare(census(), 10n);
  expect(() => state.prepare(census(3, 99), 10n)).toThrow(/rewind/i);
  expect(() => state.prepare(census(2, 101), 10n)).toThrow(/disappear/i);
  expect(() => state.prepare({ ...census(), finalizedHash: "0x" + hash(999) }, 10n)).toThrow(/epoch|hash/i);
}));

it("does not reinterpret confirmed receipt recertification as permission for another fee", () => fixtureState((_path, state) => {
  const plan = state.prepare(census(), 10n)!;
  for (const object of state.pendingObjects()) state.acknowledgePublication(object.key, object.sha256);
  state.confirm(plan.commitment, census());
  const changed = census(3, 101), entry = changed.entries[0]!;
  if (entry.status === "pending") throw new Error("Invalid fixture");
  entry.record.availabilityCertHash = certHash({ format: "dcbor-v1", chainId: G }, G, entry.receiptId, entry.record);
  expect(() => state.prepare(changed, 20n)).toThrow(/recertif/i);
}));

it("binds existing state to its genesis and registry and checks publication digests", () => fixtureState((path, state) => {
  state.prepare(census(), 10n);
  expect(() => openCensusState(path, { network: "mainnet", genesis: G, registry: hash(999) })).toThrow(/scope|registry/i);
  const object = state.pendingObjects()[0]!;
  expect(() => state.acknowledgePublication(object.key, hash(111))).toThrow(/digest/i);
}));


it("refuses unsupported schema versions without changing stored state", () => fixtureState((path, state) => {
  const plan = state.prepare(census(), 10n)!;
  const db = new DatabaseSync(path);
  try { db.exec("pragma user_version=2"); } finally { db.close(); }
  expect(() => openCensusState(path, { network: "mainnet", genesis: G, registry: R })).toThrow(/schema version/i);
  expect(state.currentPlan()).toEqual(plan);
  const check = new DatabaseSync(path);
  try { expect(check.prepare("pragma user_version").get()!.user_version).toBe(2); } finally { check.close(); }
}));

it("new state has a durable schema version", () => fixtureState((path) => {
  const db = new DatabaseSync(path);
  try { expect(db.prepare("pragma user_version").get()!.user_version).toBe(1); } finally { db.close(); }
}));


it("uses ordinal hash ordering regardless of host collation", () => fixtureState((_path, state) => {
  const collation = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (this: string, other: string) { return String(this) < other ? 1 : String(this) > other ? -1 : 0; });
  try {
    const plan = state.prepare(census(4097), 5000n)!;
    const ids = plan.plan.entries[0]!.batches.map(member => member.anchorId);
    expect(ids).toEqual([...ids].sort());
  } finally { collation.mockRestore(); }
}));

it("can reactivate a never-confirmed abandoned plan at the same census epoch", () => fixtureState((_path, state) => {
  const first = state.prepare(census(), 10n)!;
  state.abandon(first.commitment);
  expect(state.prepare(census(), 10n)).toEqual(first);
  expect(state.pendingObjects()).toHaveLength(2);
}));


it.each(["delete from claims", "update claims set cert_hash='" + "ff".repeat(32) + "'"])("refuses altered claim state: %s", (mutation) => fixtureState((path, state) => {
  const current = census(), plan = state.prepare(current, 10n)!;
  for (const object of state.pendingObjects()) state.acknowledgePublication(object.key, object.sha256);
  const db = new DatabaseSync(path);
  try { db.exec(mutation); } finally { db.close(); }
  expect(() => state.confirm(plan.commitment, current)).toThrow(/claim/i);
}));

it("requires the immutable planned mapping even when member snapshots are published", () => fixtureState((path, state) => {
  const current = census(), plan = state.prepare(current, 10n)!;
  for (const object of state.pendingObjects()) if (object.kind === "members") state.acknowledgePublication(object.key, object.sha256);
  const db = new DatabaseSync(path);
  try { db.exec("delete from plan_objects where key like 'plans/%'"); } finally { db.close(); }
  expect(() => state.confirm(plan.commitment, current)).toThrow(/planned|mapping/i);
}));


it("pins the network and labels preprod publication objects correctly", () => {
  const dir = mkdtempSync(join(tmpdir(), "orynq-preprod-census-state-"));
  const path = join(dir, "census.sqlite");
  const scope = { network: "preprod" as const, genesis: G, registry: R };
  const state = openCensusState(path, scope);
  try {
    state.prepare(census(), 10n);
    const object = state.pendingObjects().find(object => object.kind === "plans")!;
    expect(JSON.parse(object.body).network).toBe("preprod");
    expect(() => openCensusState(path, { ...scope, network: "mainnet" })).toThrow(/scope|network/i);
  } finally { state.close(); rmSync(dir, { recursive: true, force: true }); }
});
