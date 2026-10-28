import { describe, expect, it } from "vitest";
import { buildAllowlistRoot, compileMandatePredicate, MandateGuard, MemoryGuardLog, type GuardAction, type GuardEvent, type MandateV1 } from "../../src/index.js";

const CP = ["addr_test1_alpha", "café"];
const EG = ["api.example.com"];
function mandate(): MandateV1 {
  return {
    schemaVersion: 1n, mandateId: new Uint8Array(16), principalDid: "did:key:z123456789",
    agentDid: "did:key:z987654321", didFormatVersion: 0n,
    spendCap: { asset: "lovelace", amount: 10n, windowSeconds: 3600n },
    counterpartyAllowlistRoot: buildAllowlistRoot(CP),
    egressPolicy: { mode: 1n, allowlistRoot: buildAllowlistRoot(EG) },
    approvedMeasurementSetRoot: new Uint8Array(32),
    validityWindow: { notBefore: 1000n, notAfter: 100_000n },
    disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n },
  };
}
const sink = () => { const log = new MemoryGuardLog(); return (e: GuardEvent) => log.append(e); };
const guard = () => new MandateGuard({ now: () => 5000n, mandate: mandate(), counterpartyAllowlist: [...CP], egressAllowlist: [...EG], history: "fresh", onEvent: sink() });
const pay = (o: Partial<Record<string, unknown>> = {}) => ({ kind: "payment", asset: "lovelace", amount: 1n, counterparty: "addr_test1_alpha", timestamp: 5000n, ...o }) as GuardAction;
const egress = (o: Partial<Record<string, unknown>> = {}) => ({ kind: "egress", destination: "api.example.com", timestamp: 5000n, ...o }) as GuardAction;

describe("spelling variants fail closed (exact-match sets)", () => {
  it("CONTROL: exact spellings are allowed", () => {
    const g = guard();
    expect(g.enforce(pay()).allowed).toBe(true);
    expect(g.enforce(pay({ counterparty: "café" })).allowed).toBe(true);
    expect(g.enforce(egress()).allowed).toBe(true);
  });
  for (const cp of ["ADDR_TEST1_ALPHA", " addr_test1_alpha", "addr_test1_alpha​", "café", "ａddr_test1_alpha"]) {
    it(`counterparty ${JSON.stringify(cp)} -> COUNTERPARTY_NOT_ALLOWED`, () => {
      expect(guard().enforce(pay({ counterparty: cp }))).toMatchObject({ allowed: false, reason: "COUNTERPARTY_NOT_ALLOWED" });
    });
  }
  for (const d of ["API.EXAMPLE.COM", "api.example.com.", "https://api.example.com", "api.example.com:443", "addr_test1_alpha"]) {
    it(`destination ${JSON.stringify(d)} -> EGRESS_NOT_ALLOWED`, () => {
      expect(guard().enforce(egress({ destination: d }))).toMatchObject({ allowed: false, reason: "EGRESS_NOT_ALLOWED" });
    });
  }
  it("asset spelling variant -> ASSET_MISMATCH", () => {
    expect(guard().enforce(pay({ asset: "Lovelace" }))).toMatchObject({ allowed: false, reason: "ASSET_MISMATCH" });
  });
});

describe("current code matches the README precedence (behaviour, not pinning)", () => {
  const cases: [string, GuardAction, string][] = [
    ["asset+counterparty", pay({ asset: "x", counterparty: "mallory" }), "ASSET_MISMATCH"],
    ["asset+cap", pay({ asset: "x", amount: 11n }), "ASSET_MISMATCH"],
    ["counterparty+cap", pay({ counterparty: "mallory", amount: 11n }), "COUNTERPARTY_NOT_ALLOWED"],
    ["notBefore+all", pay({ asset: "x", counterparty: "m", amount: 11n, timestamp: 1n }), "MANDATE_NOT_YET_VALID"],
    ["expired egress", egress({ timestamp: 100_000n }), "MANDATE_EXPIRED"],
    ["early egress miss", egress({ destination: "evil", timestamp: 999n }), "MANDATE_NOT_YET_VALID"],
  ];
  for (const [n, a, want] of cases) it(n, () => expect(guard().evaluate(a)).toMatchObject({ allowed: false, reason: want }));
});

describe("uint64 extremes", () => {
  it("cap 2^64-1: exact max allowed, one more denied without wrap", () => {
    const max = (1n << 64n) - 1n;
    const m = { ...mandate(), spendCap: { asset: "lovelace", amount: max, windowSeconds: max } };
    const g = new MandateGuard({ now: () => 5000n, mandate: m, counterpartyAllowlist: CP, egressAllowlist: EG, history: "fresh", onEvent: sink() });
    expect(g.enforce(pay({ amount: max })).allowed).toBe(true);
    expect(g.enforce(pay({ amount: 1n }))).toMatchObject({ allowed: false, reason: "SPEND_CAP_EXCEEDED" });
    expect(g.spentInWindow(5000n)).toBe(max);
  });
});

describe("snapshots", () => {
  it("allowlist arrays, mandate roots, returned mandate and emitted events cannot alter policy", () => {
    const m = mandate();
    const list = [...CP];
    const events: GuardEvent[] = [];
    const g = new MandateGuard({ now: () => 5000n, mandate: m, counterpartyAllowlist: list, egressAllowlist: [...EG], history: "fresh", onEvent: (e) => { events.push(e); expect(() => { (e.action as { amount?: bigint }).amount = 0n; }).toThrow(); } });
    list.push("mallory");
    m.counterpartyAllowlistRoot.fill(0);
    (g.mandate.spendCap as { amount: bigint }).amount = 1000n;
    expect(g.enforce(pay({ counterparty: "mallory" }))).toMatchObject({ allowed: false });
    expect(g.enforce(pay({ amount: 10n })).allowed).toBe(true);
    expect(g.spentInWindow(5000n)).toBe(10n);
    expect(g.enforce(pay({ amount: 1n })).allowed).toBe(false);
  });
  it("a getter-based action is read once by enforce", () => {
    let n = 0;
    const tricky = { kind: "payment", asset: "lovelace", counterparty: "addr_test1_alpha", timestamp: 5000n, get amount() { return n++ === 0 ? 1n : 1000n; } } as GuardAction;
    const g = guard();
    expect(g.enforce(tricky).allowed).toBe(true);
    expect(g.spentInWindow(5000n)).toBe(1n);
  });
  it("compiled predicate args are fixed at compile time", () => {
    const m = mandate();
    const c = compileMandatePredicate(m, { counterpartyAllowlist: CP, egressAllowlist: EG });
    (m.spendCap as { amount: bigint }).amount = 999n;
    expect(c.buildArgs(pay(), 0n)[3]).toBe(10n);
  });
});

describe("malformed actions throw before any state change", () => {
  const bad: unknown[] = [null, undefined, {}, pay({ kind: "Payment" }), pay({ amount: 1 }), pay({ amount: "1" }), pay({ counterparty: undefined }), pay({ counterparty: "" }), pay({ asset: "\ud800" }), egress({ destination: 7 }), egress({ timestamp: -1n }), pay({ amount: 1n << 64n })];
  it("no spend, no seq, no event", () => {
    const events: GuardEvent[] = [];
    const g = new MandateGuard({ now: () => 5000n, mandate: mandate(), counterpartyAllowlist: CP, egressAllowlist: EG, history: "fresh", onEvent: (e) => events.push(e) });
    for (const a of bad) expect(() => g.enforce(a as GuardAction)).toThrow();
    expect(events).toHaveLength(0);
    expect(g.spentInWindow(5000n)).toBe(0n);
    g.enforce(pay());
    expect(events[0]?.seq).toBe(0n);
  });
});
