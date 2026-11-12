import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  actionDigestHex, buildAllowlistRoot, MandateGuard, mandateCommitmentHex, MemoryGuardLog, processTraceSink, verdictOf,
  type GuardAction, type GuardDecision, type GuardEvent, type MandateV1, type PaymentAction,
} from "@fluxpointstudios/orynq-sdk-conduct";
import { addSpan, createTrace, type TraceEvent } from "@fluxpointstudios/orynq-sdk-process-trace";
import { allowlistPath, classify, CLASSES, eventSegments, stepActionDigest, stepClass, stepOpening } from "../../scripts/conduct/template.mjs";
import { MAX_U64 } from "./cases.js";
import { PROFILES } from "./guard-events.js";
import { loadUnit, prepareCheck, runLedger, type PreparedCheck } from "./harness.js";
import { settle, sha256 } from "./openings.js";

export const STEPS_UNIT = "steps";
// Every step test reads the compiled unit, so a missing build fails each of them with the harness's own message.
await loadUnit(STEPS_UNIT);
/** The ledger cell every step class writes its statement to. */
export const STEP_CELL = "conductStep";
/** The fields of S-CONDUCT-STEP, in the order the ledger cell holds them. It carries no leaf index: membership is of a set. */
export const STEP_FIELDS = ["prevRollHex", "rollAfter", "atoms", "windowIndex", "priorSpent", "verdict", "dataSeq", "traceSeq"] as const;

/** The discrimination mutants of the steps unit; steps-mutants.test.ts kills each one. */
export const STEPS_MUTANTS = [
  "step_no_recorded_decision", "step_verdict_unbound", "step_no_action_digest_link", "step_no_commitment_link", "step_window_index_unbound",
  "step_asset_unchecked", "step_member_unchecked", "window_remainder_unchecked", "allowlist_inactive_level_free", "allowlist_direction_ignored",
];

export interface PathStep { readonly active: boolean; readonly sibRight: boolean; readonly sib: Uint8Array }
export interface MandateAtoms {
  readonly notBefore: bigint; readonly notAfter: bigint; readonly assetDigest: Uint8Array; readonly capAmount: bigint; readonly windowSeconds: bigint;
  readonly egressMode: bigint; readonly counterpartyRoot: Uint8Array; readonly egressRoot: Uint8Array;
}
export interface WindowSplit { readonly q: bigint; readonly r: bigint; readonly rClock: bigint }
/** What a step proof takes beside the event bytes: the mandate atoms K commits, the membership path and the stated prior spend. */
export interface StepContext {
  readonly atoms: MandateAtoms;
  readonly path?: readonly PathStep[];
  readonly priorSpent: bigint;
  readonly commitment?: Uint8Array;
  readonly window?: WindowSplit;
}
export type StepWitness = Uint8Array | MandateAtoms | WindowSplit | readonly PathStep[];
export interface StepOpening {
  readonly circuit: string;
  readonly kind: string;
  readonly segments: Readonly<Record<string, Uint8Array>>;
  readonly prevRollHex: string;
  readonly context: StepContext;
  readonly witnesses: Readonly<Record<string, StepWitness>>;
  readonly statement: Readonly<Record<string, Uint8Array | bigint>>;
}

interface StepClass { readonly kind: string; readonly lengths: Record<string, number>; readonly cbor: Record<string, number>; readonly depth?: number }
export const STEP_CLASSES: Readonly<Record<string, StepClass>> = CLASSES.steps;

/** The mandate the step classes weld to in the tests: the m_step opening class, with the lists its roots commit. */
export interface StepWorld {
  readonly mandate: MandateV1;
  readonly counterparties: readonly string[];
  /** Absent under deny-all. */
  readonly egress?: readonly string[];
}

export interface WorldSpec {
  readonly asset: string; readonly capAmount: string; readonly windowSeconds: string; readonly notBefore: string; readonly notAfter: string;
  readonly counterparties: readonly string[]; readonly egress: readonly string[] | null;
}

export function stepWorld(spec: WorldSpec): StepWorld {
  const mandate: MandateV1 = {
    schemaVersion: 1n, mandateId: new Uint8Array(16).fill(0x5a), principalDid: "did:key:z6MkhaXgB", agentDid: "did:key:z6MkjchhF", didFormatVersion: 0n,
    spendCap: { asset: spec.asset, amount: BigInt(spec.capAmount), windowSeconds: BigInt(spec.windowSeconds) },
    counterpartyAllowlistRoot: buildAllowlistRoot(spec.counterparties),
    egressPolicy: spec.egress === null ? { mode: 0n, allowlistRoot: new Uint8Array(32) } : { mode: 1n, allowlistRoot: buildAllowlistRoot(spec.egress) },
    approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: BigInt(spec.notBefore), notAfter: BigInt(spec.notAfter) },
    disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n },
  };
  return { mandate, counterparties: spec.counterparties, ...(spec.egress === null ? {} : { egress: spec.egress }) };
}

/** The atoms of a mandate that K commits and a step reads. */
export function atomsOf(m: MandateV1): MandateAtoms {
  return {
    notBefore: m.validityWindow.notBefore, notAfter: m.validityWindow.notAfter, assetDigest: sha256(m.spendCap.asset), capAmount: m.spendCap.amount,
    windowSeconds: m.spendCap.windowSeconds, egressMode: m.egressPolicy.mode, counterpartyRoot: m.counterpartyAllowlistRoot, egressRoot: m.egressPolicy.allowlistRoot,
  };
}

interface FixtureStep {
  readonly kind: "payment" | "egress"; readonly amount?: string; readonly asset?: string; readonly counterparty?: string; readonly destination?: string;
  readonly at?: string; readonly clock?: string; readonly expect: number;
}
export interface FixtureCase { readonly name: string; readonly mandate?: Partial<WorldSpec>; readonly steps: readonly FixtureStep[] }
interface Fixture {
  readonly mandate: WorldSpec;
  readonly defaults: { readonly asset: string; readonly counterparty: string; readonly destination: string; readonly amount: string; readonly at: string };
  readonly cases: readonly FixtureCase[];
}
export const STEP_FIXTURE: Fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/step-sequences.json"), "utf8"));

export const worldOf = (c: Pick<FixtureCase, "mandate">): StepWorld => stepWorld({ ...STEP_FIXTURE.mandate, ...c.mandate });

export function actionOf(step: FixtureStep): GuardAction {
  const d = STEP_FIXTURE.defaults;
  const timestamp = BigInt(step.at ?? d.at);
  return step.kind === "payment"
    ? { kind: "payment", asset: step.asset ?? d.asset, amount: BigInt(step.amount ?? d.amount), counterparty: step.counterparty ?? d.counterparty, timestamp }
    : { kind: "egress", destination: step.destination ?? d.destination, timestamp };
}

/** One enforced step of a real guard, as the trace holds it, with the spend the guard held before it. */
export interface TracedStep {
  readonly action: GuardAction;
  readonly decision: GuardDecision;
  readonly verdict: number;
  readonly guardEvent: GuardEvent;
  readonly event: TraceEvent;
  readonly rollBefore: string;
  readonly rollAfter: string;
  /** The harness's own model of the spend in the action's window before the step. */
  readonly priorSpent: bigint;
  /** `guard.spentInWindow` at the action time before the step. */
  readonly runtimePrior: bigint;
}

/** The trace sequence of the first traced step: apart from the guard log position, so no two statement fields agree. */
export const FIRST_TRACE_SEQ = 3;

/**
 * Enforces the steps through one real guard whose sink appends to a MemoryGuardLog and then to a process-trace run. The
 * prior spend is tracked twice: by the harness's own per-window model and by the guard.
 */
export async function traceWorld(world: StepWorld, steps: readonly { action: GuardAction; clock?: bigint }[]): Promise<TracedStep[]> {
  const log = new MemoryGuardLog();
  const run = await createTrace({ agentId: "conduct-steps" });
  run.nextSeq = FIRST_TRACE_SEQ;
  const spanId = addSpan(run, { name: "guard" }).id;
  let clock = 0n;
  let traced: Pick<TracedStep, "guardEvent" | "event" | "rollBefore" | "rollAfter"> | undefined;
  const guard = new MandateGuard({
    mandate: world.mandate, counterpartyAllowlist: world.counterparties, ...(world.egress === undefined ? {} : { egressAllowlist: world.egress }),
    history: "fresh", now: () => clock,
    onEvent: async (guardEvent, previous) => {
      const head = log.append(guardEvent, previous);
      const rollBefore = run.rollingHash;
      const event = await processTraceSink(run, spanId, "private")(guardEvent);
      traced = { guardEvent, event, rollBefore, rollAfter: run.rollingHash };
      return head;
    },
  });
  const width = world.mandate.spendCap.windowSeconds;
  let model = { window: -1n, spent: 0n };
  const out: TracedStep[] = [];
  for (const { action, clock: at } of steps) {
    clock = at ?? action.timestamp;
    const window = action.timestamp / width;
    const priorSpent = window === model.window ? model.spent : 0n;
    const runtimePrior = guard.spentInWindow(action.timestamp);
    const decision = await guard.enforceAsync(action);
    if (decision.allowed && action.kind === "payment") model = { window, spent: priorSpent + action.amount };
    out.push({ action, decision, verdict: decision.allowed ? 0 : verdictOf(decision.reason), priorSpent, runtimePrior, ...traced! });
  }
  return out;
}

export const runCase = (c: FixtureCase): Promise<TracedStep[]> =>
  traceWorld(worldOf(c), c.steps.map(step => ({ action: actionOf(step), ...(step.clock === undefined ? {} : { clock: BigInt(step.clock) }) })));

/**
 * An allowed payment at the top of every length, for st_pa_max_d8. No guard log reaches a 20-digit position, so the
 * guard event is built by hand, `offset` below its amount; the trace sink validates it with the producer's own snapshot
 * before process-trace hashes it, and a real guard under the same mandate and clock decides the same action.
 */
export async function maxStep(offset = 0n): Promise<{ step: TracedStep; world: StepWorld; runtime: GuardDecision }> {
  const p = PROFILES["max-in-class"];
  const counterparties = [p.counterparty, ...Array.from({ length: 32 }, (_, i) => `member-${i}`)];
  const egress = [p.destination];
  const base = stepWorld({ ...STEP_FIXTURE.mandate, counterparties, egress });
  const mandate: MandateV1 = {
    ...base.mandate, spendCap: { asset: p.asset, amount: MAX_U64, windowSeconds: p.windowSeconds }, validityWindow: { notBefore: p.notBefore, notAfter: p.notAfter },
  };
  const world: StepWorld = { mandate, counterparties, egress };
  const action: PaymentAction = { kind: "payment", asset: p.asset, amount: p.amount - offset, counterparty: p.counterparty, timestamp: p.at };
  const enforcedAt = p.at + p.clockLag;
  const runtime = new MandateGuard({ mandate, counterpartyAllowlist: counterparties, egressAllowlist: egress, history: "fresh", now: () => enforcedAt }).enforce(action);
  const guardEvent: GuardEvent = {
    type: "orynq.conduct.guard.action.v1", seq: 10n ** 19n + 7n, timestamp: action.timestamp, enforcedAt, mandateCommitment: mandateCommitmentHex(mandate),
    actionDigest: actionDigestHex(action), actionKind: "payment", action,
  };
  const run = await createTrace({ agentId: "conduct-steps" });
  run.nextSeq = p.traceSeq;
  const rollBefore = run.rollingHash;
  const event = await processTraceSink(run, addSpan(run, { name: "guard" }).id, p.visibility)(guardEvent);
  return { step: { action, decision: runtime, verdict: 0, guardEvent, event, rollBefore, rollAfter: run.rollingHash, priorSpent: 0n, runtimePrior: 0n }, world, runtime };
}

/** The member whose path a step class walks, and the list its root commits; undefined where the class reads no path. */
function membership(circuit: string, action: GuardAction, world: StepWorld): { members: readonly string[]; member: string; depth: number } | undefined {
  const { depth } = STEP_CLASSES[circuit]!;
  if (depth === undefined) return undefined;
  return action.kind === "payment" ? { members: world.counterparties, member: action.counterparty, depth } : { members: world.egress ?? [], member: action.destination, depth };
}

/**
 * The step opening of a traced guard event: its class by `classify` and `stepClass`, the atoms of the world's mandate,
 * the member's path in the world's list and the given prior spend. A denial 5 or 7 has no class and is refused.
 */
export function stepOpeningOf(step: Pick<TracedStep, "action" | "event" | "rollBefore" | "priorSpent">, world: StepWorld): StepOpening {
  const classified = classify(step.event);
  const circuit: string = stepClass(classified);
  const segments: Record<string, Uint8Array> = eventSegments(classified);
  const walk = membership(circuit, step.action, world);
  const context: StepContext = {
    atoms: atomsOf(world.mandate), priorSpent: step.priorSpent,
    ...(walk === undefined ? {} : { path: allowlistPath(walk.members, walk.member, walk.depth).path as PathStep[] }),
  };
  return { circuit, kind: classified.kind, segments, prevRollHex: step.rollBefore, context, ...stepOpening(circuit, segments, step.rollBefore, context) };
}

/**
 * The opening with segments or context replaced and everything else re-derived from them as the circuit derives it, so
 * the action digest (unless it is itself replaced), the event hash, the rolling step, K, the window split and the
 * statement hold; `claim` then overrides statement fields.
 */
export function rederivedStep(
  o: StepOpening, changes: { readonly segments?: Readonly<Record<string, Uint8Array>>; readonly context?: Partial<StepContext> },
  claim: Readonly<Record<string, Uint8Array | bigint>> = {},
): StepOpening {
  const replaced = { ...o.segments, ...changes.segments };
  const segments = changes.segments?.actionDigest === undefined ? { ...replaced, actionDigest: stepActionDigest(o.circuit, replaced) as Uint8Array } : replaced;
  const context = { ...o.context, ...changes.context };
  const { witnesses, statement } = stepOpening(o.circuit, segments, o.prevRollHex, context);
  return { ...o, segments, context, witnesses, statement: { ...statement, ...claim } };
}

export const withStepWitness = (o: StepOpening, name: string, value: StepWitness): StepOpening => ({ ...o, witnesses: { ...o.witnesses, [`${o.circuit}_${name}`]: value } });
export const withClaim = (o: StepOpening, claim: Readonly<Record<string, Uint8Array | bigint>>): StepOpening => ({ ...o, statement: { ...o.statement, ...claim } });

/** The witness names a contract asked for and those a run read, recorded by {@link stepWitnessFunctions}. */
export interface WitnessRecord { readonly requested: Set<string>; readonly read: string[] }

/**
 * The witnesses of one circuit run: a byte segment is a vector of bytes, and any other witness the struct or vector the
 * circuit declares. A witness outside the class, or a second read of one, fails the run.
 */
export function stepWitnessFunctions(witnesses: Readonly<Record<string, StepWitness>>, record?: WitnessRecord): object {
  const read = new Set<string>();
  const own = Object.fromEntries(Object.entries(witnesses).map(([name, value]) => [name, (context: { privateState: unknown }) => {
    if (read.has(name)) throw new Error(`witness ${name} read twice`);
    read.add(name);
    record?.read.push(name);
    return [context.privateState, value instanceof Uint8Array ? Array.from(value, BigInt) : value];
  }]));
  return new Proxy(own, {
    get: (target, name) => {
      if (typeof name === "string") record?.requested.add(name);
      return target[name as string] ?? (() => { throw new Error(`witness ${String(name)} is outside the opened class`); });
    },
  });
}

type Presented = Pick<StepOpening, "circuit" | "witnesses" | "statement">;

/** Runs a step through the generated JS of `unit` and returns the statement its ledger write disclosed. */
export async function runStep({ circuit, witnesses, statement }: Presented, unit = STEPS_UNIT, record?: WitnessRecord): Promise<unknown> {
  return (await runLedger(unit, circuit, stepWitnessFunctions(witnesses, record), [statement]))[STEP_CELL];
}

/** "accepted", or the message the generated JS of `unit` refused the step with. */
export const stepOutcome = (o: Presented, unit = STEPS_UNIT): Promise<string> => settle(runStep(o, unit));

/** Runs a step on the assert-stripped copy of `unit`, ready for its ZKIR `check`. */
export const prepareStep = ({ circuit, witnesses, statement }: Presented, unit = STEPS_UNIT, record?: WitnessRecord): Promise<PreparedCheck> =>
  prepareCheck(unit, circuit, stepWitnessFunctions(witnesses, record), [statement]);

/** Checks a step at ZKIR on the assert-stripped copy of `unit` and returns the statement its transcript wrote. */
export const checkStep = async (o: Presented, unit = STEPS_UNIT): Promise<unknown> => (await (await prepareStep(o, unit)).check())[STEP_CELL];

/** "accepted", or the message ZKIR `check` refused the step with. */
export const checkOutcome = (o: Presented, unit = STEPS_UNIT): Promise<string> => settle(checkStep(o, unit));

const moved = (bytes: Uint8Array, at: number, value: number) => Uint8Array.from(bytes, (b, i) => (i === at ? value : b));
const flippedByte = (bytes: Uint8Array, at: number) => moved(bytes, at, bytes[at]! ^ 1);

/** One changed witness of a step, labelled. */
export interface WitnessMutation { readonly label: string; readonly value: StepWitness }

/**
 * The mutation table of a step opening, keyed by witness name: every byte of a byte witness moved by one each way
 * without leaving a byte, every uint of a struct moved by one each way within uint64, every digest of a struct with a
 * bit flipped in its first and its last byte, and every flag of a path flipped. T-C05 holds its keys to the witnesses
 * the circuit reads.
 */
export function stepMutations(o: StepOpening): Map<string, WitnessMutation[]> {
  const table = new Map<string, WitnessMutation[]>();
  for (const [name, value] of Object.entries(o.witnesses)) {
    const out: WitnessMutation[] = [];
    if (value instanceof Uint8Array) {
      for (let at = 0; at < value.length; at++) {
        for (const delta of [1, -1]) {
          const byte = value[at]! + delta;
          if (byte >= 0 && byte <= 255) out.push({ label: `${name}[${at}]${delta > 0 ? "+1" : "-1"}`, value: moved(value, at, byte) });
        }
      }
    } else if (Array.isArray(value)) {
      const path = value as readonly PathStep[];
      const at = (i: number, step: PathStep) => path.map((s, j) => (j === i ? step : s));
      path.forEach((step, i) => {
        out.push({ label: `${name}[${i}].active flipped`, value: at(i, { ...step, active: !step.active }) });
        out.push({ label: `${name}[${i}].sibRight flipped`, value: at(i, { ...step, sibRight: !step.sibRight }) });
        for (const byte of [0, 31]) out.push({ label: `${name}[${i}].sib[${byte}] flipped`, value: at(i, { ...step, sib: flippedByte(step.sib, byte) }) });
      });
    } else {
      for (const [field, part] of Object.entries(value as MandateAtoms | WindowSplit)) {
        if (part instanceof Uint8Array) {
          for (const byte of [0, part.length - 1]) out.push({ label: `${name}.${field}[${byte}] flipped`, value: { ...value, [field]: flippedByte(part, byte) } as StepWitness });
        } else {
          for (const delta of [1n, -1n]) {
            const next = (part as bigint) + delta;
            if (next >= 0n && next < 1n << 64n) out.push({ label: `${name}.${field}${delta > 0n ? "+1" : "-1"}`, value: { ...value, [field]: next } as StepWitness });
          }
        }
      }
    }
    table.set(name, out);
  }
  return table;
}

/** The label of every mutation of the table that `unit` accepts. */
export async function acceptedMutations(o: StepOpening, table: ReadonlyMap<string, readonly WitnessMutation[]>, unit = STEPS_UNIT): Promise<string[]> {
  const accepted: string[] = [];
  for (const [name, mutations] of table) {
    for (const { label, value } of mutations) {
      if (await stepOutcome({ ...o, witnesses: { ...o.witnesses, [name]: value } }, unit) === "accepted") accepted.push(label);
    }
  }
  return accepted;
}
