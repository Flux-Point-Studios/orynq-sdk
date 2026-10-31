import { readFileSync } from "node:fs";
import {
  buildAllowlistRoot, compileMandatePredicate, MandateGuard, MemoryGuardLog, verdictOf,
  type GuardAction, type GuardDecision, type MandateV1, type PredicateArgs,
} from "@fluxpointstudios/orynq-sdk-conduct";
import { outcome, type Outcome, type UnitModule } from "./harness.js";

export interface VerdictCase {
  readonly group: string;
  readonly name: string;
  readonly enforcedAt: bigint;
  readonly args: PredicateArgs;
  /** The runtime's explicit-time decision, `MandateGuard.evaluate`, the judge of the 12-argument `evaluate`. */
  readonly evaluate: Outcome;
  /** The runtime's clocked decision, `MandateGuard.enforce`, the judge of `guard_verdict`. */
  readonly guard: Outcome;
  readonly spent: { readonly model: bigint; readonly guard: bigint };
  readonly fixture?: { readonly verdict: number; readonly args?: readonly (string | boolean)[]; readonly prior?: string };
}

interface JsonAction { kind: "payment" | "egress"; asset?: string; amount?: string; counterparty?: string; destination?: string; timestamp: string }
interface GuardVectors {
  mandateParams: Record<"asset" | "capAmount" | "windowSeconds" | "notBefore" | "notAfter" | "committeeId" | "threshold" | "committeeSize", string>;
  counterpartyAllowlist: string[];
  egressAllowlist: string[];
  cases: { name: string; capAmount?: string; sequence: { action: JsonAction; expect: string }[] }[];
  denyAllEgressCases: { name: string; capAmount?: string; sequence: { action: JsonAction; expect: string }[] }[];
}
interface PredicateVectors {
  cases: { name: string; egressMode: string; steps: { action: JsonAction; priorSpent: string; args: (string | boolean)[]; verdict: string }[] }[];
}

const fixtures = (name: string) => JSON.parse(readFileSync(new URL(`../../../conduct/tests/fixtures/${name}`, import.meta.url), "utf8"));
const guardVectors: GuardVectors = fixtures("guard-vectors.json");
const predicateVectors: PredicateVectors = fixtures("predicate-vectors.json");

export interface Policy {
  readonly mandate: MandateV1;
  readonly counterparties: readonly string[];
  readonly egress?: readonly string[];
}

export interface Step {
  readonly action: GuardAction;
  readonly clock?: bigint;
  readonly fixture?: VerdictCase["fixture"];
}

export const decisionCode = (decision: GuardDecision): number => decision.allowed ? 0 : verdictOf(decision.reason);

function fixtureMandate(egressMode: 0n | 1n, capAmount?: string): MandateV1 {
  const p = guardVectors.mandateParams;
  return {
    schemaVersion: 1n,
    mandateId: new Uint8Array(16).fill(0x51),
    principalDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    agentDid: "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG",
    didFormatVersion: 0n,
    spendCap: { asset: p.asset, amount: BigInt(capAmount ?? p.capAmount), windowSeconds: BigInt(p.windowSeconds) },
    counterpartyAllowlistRoot: buildAllowlistRoot(guardVectors.counterpartyAllowlist),
    egressPolicy: egressMode === 1n
      ? { mode: 1n, allowlistRoot: buildAllowlistRoot(guardVectors.egressAllowlist) }
      : { mode: 0n, allowlistRoot: new Uint8Array(32) },
    approvedMeasurementSetRoot: new Uint8Array(32).fill(0x44),
    validityWindow: { notBefore: BigInt(p.notBefore), notAfter: BigInt(p.notAfter) },
    disclosurePolicy: { committeeId: p.committeeId, threshold: BigInt(p.threshold), committeeSize: BigInt(p.committeeSize) },
  };
}

export const fixturePolicy = (egressMode: 0n | 1n, capAmount?: string): Policy => ({
  mandate: fixtureMandate(egressMode, capAmount),
  counterparties: guardVectors.counterpartyAllowlist,
  ...(egressMode === 1n ? { egress: guardVectors.egressAllowlist } : {}),
});

const toAction = (j: JsonAction): GuardAction => j.kind === "payment"
  ? { kind: "payment", asset: j.asset!, amount: BigInt(j.amount!), counterparty: j.counterparty!, timestamp: BigInt(j.timestamp) }
  : { kind: "egress", destination: j.destination!, timestamp: BigInt(j.timestamp) };

const CLOCK_REFUSAL = /action timestamp must not be later than the guard clock/;

export const allowlists = (policy: Policy) =>
  ({ counterpartyAllowlist: policy.counterparties, ...(policy.egress ? { egressAllowlist: policy.egress } : {}) });

export function guardFor(policy: Policy, now: () => bigint): MandateGuard {
  const log = new MemoryGuardLog();
  return new MandateGuard({ mandate: policy.mandate, ...allowlists(policy), now, history: "fresh", onEvent: (e, previous) => log.append(e, previous) });
}

// Runs one real guard over `steps` and records, per step, the predicate arguments built from the harness's own
// per-window spend model and both runtime decisions.
export function runPolicy(group: string, name: string, policy: Policy, steps: readonly Step[]): VerdictCase[] {
  const compiled = compileMandatePredicate(policy.mandate, allowlists(policy));
  let now = 0n;
  const guard = guardFor(policy, () => now);
  const width = policy.mandate.spendCap.windowSeconds;
  let model = { window: -1n, spent: 0n };
  return steps.map((step, i) => {
    const { action } = step;
    const window = action.timestamp / width;
    const prior = model.window === window ? model.spent : 0n;
    const spent = { model: prior, guard: guard.spentInWindow(action.timestamp) };
    const args = compiled.buildArgs(action, prior);
    const evaluate = decisionCode(guard.evaluate(action));
    now = step.clock ?? action.timestamp;
    let enforced: Outcome;
    try {
      enforced = decisionCode(guard.enforce(action));
    } catch (error) {
      if (!CLOCK_REFUSAL.test((error as Error).message)) throw error;
      enforced = { throws: "failed assert: action after guard clock" };
    }
    if (enforced === 0 && action.kind === "payment") model = { window, spent: prior + action.amount };
    return { group, name: steps.length === 1 ? name : `${name} #${i}`, enforcedAt: now, args, evaluate, guard: enforced, spent, ...(step.fixture ? { fixture: step.fixture } : {}) };
  });
}

export const predicateVectorCases = (): VerdictCase[] => predicateVectors.cases.flatMap(c =>
  runPolicy("predicate-vectors", c.name, fixturePolicy(c.egressMode === "1" ? 1n : 0n), c.steps.map(s => ({
    action: toAction(s.action),
    fixture: { verdict: verdictOf(s.verdict), args: s.args, prior: s.priorSpent },
  }))));

export const guardVectorCases = (): VerdictCase[] => [
  ...guardVectors.cases.map(c => [c, 1n] as const),
  ...guardVectors.denyAllEgressCases.map(c => [c, 0n] as const),
].flatMap(([c, mode]) => runPolicy("guard-vectors", c.name, fixturePolicy(mode, c.capAmount), c.sequence.map(s => ({
  action: toAction(s.action),
  fixture: { verdict: verdictOf(s.expect) },
}))));

export const MAX_U64 = (1n << 64n) - 1n;

export function policy(p: { asset?: string; cap?: bigint; window?: bigint; notBefore?: bigint; notAfter?: bigint; counterparties?: readonly string[]; egress?: readonly string[] }): Policy {
  const counterparties = p.counterparties ?? ["alice", "bob"];
  return {
    mandate: {
      schemaVersion: 1n, mandateId: new Uint8Array(16), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321", didFormatVersion: 0n,
      spendCap: { asset: p.asset ?? "lovelace", amount: p.cap ?? 10n, windowSeconds: p.window ?? MAX_U64 },
      counterpartyAllowlistRoot: buildAllowlistRoot(counterparties),
      egressPolicy: p.egress ? { mode: 1n, allowlistRoot: buildAllowlistRoot(p.egress) } : { mode: 0n, allowlistRoot: new Uint8Array(32) },
      approvedMeasurementSetRoot: new Uint8Array(32),
      validityWindow: { notBefore: p.notBefore ?? 0n, notAfter: p.notAfter ?? MAX_U64 },
      disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n },
    },
    counterparties,
    ...(p.egress ? { egress: p.egress } : {}),
  };
}

export const payment = (amount: bigint, timestamp: bigint, asset = "lovelace", counterparty = "alice"): GuardAction =>
  ({ kind: "payment", asset, amount, counterparty, timestamp });
export const egress = (destination: string, timestamp: bigint): GuardAction => ({ kind: "egress", destination, timestamp });

const EGRESS_LIST = ["api.example.com", "payments.example.net"];

// notBefore 1000 and notAfter 2000 over one window. The clock is the action time, ahead of it but inside validity, or
// at or past notAfter; the 32 combinations with clock < notAfter <= ts are infeasible because the guard refuses an
// action later than its clock.
export function matrixCases(): VerdictCase[] {
  const cases: VerdictCase[] = [];
  const caps = { under: 6n, exact: 5n, over: 4n } as const;
  const clocks = { early: { ok: 500n, ahead: 1500n, expired: 2000n }, in: { ok: 1500n, ahead: 1999n, expired: 2000n }, late: { expired: 2500n } } as const;
  for (const [window, ts] of [["early", 500n], ["in", 1500n], ["late", 2500n]] as const) {
    for (const [clock, at] of Object.entries(clocks[window])) {
      for (const asset of ["ok", "bad"] as const) for (const cp of ["in", "out"] as const) for (const [cap, capAmount] of Object.entries(caps)) {
        const action = payment(5n, ts, asset === "ok" ? "lovelace" : "dust", cp === "in" ? "alice" : "mallory");
        cases.push(...runPolicy("matrix", `payment window=${window} asset=${asset} cp=${cp} cap=${cap} clock=${clock}`,
          policy({ cap: capAmount, notBefore: 1000n, notAfter: 2000n, egress: EGRESS_LIST }), [{ action, clock: at }]));
      }
      for (const mode of [0, 1] as const) for (const dest of ["in", "out"] as const) {
        const action = egress(dest === "in" ? "api.example.com" : "evil.example.com", ts);
        cases.push(...runPolicy("matrix", `egress window=${window} mode=${mode} dest=${dest} clock=${clock}`,
          policy({ notBefore: 1000n, notAfter: 2000n, ...(mode === 1 ? { egress: EGRESS_LIST } : {}) }), [{ action, clock: at }]));
      }
    }
  }
  return cases;
}

export function boundaryCases(): VerdictCase[] {
  const edges = [0n, 1n, MAX_U64 - 1n, MAX_U64];
  const cases: VerdictCase[] = [];
  for (const notBefore of edges) for (const notAfter of edges.filter(na => na > notBefore)) for (const ts of edges) for (const cap of [0n, MAX_U64]) {
    cases.push(...runPolicy("boundary", `notBefore=${notBefore} notAfter=${notAfter} ts=${ts} cap=${cap}`, policy({ notBefore, notAfter, cap }), [{ action: payment(1n, ts) }]));
  }
  const sums = [
    ["prior 2^64-1 plus 1 widens to 2^64", MAX_U64, [MAX_U64, 1n]],
    ["prior 2^64-1 plus 2^64-1 widens to 2^65-2", MAX_U64, [MAX_U64, MAX_U64]],
    ["prior 2^64-2 plus 1 reaches the cap exactly", MAX_U64, [MAX_U64 - 1n, 1n]],
    ["prior 2^64-2 plus 1 exceeds a cap of 2^64-2", MAX_U64 - 1n, [MAX_U64 - 1n, 1n]],
  ] as const;
  for (const [name, cap, amounts] of sums) cases.push(...runPolicy("boundary", name, policy({ cap }), amounts.map(amount => ({ action: payment(amount, 1500n) }))));
  return cases;
}

export function unicodeCases(): VerdictCase[] {
  const ascii128 = Array.from({ length: 128 }, (_, i) => String.fromCharCode(0x21 + (i % 94))).join("");
  const cardanoUnit = "f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc53541474958";
  const nfc = "café";
  const one = (name: string, p: Policy, action: GuardAction) => runPolicy("unicode", name, p, [{ action }]);
  return [
    ...one("Lovelace against lovelace", policy({}), payment(1n, 1500n, "Lovelace")),
    ...one("128-character ASCII mandate asset", policy({ asset: ascii128 }), payment(1n, 1500n, ascii128)),
    ...one("128-character asset with its last byte changed", policy({ asset: ascii128 }), payment(1n, 1500n, `${ascii128.slice(0, 127)}C`)),
    ...one("Cardano unit asset", policy({ asset: cardanoUnit }), payment(1n, 1500n, cardanoUnit)),
    ...one("action asset é", policy({}), payment(1n, 1500n, "é")),
    ...one("action asset emoji", policy({}), payment(1n, 1500n, "\u{1F600}")),
    ...one("action asset U+2028", policy({}), payment(1n, 1500n, "\u2028")),
    ...one("NFD counterparty against an NFC member", policy({ counterparties: [nfc] }), payment(1n, 1500n, "lovelace", nfc.normalize("NFD"))),
    ...one("NFC counterparty against an NFC member", policy({ counterparties: [nfc] }), payment(1n, 1500n, "lovelace", nfc)),
  ];
}

export const clockPolicy = (notBefore: bigint, notAfter: bigint) =>
  policy({ cap: 10n, window: 3600n, notBefore, notAfter, counterparties: ["supplier"] });
export const clockPayment = (timestamp: bigint) => payment(6n, timestamp, "lovelace", "supplier");

// The guard-state and attack fixtures' clock cases: a guard clock at or after notAfter denies whatever the action time,
// and a clock still inside validity leaves the decision to the action time.
export function clockCases(): VerdictCase[] {
  const at = (name: string, notBefore: bigint, notAfter: bigint, timestamp: bigint, clock: bigint) =>
    runPolicy("clock", name, clockPolicy(notBefore, notAfter), [{ action: clockPayment(timestamp), clock }]);
  return [
    ...at("F2: notAfter 7201, clock 7202, action 7200", 0n, 7201n, 7200n, 7202n),
    ...at("clock exactly at notAfter", 0n, 7201n, 7200n, 7201n),
    ...at("action before notBefore, clock at notAfter, one window", 7201n, 7202n, 7200n, 7202n),
    ...at("clock one second before notAfter", 0n, 7201n, 7200n, 7200n),
    ...at("action before notBefore, clock ahead at notBefore", 7201n, 9000n, 7200n, 7201n),
    ...at("action in validity, clock ahead and still in validity", 0n, 9000n, 7200n, 8999n),
    ...at("action after the guard clock", 0n, 100_000n, 7201n, 7200n),
  ];
}

export const withArg = (args: PredicateArgs, index: number, value: bigint | boolean) => args.with(index, value) as PredicateArgs;

// Argument changes the runtime has no input for: the expected decisions stay those of the unchanged action.
export function invarianceCases(): VerdictCase[] {
  const egressBases = [
    ...runPolicy("invariance", "egress allowed", policy({ egress: EGRESS_LIST }), [{ action: egress("api.example.com", 1500n) }]),
    ...runPolicy("invariance", "egress off-list", policy({ egress: EGRESS_LIST }), [{ action: egress("evil.example.com", 1500n) }]),
    ...runPolicy("invariance", "egress deny-all", policy({}), [{ action: egress("api.example.com", 1500n) }]),
    ...runPolicy("invariance", "egress before notBefore", policy({ notBefore: 2000n, egress: EGRESS_LIST }), [{ action: egress("api.example.com", 1500n) }]),
  ];
  const paymentBases = [
    ...runPolicy("invariance", "payment allowed", policy({}), [{ action: payment(5n, 1500n) }]),
    ...runPolicy("invariance", "payment over cap", policy({}), [{ action: payment(11n, 1500n) }]),
    ...runPolicy("invariance", "payment asset mismatch", policy({}), [{ action: payment(5n, 1500n, "dust") }]),
    ...runPolicy("invariance", "payment off-list", policy({}), [{ action: payment(5n, 1500n, "lovelace", "mallory") }]),
  ];
  return [
    ...egressBases.flatMap(c => [0n, 1n, MAX_U64].flatMap(prior => [false, true].map(counterpartyOk =>
      ({ ...c, name: `${c.name} prior_spent=${prior} counterparty_ok=${counterpartyOk}`, args: withArg(withArg(c.args, 10, prior), 9, counterpartyOk) })))),
    ...paymentBases.flatMap(c => [false, true].map(egressOk =>
      ({ ...c, name: `${c.name} egress_ok=${egressOk}`, args: withArg(c.args, 11, egressOk) }))),
  ];
}

export const allCases = (): VerdictCase[] => [
  ...predicateVectorCases(), ...guardVectorCases(), ...clockCases(), ...matrixCases(), ...boundaryCases(), ...unicodeCases(), ...invarianceCases(), ...domainCases(),
];

const KIND_REFUSAL = { throws: "failed assert: action kind out of domain" } as const;
const MODE_REFUSAL = { throws: "failed assert: egress mode out of domain" } as const;

// The schema admits only kind and mode 0 or 1, so the runtime has no decision here; the circuits must refuse.
export function domainCases(): VerdictCase[] {
  const bases = [
    ...runPolicy("domain", "payment", policy({ egress: EGRESS_LIST }), [{ action: payment(5n, 1500n) }]),
    ...runPolicy("domain", "payment, clock expired", policy({ notAfter: 2000n, egress: EGRESS_LIST }), [{ action: payment(5n, 1500n), clock: 2000n }]),
    ...runPolicy("domain", "egress", policy({ egress: EGRESS_LIST }), [{ action: egress("api.example.com", 1500n) }]),
    ...runPolicy("domain", "egress, clock expired", policy({ notAfter: 2000n }), [{ action: egress("api.example.com", 1500n), clock: 2000n }]),
  ];
  return bases.flatMap(c => [2n, 255n].flatMap(value => [
    { ...c, name: `${c.name} action_kind=${value}`, args: withArg(c.args, 5, value), evaluate: KIND_REFUSAL, guard: KIND_REFUSAL },
    { ...c, name: `${c.name} egress_mode=${value}`, args: withArg(c.args, 4, value), evaluate: MODE_REFUSAL, guard: MODE_REFUSAL },
  ]));
}

export function circuitOutcomes(pure: UnitModule["pureCircuits"], c: VerdictCase): { evaluate: Outcome; guard: Outcome } {
  return {
    evaluate: outcome(() => pure.evaluate!(...c.args)),
    guard: outcome(() => pure.guard_verdict!(c.enforcedAt, ...c.args)),
  };
}
