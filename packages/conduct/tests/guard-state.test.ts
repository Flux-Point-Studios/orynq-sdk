import { describe, expect, it, vi } from "vitest";
import { buildAllowlistRoot, compileMandatePredicate, MandateGuard, type GuardConfig, type GuardEvent, type MandateV1 } from "../src/index.js";

const pay = { kind: "payment", asset: "lovelace", amount: 6n, counterparty: "supplier", timestamp: 7200n } as const;
const mandate = (): MandateV1 => ({
  schemaVersion: 1n, mandateId: new Uint8Array(16), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321", didFormatVersion: 0n,
  spendCap: { asset: "lovelace", amount: 10n, windowSeconds: 3600n },
  counterpartyAllowlistRoot: buildAllowlistRoot(["supplier"]), egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) },
  approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: 0n, notAfter: 100_000n },
  disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n },
});
const config = (extra: Partial<GuardConfig> = {}): GuardConfig => ({ mandate: mandate(), counterpartyAllowlist: ["supplier"], now: () => 7200n, ...extra });

it("F2: default clock is system time in seconds", () => {
  vi.spyOn(Date, "now").mockReturnValue(7_200_999);
  try {
    const g = new MandateGuard({ mandate: mandate(), counterpartyAllowlist: ["supplier"] });
    expect(g.enforce(pay).allowed).toBe(true);
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

it("F2: malformed guard clocks reject before state or events", () => {
  for (const now of [-1n, 1n << 64n, 7200 as unknown as bigint]) {
    const events: GuardEvent[] = [];
    const g = new MandateGuard(config({ now: () => now, onEvent: e => events.push(e) }));
    expect(() => g.enforce(pay)).toThrow(/clock/);
    expect(g.spentInWindow(7200n)).toBe(0n);
    expect(events).toHaveLength(0);
  }
});

describe("K1/K2 awaited evidence", () => {
  it("authorizes only after the sink accepts and blocks overlapping enforcement", async () => {
    let accept!: () => void;
    const pending = new Promise<void>(resolve => { accept = resolve; });
    const g = new MandateGuard(config({ onEvent: () => pending }));
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
    expect(() => g.enforce({ ...pay, amount: 1n })).toThrow(/sink/);
  });

  it("a sync promise rejection is observed and the guard stays failed closed", async () => {
    const g = new MandateGuard(config({ onEvent: () => Promise.reject(new Error("sink failed")) }));
    expect(() => g.enforce(pay)).toThrow(/enforceAsync/);
    await new Promise(resolve => setImmediate(resolve));
    expect(() => g.enforce(pay)).toThrow(/sink/);
  });

  it("restores sequence, monotonic time, spend and denials without re-emitting", () => {
    const events: GuardEvent[] = [];
    const g = new MandateGuard(config({ onEvent: e => events.push(e) }));
    g.enforce(pay);
    g.enforce({ ...pay, timestamp: 7202n });
    const restored: GuardEvent[] = [];
    const h = new MandateGuard(config({ recordedEvents: events, onEvent: e => restored.push(e) }));
    expect(restored).toHaveLength(0);
    expect(h.spentInWindow(7200n)).toBe(6n);
    expect(() => h.enforce(pay)).toThrow(/timestamp/);
    h.enforce({ ...pay, timestamp: 7202n, amount: 4n });
    expect(restored[0]?.seq).toBe(2n);
    expect(h.spentInWindow(7200n)).toBe(10n);
  });

  it("rejects altered, reordered, foreign and overspending replay events", () => {
    const events: GuardEvent[] = [];
    const g = new MandateGuard(config({ onEvent: e => events.push(e) }));
    g.enforce(pay);
    g.enforce(pay);
    const first = events[0]!;
    for (const corrupt of [
      [{ ...first, mandateCommitment: "0".repeat(64) }],
      [{ ...first, actionDigest: "0".repeat(64) }],
      [{ ...first, actionKind: "egress" }],
      [{ ...first, timestamp: 7201n }],
      [{ ...first, seq: 1n }],
      [{ ...first, enforcedAt: 3600n }],
      [first, { ...first, seq: 1n }],
      [...events].reverse(),
      [first, { ...events[1], reason: "ASSET_MISMATCH" }],
      [first, { ...events[1], rule: "forged" }],
    ]) expect(() => new MandateGuard(config({ recordedEvents: corrupt as GuardEvent[] }))).toThrow(/recorded/);
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
  const events: GuardEvent[] = [];
  new MandateGuard(config({ onEvent: e => events.push(e) })).enforce(pay);
  let reads = 0;
  const source = { ...events[0]!, get action() { reads++; return reads === 1 ? pay : { ...pay, amount: 1n }; } };
  const restored = new MandateGuard(config({ recordedEvents: [source] }));
  expect(reads).toBe(1);
  expect(restored.spentInWindow(7200n)).toBe(6n);
});
