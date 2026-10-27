import type { GuardAction } from "./actions.js";
import type { DenialReason } from "./verdict.js";
import type { CustomEvent } from "@fluxpointstudios/orynq-sdk-process-trace";

export const GUARD_EVENT_CUSTOM_KIND = "orynq.conduct.guard.v1";

interface GuardEventBase {
  readonly seq: bigint;
  readonly timestamp: bigint;
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

// Trace metadata belongs to the containing run; action time and guard sequence stay exact in data.
export function toProcessTraceEvent(
  event: GuardEvent,
  context: Pick<CustomEvent, "id" | "seq" | "timestamp" | "visibility">,
): CustomEvent {
  const action = event.action.kind === "payment"
    ? { ...event.action, amount: event.action.amount.toString(), timestamp: event.action.timestamp.toString() }
    : { ...event.action, timestamp: event.action.timestamp.toString() };
  return {
    id: context.id,
    seq: context.seq,
    timestamp: context.timestamp,
    visibility: context.visibility,
    kind: "custom",
    eventType: GUARD_EVENT_CUSTOM_KIND,
    data: { ...event, seq: event.seq.toString(), timestamp: event.timestamp.toString(), action },
  };
}
