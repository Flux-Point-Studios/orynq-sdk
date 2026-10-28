import { describe, expect, it, vi } from "vitest";
import { buildAllowlistRoot, compileMandatePredicate, MandateGuard, MemoryGuardLog, type GuardConfig, type GuardEvent, type MandateV1 } from "../src/index.js";
import { record } from "./fixtures/record.js";

const pay = { kind: "payment", asset: "lovelace", amount: 6n, counterparty: "supplier", timestamp: 7200n } as const;
const mandate = (): MandateV1 => ({
  schemaVersion: 1n, mandateId: new Uint8Array(16), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321", didFormatVersion: 0n,
  spendCap: { asset: "lovelace", amount: 10n, windowSeconds: 3600n },
  counterpartyAllowlistRoot: buildAllowlistRoot(["supplier"]), egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) },
  approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: 0n, notAfter: 100_000n },
  disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n },
});
const config = (extra: Partial<GuardConfig> = {}): GuardConfig => {
  const log = new MemoryGuardLog();
  return { mandate: mandate(), counterpartyAllowlist: ["supplier"], now: () => 7200n, history: "fresh", onEvent: (e, previous) => log.append(e, previous), ...extra };
};

it("F2: default clock is system time in seconds", () => {
  vi.spyOn(Date, "now").mockReturnValue(7_200_999);
  try {
    const log = new MemoryGuardLog();
    const g = new MandateGuard({ mandate: mandate(), counterpartyAllowlist: ["supplier"], history: "fresh", onEvent: (e, previous) => log.append(e, previous) });
    expect(() => g.enforce(pay)).not.toThrow();
    expect(log.history().events.map(e => [e.enforcedAt, e.type])).toEqual([[7200n, "orynq.conduct.guard.action.v1"]]);
    expect(() => g.enforce({ ...pay, timestamp: 3600n })).toThrow(/timestamp/);
  } finally { vi.restoreAllMocks(); }
});

it("F2: rejects backward action time within a window and backward guard time", () => {
  let now = 7210n;
  const g = new MandateGuard(config({ now: () => now }));
  g.enforce({ ...pay, timestamp: 7205n });
  expect(() => g.enforce({ ...pay, timestamp: 7204n })).toThrow(/timestamp/);
  now = 7209n;
  expect(() => g.enforce({ ...pay, timestamp: 7206n })).toThrow(/clock/);
  expect(g.spentInWindow(7200n)).toBe(6n);
});

it("F2: a real clock boundary opens a new window; evaluate stays explicit-time and pure", () => {
  let now = 7200n;
  const g = new MandateGuard(config({ now: () => now }));
  expect(g.enforce(pay).allowed).toBe(true);
  expect(g.evaluate({ ...pay, timestamp: 10800n }).allowed).toBe(true);
  expect(g.spentInWindow(10800n)).toBe(0n);
  now = 10800n;
  expect(g.enforce({ ...pay, timestamp: now }).allowed).toBe(true);
});

it("F2: same-window backdating cannot extend mandate validity", () => {
  const m = mandate();
  const g = new MandateGuard(config({ mandate: { ...m, validityWindow: { notBefore: 0n, notAfter: 7201n } }, now: () => 7202n }));
  expect(g.enforce(pay)).toMatchObject({ allowed: false, reason: "MANDATE_EXPIRED" });
});

it("NF-6: an action timestamp later than the guard clock is refused before state or events", () => {
  let now = 7200n;
  const log = new MemoryGuardLog();
  const g = new MandateGuard(config({ now: () => now, onEvent: (e, previous) => log.append(e, previous) }));
  expect(() => g.enforce({ kind: "egress", destination: "x", timestamp: 7201n })).toThrow(/action timestamp must not be later than the guard clock/);
  expect(() => g.enforce({ ...pay, timestamp: 10_799n })).toThrow(/action timestamp must not be later than the guard clock/);
  expect(log.history().events).toHaveLength(0);
  expect(g.spentInWindow(7200n)).toBe(0n);
  expect(g.enforce(pay).allowed).toBe(true);
  now = 7300n;
  expect(g.enforce({ ...pay, amount: 4n, timestamp: 7250n }).allowed).toBe(true);
  expect(log.history().events.map(e => e.enforcedAt)).toEqual([7200n, 7300n]);
});

it("NF-6: an agent-chosen end-of-window timestamp cannot pin later host-stamped actions", () => {
  let now = 7200n;
  const log = new MemoryGuardLog();
  const g = new MandateGuard(config({ now: () => now, onEvent: (e, previous) => log.append(e, previous) }));
  expect(() => g.enforce({ kind: "egress", destination: "x", timestamp: 10_799n })).toThrow(/later than the guard clock/);
  now = 7300n;
  expect(g.enforce({ ...pay, timestamp: now }).allowed).toBe(true);
  now = 7301n;
  expect(g.enforce({ ...pay, amount: 4n, timestamp: now }).allowed).toBe(true);
});

it("F2: malformed guard clocks reject before state or events", () => {
  for (const now of [-1n, 1n << 64n, 7200 as unknown as bigint]) {
    const events: GuardEvent[] = [];
    const g = new MandateGuard(config({ now: () => now, onEvent: record(events) }));
    expect(() => g.enforce(pay)).toThrow(/clock/);
    expect(g.spentInWindow(7200n)).toBe(0n);
    expect(events).toHaveLength(0);
  }
});

describe("K1/K2 awaited evidence", () => {
  it("authorizes only after the sink accepts and blocks overlapping enforcement", async () => {
    let accept!: () => void;
    const pending = new Promise<void>(resolve => { accept = resolve; });
    const log = new MemoryGuardLog();
    const g = new MandateGuard(config({ onEvent: (e, previous) => pending.then(() => log.append(e, previous)) }));
    let authorized = false;
    const decision = g.enforceAsync(pay).then(d => { authorized = d.allowed; });
    await Promise.resolve();
    expect(authorized).toBe(false);
    expect(() => g.enforce(pay)).toThrow(/pending/);
    await expect(g.enforceAsync(pay)).rejects.toThrow(/pending/);
    accept();
    await decision;
    expect(authorized).toBe(true);
  });

  it("a failed async sink cannot authorize or be reused", async () => {
    const g = new MandateGuard(config({ onEvent: async () => { throw new Error("durability failed"); } }));
    await expect(g.enforceAsync(pay)).rejects.toThrow("durability failed");
    expect(g.spentInWindow(7200n)).toBe(6n);
    expect(() => g.enforce({ ...pay, amount: 1n })).toThrow(/event sink failed; restore a new guard/);
  });

  it("a sync promise rejection is observed and the guard stays failed closed", async () => {
    const g = new MandateGuard(config({ onEvent: () => Promise.reject(new Error("sink failed")) }));
    expect(() => g.enforce(pay)).toThrow(/enforceAsync/);
    await new Promise(resolve => setImmediate(resolve));
    expect(() => g.enforce(pay)).toThrow(/event sink failed; restore a new guard/);
  });

  it("restores sequence, monotonic time, spend and denials without re-emitting", () => {
    const log = new MemoryGuardLog();
    let now = 7200n;
    const g = new MandateGuard(config({ now: () => now, onEvent: (e, previous) => log.append(e, previous) }));
    g.enforce(pay);
    now = 7202n;
    g.enforce({ ...pay, timestamp: 7202n });
    const restored: GuardEvent[] = [];
    const h = new MandateGuard(config({ now: () => 7202n, history: log.history(), onEvent: record(restored, log) }));
    expect(restored).toHaveLength(0);
    expect(h.spentInWindow(7200n)).toBe(6n);
    expect(() => h.enforce(pay)).toThrow(/timestamp/);
    h.enforce({ ...pay, timestamp: 7202n, amount: 4n });
    expect(restored[0]?.seq).toBe(2n);
    expect(h.spentInWindow(7200n)).toBe(10n);
  });

  it("rejects altered, reordered, foreign and overspending replay events", () => {
    const log = new MemoryGuardLog();
    const g = new MandateGuard(config({ onEvent: (e, previous) => log.append(e, previous) }));
    g.enforce(pay);
    g.enforce(pay);
    const { events, head } = log.history();
    const first = events[0]!;
    const mismatch = "event does not match replayed decision";
    const fields = "invalid guard event fields or action digest";
    const denial = "invalid guard denial reason or rule";
    const cases: [unknown[], string][] = [
      [[{ ...first, mandateCommitment: "0".repeat(64) }], mismatch],
      [[{ ...first, actionDigest: "0".repeat(64) }], fields],
      [[{ ...first, actionKind: "egress" }], fields],
      [[{ ...first, timestamp: 7201n }], fields],
      [[{ ...first, seq: 1n }], mismatch],
      [[{ ...first, enforcedAt: 3600n }], "action timestamp must be in the guard clock's current window"],
      [[first, { ...first, seq: 1n }], mismatch],
      [[...events].reverse(), mismatch],
      [[first, { ...events[1], reason: "ASSET_MISMATCH" }], denial],
      [[first, { ...events[1], rule: "forged" }], denial],
    ];
    expect(() => new MandateGuard(config({ history: { events, head } }))).not.toThrow();
    for (const [corrupt, reason] of cases) {
      expect(() => new MandateGuard(config({ history: { events: corrupt as GuardEvent[], head } }))).toThrow(`invalid recorded guard event: ${reason}`);
    }
  });
});

it("F7: identifier UTF-8 byte limits apply to actions and allowlists", () => {
  const g = new MandateGuard(config());
  for (const identifier of ["é".repeat(129), "x".repeat(257)]) {
    expect(() => g.evaluate({ ...pay, counterparty: identifier })).toThrow(/identifier/);
    expect(() => g.evaluate({ kind: "egress", destination: identifier, timestamp: 7200n })).toThrow(/identifier/);
    expect(() => buildAllowlistRoot([identifier])).toThrow(/member/);
  }
  expect(g.evaluate({ ...pay, counterparty: "é".repeat(128) }).allowed).toBe(false);
  expect(() => g.evaluate({ ...pay, asset: "x".repeat(129) })).toThrow(/identifier/);
});

it("Info: compiler uses the same allowlist snapshot for hashing and membership", () => {
  const list = ["supplier"];
  Object.defineProperty(list, Symbol.iterator, { value: function* () { yield "supplier"; yield "mallory"; } });
  expect(() => compileMandatePredicate(mandate(), { counterpartyAllowlist: list })).toThrow(/allowlist/);
});

it("Info: a replay event action getter is copied once before validation", () => {
  const log = new MemoryGuardLog();
  new MandateGuard(config({ onEvent: (e, previous) => log.append(e, previous) })).enforce(pay);
  const { events, head } = log.history();
  let reads = 0;
  const source = { ...events[0]!, get action() { reads++; return reads === 1 ? pay : { ...pay, amount: 1n }; } };
  let restored: MandateGuard | undefined;
  expect(() => { restored = new MandateGuard(config({ history: { events: [source], head } })); }).not.toThrow();
  expect(reads).toBe(1);
  expect(restored?.spentInWindow(7200n)).toBe(6n);
});
