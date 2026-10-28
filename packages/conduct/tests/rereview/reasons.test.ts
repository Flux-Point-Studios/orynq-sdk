// Right-reason pins: each DEFENDED rejection must come from the intended boundary.
import { expect, it } from "vitest";
import { buildAllowlistRoot, GuardConfigError, MandateGuard, MemoryGuardLog, type GuardAction, type GuardConfig, type GuardEvent, type MandateV1 } from "../../src/index.js";
import { record } from "../fixtures/record.js";

const CP = ["supplier"];
const mandate = (over: Partial<MandateV1> = {}): MandateV1 => ({
  schemaVersion: 1n, mandateId: new Uint8Array(16), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321",
  didFormatVersion: 0n, spendCap: { asset: "lovelace", amount: 10n, windowSeconds: 3600n },
  counterpartyAllowlistRoot: buildAllowlistRoot(CP), egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) },
  approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: 0n, notAfter: 100_000n },
  disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n }, ...over,
});
const pay = { kind: "payment", asset: "lovelace", amount: 6n, counterparty: "supplier", timestamp: 7200n } as const;
const cfg = (extra: Partial<GuardConfig> = {}): GuardConfig => {
  const log = new MemoryGuardLog();
  return { mandate: mandate(), counterpartyAllowlist: CP, now: () => 7200n, history: "fresh", onEvent: record([], log), ...extra };
};
const msg = (f: () => unknown) => { try { f(); return "NO THROW"; } catch (e) { return `${(e as Error).name}: ${(e as Error).message}`; } };

it("poisoned actions reject at validateAction with the specific reason", () => {
  const cases: [unknown, RegExp][] = [
    [{ ...JSON.parse('{"asset":"lovelace","counterparty":"supplier","note":1e999}'), kind: "payment", amount: 6n, timestamp: 7200n }, /SCHEMA_UNKNOWN_KEY: unknown action key/],
    [{ ...pay, [Symbol("x")]: 1 }, /SCHEMA_UNKNOWN_KEY/],
    [{ ...JSON.parse('{"__proto__":{"evil":1},"asset":"lovelace","counterparty":"supplier"}'), kind: "payment", amount: 6n, timestamp: 7200n }, /SCHEMA_UNKNOWN_KEY/],
    [{ ...pay, asset: new String("lovelace") }, /SCHEMA_BAD_TYPE: action identifiers/],
    [{ ...pay, amount: Object(6n) }, /SCHEMA_BAD_TYPE: action integers/],
    [{ ...pay, amount: 6 }, /SCHEMA_BAD_TYPE: action integers/],
    [{ kind: "egress", destination: "d", timestamp: 7200n, amount: 1n }, /SCHEMA_UNKNOWN_KEY/],
    [Object.assign(Object.create({ kind: "payment" }), { asset: "lovelace", amount: 6n, counterparty: "supplier", timestamp: 7200n }), /unknown action kind/],
  ];
  const out: string[] = [];
  for (const [a, re] of cases) { const m = msg(() => new MandateGuard(cfg()).enforce(a as GuardAction)); out.push(m); expect(m).toMatch(re); }
  console.log("REASONS poisoned:", JSON.stringify(out));
});

it("clock / window rejections come from prepare's clock and window guards", () => {
  const out = [
    msg(() => new MandateGuard(cfg()).enforce({ ...pay, timestamp: 1n << 39n })),
    msg(() => new MandateGuard(cfg()).enforce({ ...pay, timestamp: 3600n })),
    msg(() => new MandateGuard(cfg({ now: () => 7200 as unknown as bigint })).enforce(pay)),
    msg(() => new MandateGuard(cfg({ now: () => -1n })).enforce(pay)),
    msg(() => new MandateGuard(cfg({ now: () => 1n << 64n })).enforce(pay)),
  ];
  console.log("REASONS clock:", JSON.stringify(out));
  expect(out[0]).toMatch(/current window/); expect(out[1]).toMatch(/current window/);
  for (const m of out.slice(2)) expect(m).toMatch(/guard clock must be a monotonic uint64/);
});

it("replay rejections come from the decision comparison or snapshot, not an unrelated guard", () => {
  const log = new MemoryGuardLog();
  const g = new MandateGuard(cfg({ onEvent: record([], log) }));
  g.enforce(pay); g.enforce({ ...pay, amount: 4n }); g.enforce({ ...pay, amount: 1n });
  const { events, head } = log.history();
  const fe: GuardEvent[] = [];
  new MandateGuard(cfg({ mandate: mandate({ mandateId: new Uint8Array(16).fill(7) }), onEvent: record(fe) })).enforce(pay);
  const { reason: _r, rule: _u, ...rest } = events[2] as Extract<GuardEvent, { type: "orynq.conduct.guard.denial.v1" }>;
  const cases: [string, GuardEvent[]][] = [
    ["foreign", fe], ["duplicate", [events[0]!, events[0]!]], ["reordered", [events[1]!, events[0]!]], ["suffix", events.slice(1)],
    ["denial->action", [events[0]!, events[1]!, { ...rest, type: "orynq.conduct.guard.action.v1" } as GuardEvent]],
    ["action->denial", [{ ...events[0]!, type: "orynq.conduct.guard.denial.v1", reason: "SPEND_CAP_EXCEEDED", rule: "payment exceeds the remaining window spend cap" } as GuardEvent]],
    ["zero amount", [{ ...events[0]!, action: { ...events[0]!.action, amount: 0n } } as GuardEvent]],
    ["clock backwards", [events[0]!, { ...events[1]!, enforcedAt: 7199n }]],
  ];
  const out = cases.map(([n, ev]) => `${n} => ${msg(() => new MandateGuard(cfg({ history: { events: ev, head } })))}`);
  console.log("REASONS replay:", JSON.stringify(out, null, 1));
  for (const o of out) expect(o).toMatch(/GuardConfigError: invalid recorded guard event/);
  for (const o of out.slice(0, 6)) expect(o).toMatch(/does not match replayed decision/);
  expect(out[6]).toMatch(/payment amount must be >= 1/);
  expect(out[7]).toMatch(/guard clock must be a monotonic/);
  expect(GuardConfigError).toBeDefined();
});
