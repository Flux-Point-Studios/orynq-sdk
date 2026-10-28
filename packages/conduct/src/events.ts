import { actionDigestHex, validateAction, type GuardAction } from "./actions.js";
import { DENIAL_RULES, type DenialReason } from "./verdict.js";
import { addEvent, type CustomEvent, type TraceEvent, type TraceRun, type Visibility } from "@fluxpointstudios/orynq-sdk-process-trace";

export const GUARD_EVENT_CUSTOM_KIND = "orynq.conduct.guard.v1";

interface GuardEventBase {
  readonly seq: bigint;
  readonly timestamp: bigint;
  readonly enforcedAt: bigint;
  readonly mandateCommitment: string;
  readonly actionDigest: string;
  readonly actionKind: GuardAction["kind"];
}

export interface GuardActionEvent extends GuardEventBase {
  readonly type: "orynq.conduct.guard.action.v1";
  readonly action: GuardAction;
}

export interface GuardDenialEvent extends GuardEventBase {
  readonly type: "orynq.conduct.guard.denial.v1";
  readonly action: GuardAction;
  readonly reason: DenialReason;
  readonly rule: string;
}

export type GuardEvent = GuardActionEvent | GuardDenialEvent;

export function snapshotGuardEvent(source: GuardEvent): GuardEvent {
  const { action, ...fields } = source;
  const event = { ...fields, action: { ...action } };
  validateAction(event.action);
  if ([event.seq, event.timestamp, event.enforcedAt].some(value => typeof value !== "bigint" || value < 0n || value >= 1n << 64n)
    || event.timestamp !== event.action.timestamp || event.actionKind !== event.action.kind
    || typeof event.mandateCommitment !== "string" || !/^[0-9a-f]{64}$/.test(event.mandateCommitment)
    || event.actionDigest !== actionDigestHex(event.action)) {
    throw new Error("invalid guard event fields or action digest");
  }
  if (event.type !== "orynq.conduct.guard.action.v1" && event.type !== "orynq.conduct.guard.denial.v1") {
    throw new Error("invalid guard event type");
  }
  if (event.type === "orynq.conduct.guard.denial.v1"
    && (typeof event.reason !== "string" || !Object.hasOwn(DENIAL_RULES, event.reason) || event.rule !== DENIAL_RULES[event.reason])) {
    throw new Error("invalid guard denial reason or rule");
  }
  const keys = ["type", "seq", "timestamp", "enforcedAt", "mandateCommitment", "actionDigest", "actionKind", "action"];
  if (event.type === "orynq.conduct.guard.denial.v1") keys.push("reason", "rule");
  if (Reflect.ownKeys(event).some(key => typeof key !== "string" || !keys.includes(key))) throw new Error("unknown guard event field");
  Object.freeze(event.action);
  return Object.freeze(event);
}

export function guardEventData(source: GuardEvent): CustomEvent["data"] {
  const event = snapshotGuardEvent(source);
  const action = event.action.kind === "payment"
    ? { ...event.action, amount: event.action.amount.toString(), timestamp: event.action.timestamp.toString() }
    : { ...event.action, timestamp: event.action.timestamp.toString() };
  return { ...event, seq: event.seq.toString(), timestamp: event.timestamp.toString(), enforcedAt: event.enforcedAt.toString(), action };
}

function customEventFields(event: GuardEvent, visibility: Visibility) {
  return { kind: "custom" as const, eventType: GUARD_EVENT_CUSTOM_KIND, visibility, data: guardEventData(event) };
}

// Trace metadata belongs to the containing run; guard times and sequence stay exact in data.
export function toProcessTraceEvent(
  event: GuardEvent,
  context: Pick<CustomEvent, "id" | "seq" | "timestamp" | "visibility">,
): CustomEvent {
  return { id: context.id, seq: context.seq, timestamp: context.timestamp, ...customEventFields(event, context.visibility) };
}

// The returned promise settles when the trace holds the event; use the sink with enforceAsync.
export function processTraceSink(run: TraceRun, spanId: string, visibility: Visibility = "private"): (event: GuardEvent) => Promise<TraceEvent> {
  return event => addEvent(run, spanId, customEventFields(event, visibility));
}
