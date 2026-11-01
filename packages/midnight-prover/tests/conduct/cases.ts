import { readFileSync } from "node:fs";
import {
  assetTag, buildAllowlistRoot, compileMandatePredicate, MandateGuard, MemoryGuardLog, PREDICATE_LAYOUT, verdictOf,
  type GuardAction, type GuardDecision, type MandateV1, type PredicateArgs,
} from "@fluxpointstudios/orynq-sdk-conduct";
import { outcome, type Outcome, type UnitModule } from "./harness.js";

export const VERDICT_CODES = [0, 1, 2, 3, 4, 5, 6, 7] as const;
/** Claimed values tried against every case: each verdict code, then the first out-of-table Uint<8>, its high bit and its maximum. */
export const CLAIMS: readonly number[] = [...VERDICT_CODES, 8, 128, 255];

export interface VerdictCase {
  readonly group: string;
  readonly name: string;
  readonly enforcedAt: bigint;
  readonly args: PredicateArgs;
  /** The runtime's explicit-time decision, `MandateGuard.evaluate`, the judge of the 12-argument `evaluate`. */
  readonly evaluate: Outcome;
  /** The runtime's clocked decision, `MandateGuard.enforce`, the judge of `guard_verdict`. */
  readonly guard: Outcome;
  /** The spend before the step, on which the harness's per-window model and `guard.spentInWindow` agree. */
  readonly prior: bigint;
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

export const CLOCK_REFUSAL = /action timestamp must not be later than the guard clock/;

/** The messages of the circuit asserts that refuse an input, as `evaluate` and then `guard_verdict` add them. */
export const CIRCUIT_REFUSALS = ["validity window out of domain", "action kind out of domain", "egress mode out of domain", "payment amount out of domain", "action after guard clock"] as const;

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
    const spent = guard.spentInWindow(action.timestamp);
    if (prior !== spent) throw new Error(`${name} #${i}: the spend model holds ${prior} where the guard holds ${spent}`);
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
    return { group, name: steps.length === 1 ? name : `${name} #${i}`, enforcedAt: now, args, evaluate, guard: enforced, prior, ...(step.fixture ? { fixture: step.fixture } : {}) };
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
// at or past notAfter. A late action also meets two clocks still inside validity, which leave it later than the clock:
// the runtime and guard_verdict refuse those 32 combinations.
export function matrixCases(): VerdictCase[] {
  const cases: VerdictCase[] = [];
  const caps = { under: 6n, exact: 5n, over: 4n } as const;
  const clocks = {
    early: { ok: 500n, ahead: 1500n, expired: 2000n },
    in: { ok: 1500n, ahead: 1999n, expired: 2000n },
    late: { behind: 1500n, behindAtLastValid: 1999n, expired: 2500n },
  } as const;
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

export const clockPolicy = (notBefore: bigint, notAfter: bigint, cap = 10n) =>
  policy({ cap, window: 3600n, notBefore, notAfter, counterparties: ["supplier"], egress: ["api.example.com"] });
export const clockPayment = (timestamp: bigint) => payment(6n, timestamp, "lovelace", "supplier");

// The guard-state and attack fixtures' clock cases: a guard clock at or after notAfter denies whatever the action time,
// and a clock still inside validity leaves the decision to the action time. An action one second later than the clock
// is refused at every clock position, whether it is a payment or a listed or unlisted egress.
export function clockCases(): VerdictCase[] {
  const at = (name: string, notBefore: bigint, notAfter: bigint, action: GuardAction, clock: bigint) =>
    runPolicy("clock", name, clockPolicy(notBefore, notAfter), [{ action, clock }]);
  const positions = [
    ["before notBefore", 9000n, 10_000n, 8000n],
    ["inside validity", 0n, 100_000n, 7200n],
    ["at notAfter", 0n, 7300n, 7300n],
    ["past notAfter", 0n, 7300n, 8000n],
  ] as const;
  const kinds = [
    ["payment", clockPayment],
    ["listed egress", (timestamp: bigint) => egress("api.example.com", timestamp)],
    ["unlisted egress", (timestamp: bigint) => egress("evil.example.com", timestamp)],
  ] as const;
  return [
    ...at("F2: notAfter 7201, clock 7202, action 7200", 0n, 7201n, clockPayment(7200n), 7202n),
    ...at("clock exactly at notAfter", 0n, 7201n, clockPayment(7200n), 7201n),
    ...at("action before notBefore, clock at notAfter, one window", 7201n, 7202n, clockPayment(7200n), 7202n),
    ...at("clock one second before notAfter", 0n, 7201n, clockPayment(7200n), 7200n),
    ...at("action before notBefore, clock ahead at notBefore", 7201n, 9000n, clockPayment(7200n), 7201n),
    ...at("action in validity, clock ahead and still in validity", 0n, 9000n, clockPayment(7200n), 8999n),
    ...positions.flatMap(([position, notBefore, notAfter, clock]) => kinds.flatMap(([kind, action]) =>
      at(`${kind} one second after a guard clock ${position}`, notBefore, notAfter, action(clock + 1n), clock))),
  ];
}

// An allowed payment of `first` at 7200 opens the spend window [7200, 10800) of a clockPolicy, and `then` follows under
// `clock` with that payment as its prior spend.
function afterSpend(group: string, name: string, notAfter: bigint, then: GuardAction, clock: bigint, cap = 10n, first = 6n): VerdictCase {
  const [opening, step] = runPolicy(group, name, clockPolicy(0n, notAfter, cap), [{ action: payment(first, 7200n, "lovelace", "supplier") }, { action: then, clock }]);
  if (opening!.guard !== 0 || step!.prior !== first) throw new Error(`${name}: the opening payment must be allowed and carried as the prior spend`);
  return { ...step!, name };
}

// AM-4: after a spend in the window, every clock-decided and action-time expiry, a clock ahead inside validity where the
// prior decides 0 or 4, and an action one second later than the clock, which both refuse. The later-than-clock refusal
// also meets a prior of 1, the whole cap and 2^64-1, caps of 0 and 2^64-1, and payments of 1 and 2^64-1.
export function spentCases(): VerdictCase[] {
  const kinds = [
    ["a payment within the cap", (ts: bigint) => payment(4n, ts, "lovelace", "supplier")],
    ["a payment over the cap", (ts: bigint) => payment(5n, ts, "lovelace", "supplier")],
    ["a listed egress", (ts: bigint) => egress("api.example.com", ts)],
    ["an unlisted egress", (ts: bigint) => egress("evil.example.com", ts)],
  ] as const;
  const shapes = [
    ["clock at notAfter, action before it", 7300n, 7250n, 7300n],
    ["clock past notAfter, action before it", 7300n, 7250n, 8000n],
    ["action at notAfter", 7300n, 7300n, 7300n],
    ["action past notAfter", 7300n, 7400n, 7400n],
    ["clock ahead of the action inside validity", 100_000n, 7250n, 7300n],
    ["action one second after a clock inside validity", 100_000n, 7251n, 7250n],
    ["action one second after a clock at notAfter", 7300n, 7301n, 7300n],
    ["action one second after a clock past notAfter", 7300n, 8001n, 8000n],
  ] as const;
  const late = (name: string, then: GuardAction, cap: bigint, first?: bigint) => first === undefined
    ? runPolicy("spent", name, clockPolicy(0n, 100_000n, cap), [{ action: then, clock: 7250n }])[0]!
    : afterSpend("spent", name, 100_000n, then, 7250n, cap, first);
  const lateBy = (ts: bigint) => [["a payment of 1", payment(1n, ts, "lovelace", "supplier")], ["a listed egress", egress("api.example.com", ts)]] as const;
  return [
    ...shapes.flatMap(([shape, notAfter, ts, clock]) => kinds.map(([kind, action]) => afterSpend("spent", `${kind} after a spend, ${shape}`, notAfter, action(ts), clock))),
    ...lateBy(7251n).flatMap(([kind, action]) => [
      late(`${kind} after a spend of 1, one second after the clock`, action, 10n, 1n),
      late(`${kind} after a spend of the whole cap, one second after the clock`, action, 10n, 10n),
      late(`${kind} after a spend of 2^64-1 under a cap of 2^64-1, one second after the clock`, action, MAX_U64, MAX_U64),
      late(`${kind} under a cap of 0, one second after the clock`, action, 0n),
      late(`${kind} after a spend under a cap of 2^64-1, one second after the clock`, action, MAX_U64, 6n),
    ]),
    late("a payment of 2^64-1 after a spend, one second after the clock", payment(MAX_U64, 7251n, "lovelace", "supplier"), 10n, 6n),
  ];
}

export const T0 = 1_700_000_000n;
const HALF_U64 = 1n << 63n;
const LISTED = "api.example.com";
const UNLISTED = "evil.example.com";

type Scale = "bottom" | "realistic" | "top";
interface Timing { readonly nb: bigint; readonly na: bigint; readonly ts: bigint; readonly clock: bigint; readonly window?: bigint; readonly openAt?: bigint }

const daily = (ts: bigint, clock: bigint, openAt?: bigint): Timing =>
  ({ nb: T0, na: T0 + 3600n, ts, clock, window: 86_400n, ...(openAt === undefined ? {} : { openAt }) });

// An action and clock position at the bottom of uint64, at Unix times in one day's spend window, and at the top. With
// `openAt`, an allowed payment at that time opens the spend window, so the step carries a prior spend. A top position
// whose clock shares a spend window with an earlier action only at 2^64-1 uses a window of 2^63.
const POSITIONS: readonly (readonly [string, Record<Scale, Timing>])[] = [
  ["before notBefore", {
    bottom: { nb: 1n, na: 2n, ts: 0n, clock: 0n },
    realistic: daily(T0 - 100n, T0 - 50n),
    top: { nb: MAX_U64 - 1n, na: MAX_U64, ts: MAX_U64 - 2n, clock: MAX_U64 - 1n },
  }],
  ["at notAfter", {
    bottom: { nb: 0n, na: 1n, ts: 1n, clock: 1n },
    realistic: daily(T0 + 3600n, T0 + 3600n, T0 + 100n),
    top: { nb: MAX_U64 - 3n, na: MAX_U64 - 1n, ts: MAX_U64 - 1n, clock: MAX_U64 - 1n, openAt: MAX_U64 - 3n },
  }],
  ["before notBefore, clock at or past notAfter", {
    bottom: { nb: 1n, na: 2n, ts: 0n, clock: 2n },
    realistic: daily(T0 - 100n, T0 + 3600n),
    top: { nb: MAX_U64 - 1n, na: MAX_U64, ts: MAX_U64 - 2n, clock: MAX_U64, window: HALF_U64 },
  }],
  ["inside validity, clock at or past notAfter", {
    bottom: { nb: 0n, na: 1n, ts: 0n, clock: 1n },
    realistic: daily(T0 + 200n, T0 + 3700n, T0 + 100n),
    top: { nb: MAX_U64 - 1n, na: MAX_U64, ts: MAX_U64 - 1n, clock: MAX_U64, window: HALF_U64, openAt: MAX_U64 - 1n },
  }],
  ["later than a clock before notBefore", {
    bottom: { nb: 2n, na: 3n, ts: 1n, clock: 0n },
    realistic: daily(T0 - 50n, T0 - 100n),
    top: { nb: MAX_U64 - 1n, na: MAX_U64, ts: MAX_U64 - 2n, clock: MAX_U64 - 3n },
  }],
  ["later than a clock inside validity", {
    bottom: { nb: 0n, na: 2n, ts: 1n, clock: 0n },
    realistic: daily(T0 + 201n, T0 + 200n, T0 + 100n),
    top: { nb: MAX_U64 - 2n, na: MAX_U64, ts: MAX_U64 - 1n, clock: MAX_U64 - 2n, openAt: MAX_U64 - 2n },
  }],
  ["at notAfter, later than a clock inside validity", {
    bottom: { nb: 0n, na: 1n, ts: 1n, clock: 0n },
    realistic: daily(T0 + 3600n, T0 + 3599n, T0 + 100n),
    top: { nb: MAX_U64 - 2n, na: MAX_U64, ts: MAX_U64, clock: MAX_U64 - 1n, window: HALF_U64, openAt: MAX_U64 - 2n },
  }],
  ["later than a clock past notAfter", {
    bottom: { nb: 0n, na: 1n, ts: 2n, clock: 1n },
    realistic: daily(T0 + 3700n, T0 + 3650n, T0 + 100n),
    top: { nb: MAX_U64 - 3n, na: MAX_U64 - 1n, ts: MAX_U64, clock: MAX_U64 - 1n, window: HALF_U64, openAt: MAX_U64 - 3n },
  }],
];

const INSIDE_VALIDITY: Record<Scale, Timing> = {
  bottom: { nb: 0n, na: 1n, ts: 0n, clock: 0n },
  realistic: daily(T0 + 200n, T0 + 300n, T0 + 100n),
  top: { nb: MAX_U64 - 1n, na: MAX_U64, ts: MAX_U64 - 1n, clock: MAX_U64 - 1n, openAt: MAX_U64 - 1n },
};

interface Mandate { readonly cap: bigint; readonly opening: bigint; readonly list: boolean }
const SCALES: Record<Scale, Mandate & { readonly amount: bigint; readonly payment: (ts: bigint) => GuardAction; readonly egress: (ts: bigint) => GuardAction }> = {
  bottom: { cap: 0n, opening: 0n, list: false, amount: 1n, payment: ts => payment(1n, ts), egress: ts => egress(LISTED, ts) },
  realistic: { cap: 10_000_000n, opening: 4_000_000n, list: true, amount: 7_000_000n, payment: ts => payment(7_000_000n, ts, "dust", "mallory"), egress: ts => egress(UNLISTED, ts) },
  top: { cap: MAX_U64, opening: MAX_U64, list: true, amount: MAX_U64, payment: ts => payment(MAX_U64, ts), egress: ts => egress(LISTED, ts) },
};

const insideValidity = (scale: Scale): readonly (readonly [string, (ts: bigint) => GuardAction, Partial<Mandate>])[] => {
  const { amount } = SCALES[scale];
  const allowed = { bottom: [1n, { cap: 1n }], realistic: [6_000_000n, {}], top: [1n, { opening: MAX_U64 - 1n }] } as const;
  return [
    ["asset mismatch", ts => payment(amount, ts, "dust"), {}],
    ["counterparty off-list", ts => payment(amount, ts, "lovelace", "mallory"), {}],
    ["payment over the cap", ts => payment(amount, ts), {}],
    ["allowed payment", ts => payment(allowed[scale][0], ts), allowed[scale][1]],
    ["deny-all egress", ts => egress(LISTED, ts), { list: false }],
    ["off-list egress", ts => egress(UNLISTED, ts), { list: true }],
    ["allowed egress", ts => egress(LISTED, ts), { list: true }],
  ];
};

function scene(scale: Scale, name: string, timing: Timing, action: (ts: bigint) => GuardAction, overrides: Partial<Mandate> = {}): VerdictCase[] {
  const { cap, opening, list } = { ...SCALES[scale], ...overrides };
  const { nb: notBefore, na: notAfter, window } = timing;
  const p = policy({ cap, notBefore, notAfter, ...(window === undefined ? {} : { window }), ...(list ? { egress: [LISTED] } : {}) });
  const open = timing.openAt === undefined ? [] : [{ action: payment(opening, timing.openAt), clock: timing.openAt }];
  const steps = runPolicy("range", `${name}, ${scale}`, p, [...open, { action: action(timing.ts), clock: timing.clock }]);
  if (open.length > 0 && steps[0]!.guard !== 0) throw new Error(`${name}, ${scale}: the opening payment must be allowed`);
  return steps;
}

// Every verdict and the later-than-clock refusal, for a payment and an egress at every validity and clock position, at
// the bottom of uint64, at realistic Unix times and at the top. A verdict rule or refusal gated on a slot's size
// survives every case that holds that slot on one side of the gate, so each outcome meets every slot at both ends.
function rangeHistories(): { readonly scale: Scale; readonly steps: VerdictCase[] }[] {
  return (["bottom", "realistic", "top"] as const).flatMap(scale => [
    ...POSITIONS.flatMap(([position, timings]) => [
      { scale, steps: scene(scale, `payment ${position}`, timings[scale], SCALES[scale].payment) },
      { scale, steps: scene(scale, `egress ${position}`, timings[scale], SCALES[scale].egress) },
    ]),
    ...insideValidity(scale).map(([name, action, overrides]) => ({ scale, steps: scene(scale, name, INSIDE_VALIDITY[scale], action, overrides) })),
  ]);
}

export const rangeCases = (): VerdictCase[] => rangeHistories().flatMap(h => h.steps);

export const withArg = (args: PredicateArgs, index: number, value: bigint | boolean) => args.map((arg, i) => (i === index ? value : arg)) as PredicateArgs;

const SLOTS = new Map(PREDICATE_LAYOUT.map((input, index) => [input.name, index]));
/** The width of each Uint input type of the predicate layout. */
export const UINT_BITS: Readonly<Record<string, number>> = { uint64: 64, uint8: 8 };

export function slot(name: string): number {
  const index = SLOTS.get(name);
  if (index === undefined) throw new Error(`no predicate slot ${name}`);
  return index;
}

function vary(c: VerdictCase, changes: Readonly<Record<string, bigint | boolean>>): VerdictCase {
  const label = (value: bigint | boolean) => value === c.args[slot("cap_asset")] ? "cap_asset" : String(value);
  return {
    ...c,
    name: `${c.name} ${Object.entries(changes).map(([name, value]) => `${name}=${label(value)}`).join(" ")}`,
    args: Object.entries(changes).reduce((args, [name, value]) => withArg(args, slot(name), value), c.args),
  };
}

const DUST_TAG = assetTag("dust");
const otherEnd = (value: bigint, low: bigint) => (value >= HALF_U64 ? low : MAX_U64);

// Moves every slot that neither runtime decision reads to its other end, so the expected decisions stay the unmodified
// action's. A payment never reads egress_ok; once the validity window decides it, nor the asset, membership, prior
// spend or amount; once the asset decides it, nor the later three; once membership decides it, nor the last two. An
// egress never reads the payment slots, and once the validity window or deny-all decides it, nor egress_ok.
function flipIgnored(c: VerdictCase): VerdictCase {
  const at = (name: string) => c.args[slot(name)]!;
  const decided = c.evaluate as number;
  const asset = at("action_asset") === at("cap_asset") ? DUST_TAG : at("cap_asset") as bigint;
  const changes: Record<string, bigint | boolean> = at("action_kind") === 0n
    ? {
        egress_ok: !at("egress_ok"),
        ...(decided === 1 || decided === 2 ? { action_asset: asset } : {}),
        ...([1, 2, 3].includes(decided) ? { counterparty_ok: !at("counterparty_ok") } : {}),
        ...([1, 2, 3, 5].includes(decided) ? { prior_spent: otherEnd(at("prior_spent") as bigint, 0n), action_amount: otherEnd(at("action_amount") as bigint, 1n) } : {}),
      }
    : {
        action_asset: asset, counterparty_ok: !at("counterparty_ok"),
        prior_spent: otherEnd(at("prior_spent") as bigint, 0n), action_amount: otherEnd(at("action_amount") as bigint, 0n),
        ...([1, 2, 6].includes(decided) ? { egress_ok: !at("egress_ok") } : {}),
      };
  return { ...vary(c, changes), group: "invariance" };
}

const rangeBases = () => rangeHistories().map(({ scale, steps }) => ({ scale, base: steps.at(-1)! }));

// Argument changes the runtime has no input for: the expected decisions stay those of the unchanged action. An egress
// ignores prior_spent, counterparty_ok, action_asset and action_amount, and also egress_ok once deny-all or the
// validity window decides; a payment ignores egress_ok. Every range case also has each slot its decisions ignore moved
// to the other end.
export function invarianceCases(): VerdictCase[] {
  const egressBase = (name: string, p: Policy, destination: string, egressOkIgnored: boolean) =>
    ({ base: runPolicy("invariance", name, p, [{ action: egress(destination, 1500n) }])[0]!, egressOkIgnored });
  const egressBases = [
    egressBase("egress allowed", policy({ egress: EGRESS_LIST }), "api.example.com", false),
    egressBase("egress off-list", policy({ egress: EGRESS_LIST }), "evil.example.com", false),
    egressBase("egress deny-all", policy({}), "api.example.com", true),
    egressBase("egress before notBefore", policy({ notBefore: 2000n, egress: EGRESS_LIST }), "api.example.com", true),
  ];
  const paymentBases = [
    ...runPolicy("invariance", "payment allowed", policy({}), [{ action: payment(5n, 1500n) }]),
    ...runPolicy("invariance", "payment over cap", policy({}), [{ action: payment(11n, 1500n) }]),
    ...runPolicy("invariance", "payment asset mismatch", policy({}), [{ action: payment(5n, 1500n, "dust") }]),
    ...runPolicy("invariance", "payment off-list", policy({}), [{ action: payment(5n, 1500n, "lovelace", "mallory") }]),
  ];
  return [
    ...egressBases.flatMap(({ base, egressOkIgnored }) => {
      const capAsset = base.args[slot("cap_asset")] as bigint;
      const egressOk = egressOkIgnored ? [{ egress_ok: true }] : [];
      return [
        ...[0n, 1n, MAX_U64].flatMap(prior => [false, true].map(counterpartyOk => ({ prior_spent: prior, counterparty_ok: counterpartyOk }))),
        { action_asset: capAsset }, { action_amount: 1n }, { action_amount: MAX_U64 }, ...egressOk,
        Object.assign({ prior_spent: MAX_U64, counterparty_ok: true, action_asset: capAsset, action_amount: MAX_U64 }, ...egressOk),
      ].map(changes => vary(base, changes));
    }),
    ...paymentBases.flatMap(c => [false, true].map(egressOk => vary(c, { egress_ok: egressOk }))),
    ...rangeBases().map(({ base }) => flipIgnored(base)),
  ];
}

// The runtime never holds a prior spend above the cap, so such a prior is judged by the runtime's decision on a fresh
// payment of the same total.
export function overCapPriorCases(): VerdictCase[] {
  const cap = 10n;
  const bases = [["allowed", 5n, "lovelace", "alice"], ["over cap", 11n, "lovelace", "alice"], ["asset mismatch", 5n, "dust", "alice"], ["off-list", 5n, "lovelace", "mallory"]] as const;
  return bases.flatMap(([name, amount, asset, counterparty]) => [cap + 1n, cap + amount, 1n << 63n].map(prior => {
    const once = (total: bigint) => runPolicy("prior", `payment ${name}`, policy({ cap }), [{ action: payment(total, 1500n, asset, counterparty) }])[0]!;
    const total = once(prior + amount);
    return { ...vary(once(amount), { prior_spent: prior }), evaluate: total.evaluate, guard: total.guard };
  }));
}

export const allCases = (): VerdictCase[] => [
  ...predicateVectorCases(), ...guardVectorCases(), ...clockCases(), ...matrixCases(), ...boundaryCases(), ...unicodeCases(), ...rangeCases(),
  ...invarianceCases(), ...overCapPriorCases(), ...spentCases(), ...domainCases(),
];

const VALIDITY_REFUSAL = { throws: "failed assert: validity window out of domain" } as const;
const KIND_REFUSAL = { throws: "failed assert: action kind out of domain" } as const;
const MODE_REFUSAL = { throws: "failed assert: egress mode out of domain" } as const;
const AMOUNT_REFUSAL = { throws: "failed assert: payment amount out of domain" } as const;

// The schema admits only kind and mode 0 or 1, a payment of at least 1 and a validity window with notBefore before
// notAfter, so the runtime has no input here and no decision to compare: both circuits must refuse, whichever validity
// check would otherwise decide. Refusal never depends on the prior spend, the cap or the amount, so the refusals inside
// validity also meet their edges.
export function domainCases(): VerdictCase[] {
  const inValidity = [
    ...runPolicy("domain", "payment", policy({ egress: EGRESS_LIST }), [{ action: payment(5n, 1500n) }]),
    ...runPolicy("domain", "egress", policy({ egress: EGRESS_LIST }), [{ action: egress("api.example.com", 1500n) }]),
  ];
  const bases = [
    ...inValidity,
    ...runPolicy("domain", "payment, clock expired", policy({ notAfter: 2000n, egress: EGRESS_LIST }), [{ action: payment(5n, 1500n), clock: 2000n }]),
    ...runPolicy("domain", "payment before notBefore", policy({ notBefore: 1000n, egress: EGRESS_LIST }), [{ action: payment(5n, 500n) }]),
    ...runPolicy("domain", "payment at notAfter", policy({ notAfter: 2000n, egress: EGRESS_LIST }), [{ action: payment(5n, 2000n) }]),
    ...runPolicy("domain", "egress, clock expired", policy({ notAfter: 2000n }), [{ action: egress("api.example.com", 1500n), clock: 2000n }]),
    ...runPolicy("domain", "egress before notBefore", policy({ notBefore: 1000n, egress: EGRESS_LIST }), [{ action: egress("api.example.com", 500n) }]),
    ...runPolicy("domain", "egress at notAfter", policy({ notAfter: 2000n, egress: EGRESS_LIST }), [{ action: egress("api.example.com", 2000n) }]),
    afterSpend("domain", "payment after a spend", 100_000n, payment(4n, 7250n, "lovelace", "supplier"), 7300n),
    afterSpend("domain", "egress after a spend", 100_000n, egress("api.example.com", 7250n), 7300n),
  ];
  const refuse = (c: VerdictCase, changes: Readonly<Record<string, bigint | boolean>>, refusal: Outcome) => ({ ...vary(c, changes), group: "domain", evaluate: refusal, guard: refusal });
  const refusals = (c: VerdictCase, values: readonly bigint[], zeroPayment: boolean) => [
    ...values.flatMap(value => [refuse(c, { action_kind: value }, KIND_REFUSAL), refuse(c, { egress_mode: value }, MODE_REFUSAL)]),
    ...(zeroPayment ? [refuse(c, { action_amount: 0n }, AMOUNT_REFUSAL)] : []),
  ];
  const isPayment = (c: VerdictCase) => c.args[slot("action_kind")] === 0n;
  const edges = (c: VerdictCase) => [
    { prior_spent: 1n }, { prior_spent: c.args[slot("cap_amount")] as bigint }, { prior_spent: MAX_U64 }, { cap_amount: 0n }, { cap_amount: MAX_U64 },
  ];
  // Every range base the runtime decides, and the top one with its ignored slots moved to the other end, which puts a
  // prior spend of 2^64-1 before notBefore and a payment's egress_ok at true.
  const decided = rangeBases().filter(({ base }) => typeof base.guard === "number");
  const ranged = [...decided.map(({ base }) => base), ...decided.filter(({ scale }) => scale === "top").map(({ base }) => flipIgnored(base))];
  const emptyWindows = (c: VerdictCase) => [{ not_before: c.args[slot("not_after")] as bigint }, { not_before: c.args[slot("not_after")] as bigint, not_after: c.args[slot("not_before")] as bigint }];
  // An empty window at each position an action not later than the clock can take, as [notBefore, notAfter, action
  // time, clock] at the bottom of uint64 and at the top; every other slot, which the refusal leaves free, sits at the
  // other end.
  const EMPTY_WINDOWS = [
    [[1n, 1n, 0n, 0n], [MAX_U64, MAX_U64, MAX_U64 - 1n, MAX_U64 - 1n]],
    [[1n, 0n, 0n, 0n], [MAX_U64, MAX_U64, MAX_U64 - 1n, MAX_U64]],
    [[0n, 0n, 0n, 0n], [MAX_U64, MAX_U64, MAX_U64, MAX_U64]],
  ] as const;
  const emptyWindowEnds = inValidity.flatMap(c => EMPTY_WINDOWS.flat().map(([notBefore, notAfter, ts, clock]) => {
    const bottom = ts === 0n;
    const refused = refuse(c, {
      not_before: notBefore, not_after: notAfter, action_timestamp: ts, cap_amount: bottom ? MAX_U64 : 0n, prior_spent: bottom ? MAX_U64 : 0n,
      action_amount: bottom ? MAX_U64 : isPayment(c) ? 1n : 0n, egress_mode: bottom ? 0n : 1n, action_asset: bottom ? c.args[slot("cap_asset")]! : DUST_TAG,
      counterparty_ok: bottom, egress_ok: !bottom,
    }, VALIDITY_REFUSAL);
    return { ...refused, name: `${refused.name} clock=${clock}`, enforcedAt: clock };
  }));
  return [
    ...bases.flatMap(c => emptyWindows(c).map(changes => refuse(c, changes, VALIDITY_REFUSAL))),
    ...emptyWindowEnds,
    ...bases.flatMap(c => refusals(c, [2n, 255n], isPayment(c))),
    ...inValidity.flatMap(c => edges(c).flatMap(edge => refusals(vary(c, edge), [2n], isPayment(c)))),
    ...[1n, MAX_U64].flatMap(amount => refusals(vary(inValidity[0]!, { action_amount: amount }), [2n], false)),
    ...ranged.flatMap(c => refusals(c, [2n], isPayment(c))),
  ];
}

/** The arguments of `check_verdict`: the guard clock, the 12 predicate slots and a claimed verdict. */
export const checkVerdictArgs = (c: Pick<VerdictCase, "enforcedAt" | "args">, claimed: number) => [c.enforcedAt, ...c.args, BigInt(claimed)];

export function circuitOutcomes(pure: UnitModule["pureCircuits"], c: Pick<VerdictCase, "enforcedAt" | "args">): { evaluate: Outcome; guard: Outcome } {
  return {
    evaluate: outcome(() => pure.evaluate!(...c.args)),
    guard: outcome(() => pure.guard_verdict!(c.enforcedAt, ...c.args)),
  };
}
