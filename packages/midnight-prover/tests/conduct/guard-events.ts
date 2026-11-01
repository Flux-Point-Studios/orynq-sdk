import { addSpan, createTrace, type TraceEvent, type TraceRun, type Visibility } from "@fluxpointstudios/orynq-sdk-process-trace";
import {
  actionDigestHex,
  buildAllowlistRoot,
  MandateGuard,
  mandateCommitmentHex,
  MemoryGuardLog,
  processTraceSink,
  verdictOf,
  type GuardAction,
  type GuardDecision,
  type GuardEvent,
  type MandateV1,
  type PaymentAction,
} from "@fluxpointstudios/orynq-sdk-conduct";

export const KINDS = [
  "payment-action", "payment-denial-1", "payment-denial-2", "payment-denial-3", "payment-denial-4", "payment-denial-5",
  "egress-action", "egress-denial-1", "egress-denial-2", "egress-denial-6", "egress-denial-7",
] as const;
export type Kind = (typeof KINDS)[number];

export const SHAPES = ["ascii-min", "unicode-max", "max-in-class"] as const;
export type Shape = (typeof SHAPES)[number];

export interface RealEvent {
  readonly kind: Kind;
  readonly shape: Shape;
  readonly guardEvent: GuardEvent;
  readonly event: TraceEvent;
  readonly rollBefore: string;
  readonly rollAfter: string;
}

export interface Profile {
  readonly visibility: Visibility;
  readonly asset: string;
  readonly otherAsset: string;
  readonly counterparty: string;
  readonly stranger: string;
  readonly destination: string;
  readonly outsider: string;
  readonly amount: bigint;
  readonly windowSeconds: bigint;
  readonly notBefore: bigint;
  readonly notAfter: bigint;
  readonly at: bigint;
  readonly early: bigint;
  readonly late: bigint;
  readonly clockLag: bigint;
  readonly loggedBefore: number;
  readonly traceSeq: number;
}

const MAX_U64 = (1n << 64n) - 1n;
// Printable ASCII without the two characters JSON escapes, so a 128-character mandate asset stays escape-free.
const PRINTABLE = Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i)).filter(c => c !== '"' && c !== "\\").join("");

export const PROFILES: Readonly<Record<Shape, Profile>> = {
  "ascii-min": {
    visibility: "private", asset: "USD", otherAsset: "EUR", counterparty: "acme", stranger: "zzzz", destination: "api1", outsider: "evil",
    amount: 5n, windowSeconds: 3600n, notBefore: 2n, notAfter: 8n, at: 3n, early: 1n, late: 8n, clockLag: 0n, loggedBefore: 0, traceSeq: 0,
  },
  "unicode-max": {
    visibility: "public", asset: "ADAEUR", otherAsset: "€uro", counterparty: "商户-🚀", stranger: "🚀-商户", destination: "端点-🚀", outsider: "坏人-🚀",
    amount: MAX_U64, windowSeconds: 3600n, notBefore: 1_767_225_000n, notAfter: 1_767_229_999n, at: 1_767_225_600n, early: 1_767_224_999n,
    late: 1_767_229_999n, clockLag: 1n, loggedBefore: 10, traceSeq: 0,
  },
  "max-in-class": {
    visibility: "private", asset: PRINTABLE.repeat(2).slice(0, 128), otherAsset: `${"€".repeat(42)}ab`, counterparty: "🚀".repeat(64),
    stranger: "🛸".repeat(64), destination: `${"🚀".repeat(63)}abcd`, outsider: "🛸".repeat(64), amount: MAX_U64, windowSeconds: MAX_U64,
    notBefore: 10n ** 19n + 1n, notAfter: MAX_U64 - 1n, at: MAX_U64 - 2n, early: 10n ** 19n, late: MAX_U64 - 1n, clockLag: 0n,
    loggedBefore: 0, traceSeq: Number.MAX_SAFE_INTEGER,
  },
};

export function mandateFor(p: Profile, egressMode: 0n | 1n): MandateV1 {
  return {
    schemaVersion: 1n,
    mandateId: new Uint8Array(16).fill(0x5a),
    principalDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    agentDid: "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG",
    didFormatVersion: 0n,
    spendCap: { asset: p.asset, amount: p.amount, windowSeconds: p.windowSeconds },
    counterpartyAllowlistRoot: buildAllowlistRoot([p.counterparty]),
    egressPolicy: { mode: egressMode, allowlistRoot: egressMode === 1n ? buildAllowlistRoot([p.destination]) : new Uint8Array(32) },
    approvedMeasurementSetRoot: new Uint8Array(32).fill(0x44),
    validityWindow: { notBefore: p.notBefore, notAfter: p.notAfter },
    disclosurePolicy: { committeeId: "orynq-conduct-test-1", threshold: 3n, committeeSize: 5n },
  };
}

export interface Scene {
  readonly egressMode: 0n | 1n;
  readonly before: readonly GuardAction[];
  readonly action: GuardAction;
  readonly traceSeq?: number;
}

export interface Traced {
  readonly decision: GuardDecision;
  readonly guardEvent: GuardEvent;
  readonly event: TraceEvent;
  readonly rollBefore: string;
  readonly rollAfter: string;
}

function scenario(kind: Kind, p: Profile): Scene {
  const pay = (timestamp: bigint, asset = p.asset, counterparty = p.counterparty): GuardAction => ({ kind: "payment", asset, amount: p.amount, counterparty, timestamp });
  const out = (timestamp: bigint, destination = p.destination): GuardAction => ({ kind: "egress", destination, timestamp });
  switch (kind) {
    case "payment-action": return { egressMode: 1n, before: [], action: pay(p.at) };
    case "payment-denial-1": return { egressMode: 1n, before: [], action: pay(p.early) };
    case "payment-denial-2": return { egressMode: 1n, before: [], action: pay(p.late) };
    case "payment-denial-3": return { egressMode: 1n, before: [], action: pay(p.at, p.otherAsset) };
    case "payment-denial-4": return { egressMode: 1n, before: [pay(p.at)], action: pay(p.at) };
    case "payment-denial-5": return { egressMode: 1n, before: [], action: pay(p.at, p.asset, p.stranger) };
    case "egress-action": return { egressMode: 1n, before: [], action: out(p.at) };
    case "egress-denial-1": return { egressMode: 1n, before: [], action: out(p.early) };
    case "egress-denial-2": return { egressMode: 1n, before: [], action: out(p.late) };
    case "egress-denial-6": return { egressMode: 0n, before: [], action: out(p.at) };
    case "egress-denial-7": return { egressMode: 1n, before: [], action: out(p.at, p.outsider) };
  }
}

export const kindOf = (action: GuardAction, decision: GuardDecision): string =>
  decision.allowed ? `${action.kind}-action` : `${action.kind}-denial-${verdictOf(decision.reason)}`;

async function traceRun(nextSeq: number): Promise<{ run: TraceRun; spanId: string }> {
  const run = await createTrace({ agentId: "conduct-openings" });
  run.nextSeq = nextSeq;
  return { run, spanId: addSpan(run, { name: "guard" }).id };
}

// One guard over every step. The first `untraced` steps are traced into a separate run, so the traced events' guard log
// positions and trace sequence follow from the profile; each step runs under a clock at its action time plus the lag.
export async function traceSteps(shape: Shape, egressMode: 0n | 1n, steps: readonly GuardAction[], untraced = 0, traceSeq?: number): Promise<Traced[]> {
  const p = PROFILES[shape];
  const log = new MemoryGuardLog();
  const earlier = await traceRun(0);
  const target = await traceRun(traceSeq ?? p.traceSeq);
  let current = earlier;
  let clock = 0n;
  let traced: Omit<Traced, "decision"> | undefined;
  const guard = new MandateGuard({
    mandate: mandateFor(p, egressMode),
    counterpartyAllowlist: [p.counterparty],
    ...(egressMode === 1n ? { egressAllowlist: [p.destination] } : {}),
    history: "fresh",
    now: () => clock,
    onEvent: async (guardEvent, previous) => {
      const head = log.append(guardEvent, previous);
      const rollBefore = current.run.rollingHash;
      const event = await processTraceSink(current.run, current.spanId, p.visibility)(guardEvent);
      traced = { guardEvent, event, rollBefore, rollAfter: current.run.rollingHash };
      return head;
    },
  });
  const out: Traced[] = [];
  for (const [i, step] of steps.entries()) {
    current = i < untraced ? earlier : target;
    clock = step.timestamp + p.clockLag;
    const decision = await guard.enforceAsync(step);
    if (i >= untraced) out.push({ decision, ...traced! });
  }
  return out;
}

// Earlier steps are logged but traced into a separate run, so the traced event's guard log position and trace sequence
// are the profile's.
export async function traceScene(shape: Shape, { egressMode, before, action, traceSeq }: Scene): Promise<Traced> {
  const p = PROFILES[shape];
  const filler: GuardAction = { kind: "egress", destination: p.destination, timestamp: action.timestamp };
  const earlier = [...Array<GuardAction>(p.loggedBefore).fill(filler), ...before];
  const [traced] = await traceSteps(shape, egressMode, [...earlier, action], earlier.length, traceSeq);
  return traced!;
}

export async function realEvent(kind: Kind, shape: Shape): Promise<RealEvent> {
  const scene = scenario(kind, PROFILES[shape]);
  const { decision, ...traced } = await traceScene(shape, scene);
  if (kindOf(scene.action, decision) !== kind) throw new Error(`the ${shape} scenario for ${kind} produced ${kindOf(scene.action, decision)}`);
  return { kind, shape, ...traced };
}

export async function realEvents(): Promise<RealEvent[]> {
  const events: RealEvent[] = [];
  for (const shape of SHAPES) for (const kind of KINDS) events.push(await realEvent(kind, shape));
  return events;
}

// No guard log reaches a 20-digit position, so the event of the largest class is built by hand. The trace sink still
// validates it with the producer's own snapshot before process-trace hashes it.
export async function maxClassEvent(): Promise<RealEvent> {
  const p = PROFILES["max-in-class"];
  const action: PaymentAction = { kind: "payment", asset: p.asset, amount: p.amount, counterparty: p.counterparty, timestamp: p.at };
  const guardEvent: GuardEvent = {
    type: "orynq.conduct.guard.action.v1", seq: 10n ** 19n + 7n, timestamp: p.at, enforcedAt: p.at,
    mandateCommitment: mandateCommitmentHex(mandateFor(p, 1n)), actionDigest: actionDigestHex(action), actionKind: "payment", action,
  };
  const { run, spanId } = await traceRun(p.traceSeq);
  const rollBefore = run.rollingHash;
  const event = await processTraceSink(run, spanId, p.visibility)(guardEvent);
  return { kind: "payment-action", shape: "max-in-class", guardEvent, event, rollBefore, rollAfter: run.rollingHash };
}
