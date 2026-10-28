import { canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";
import { buildAllowlistRoot } from "./allowlist.js";
import { equalBytes } from "./bytes.js";
import { mandateCommitmentHex } from "./commitment.js";
import { decodeMandate, encodeMandate } from "./codec.js";
import { EGRESS_ALLOWLIST, EGRESS_DENY_ALL, type MandateV1 } from "./types.js";
import { actionDigestHex, validateAction, type GuardAction, type PaymentAction } from "./actions.js";
import { guardEventData, snapshotGuardEvent, type GuardEvent } from "./events.js";
import { formatGuardLogHead, GUARD_LOG_GENESIS, nextGuardLogHead, readGuardLogHead, sameGuardLogHead, type GuardHistory, type GuardLogHead } from "./log.js";
import { DENIAL_RULES, type DenialReason, type GuardDecision } from "./verdict.js";

/** Appends `event` only if the log's head is still `previous` (count and hash), and returns the head after the append. */
export type GuardEventSink = (event: GuardEvent, previous: GuardLogHead) => GuardLogHead | PromiseLike<GuardLogHead>;

export interface GuardConfig {
  readonly mandate: MandateV1;
  readonly counterpartyAllowlist: readonly string[];
  readonly egressAllowlist?: readonly string[];
  /** `"fresh"` only for an empty event log; otherwise the complete ordered events and the head the log reports. */
  readonly history: "fresh" | GuardHistory;
  readonly onEvent?: GuardEventSink;
  readonly now?: () => bigint;
}

export class GuardConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GuardConfigError";
  }
}

interface Prepared {
  readonly event: GuardEvent;
  readonly decision: GuardDecision;
  readonly previous: GuardLogHead;
  readonly head: GuardLogHead;
}

const deny = (reason: DenialReason): GuardDecision => ({ allowed: false, reason, rule: DENIAL_RULES[reason] });

// Catches a sink that reports its real state after a skipped, misplaced or stale append. It cannot prove the append
// happened: a sink can compute this head with nextGuardLogHead without writing, so the host's log is trusted for that.
function confirmHead(returned: unknown, expected: GuardLogHead): void {
  let head: GuardLogHead;
  try {
    head = readGuardLogHead(returned as GuardLogHead);
  } catch (cause) {
    throw new Error("event sink must return the log head after the append", { cause });
  }
  if (!sameGuardLogHead(head, expected)) {
    throw new Error(`event sink returned log head ${formatGuardLogHead(head)}, expected ${formatGuardLogHead(expected)}`);
  }
}

function readHistory(history: unknown): { events: GuardEvent[]; head: GuardLogHead } {
  if (history === "fresh") return { events: [], head: GUARD_LOG_GENESIS };
  const message = 'history must be "fresh" or { events, head } from the guard event log';
  if (typeof history !== "object" || history === null) throw new GuardConfigError(message);
  const { events, head } = history as GuardHistory;
  if (!Array.isArray(events)) throw new GuardConfigError(message);
  try {
    return { events: Array.from(events), head: readGuardLogHead(head) };
  } catch (cause) {
    throw new GuardConfigError(message, { cause });
  }
}

export class MandateGuard {
  private readonly policy: MandateV1;
  readonly mandateCommitment: string;
  private readonly counterparties: ReadonlySet<string>;
  private readonly egressDestinations: ReadonlySet<string>;
  private readonly onEvent: GuardConfig["onEvent"];
  private readonly now: () => bigint;
  private logHead: GuardLogHead = GUARD_LOG_GENESIS;
  // What `head` reports: the reserved logHead runs ahead of it until the sink confirms the append, so a sink cannot
  // read the head it is meant to produce.
  private confirmedHead: GuardLogHead = GUARD_LOG_GENESIS;
  private spendWindow = 0n;
  private windowSpent = 0n;
  private lastTimestamp = 0n;
  private lastEnforcedAt = 0n;
  private pending = false;
  private sinkError: Error | undefined;

  constructor(config: GuardConfig) {
    const { mandate, counterpartyAllowlist, egressAllowlist, onEvent, now, history } = config;
    this.policy = decodeMandate(encodeMandate(mandate));
    this.mandateCommitment = mandateCommitmentHex(this.policy);
    this.onEvent = onEvent;
    this.now = now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
    const counterparties = Array.from(counterpartyAllowlist);
    const egressList = egressAllowlist === undefined ? undefined : Array.from(egressAllowlist);
    if (!equalBytes(buildAllowlistRoot(counterparties), this.policy.counterpartyAllowlistRoot)) {
      throw new GuardConfigError("counterparty allowlist does not hash to mandate.counterpartyAllowlistRoot");
    }
    this.counterparties = new Set(counterparties);
    if (this.policy.egressPolicy.mode === EGRESS_ALLOWLIST) {
      if (egressList === undefined) {
        throw new GuardConfigError("mandate egress mode is allowlist but no egressAllowlist was provided");
      }
      if (!equalBytes(buildAllowlistRoot(egressList), this.policy.egressPolicy.allowlistRoot)) {
        throw new GuardConfigError("egress allowlist does not hash to mandate.egressPolicy.allowlistRoot");
      }
      this.egressDestinations = new Set(egressList);
    } else {
      if (egressList !== undefined) {
        throw new GuardConfigError("mandate egress mode is deny-all; an egressAllowlist must not be provided");
      }
      this.egressDestinations = new Set();
    }
    const recorded = readHistory(history);
    for (const source of recorded.events) {
      try {
        const event = snapshotGuardEvent(source);
        const prepared = this.prepare(event.action, event.enforcedAt);
        if (canonicalize(guardEventData(event)) !== canonicalize(guardEventData(prepared.event))) {
          throw new Error("event does not match replayed decision");
        }
        this.reserve(prepared);
      } catch (cause) {
        throw new GuardConfigError(`invalid recorded guard event: ${cause instanceof Error ? cause.message : "validation failed"}`, { cause });
      }
    }
    if (!sameGuardLogHead(this.logHead, recorded.head)) {
      throw new GuardConfigError("recorded guard events do not end at the expected log head");
    }
    this.confirmedHead = this.logHead;
  }

  get mandate(): MandateV1 {
    return decodeMandate(encodeMandate(this.policy));
  }

  get head(): GuardLogHead {
    return this.confirmedHead;
  }

  // Only the latest window holding an allowed payment is kept; enforcement never charges an earlier window.
  spentInWindow(timestamp: bigint): bigint {
    return this.windowIndex(timestamp) === this.spendWindow ? this.windowSpent : 0n;
  }

  private windowIndex(timestamp: bigint): bigint {
    return timestamp / this.policy.spendCap.windowSeconds;
  }

  evaluate(action: GuardAction): GuardDecision {
    action = { ...action };
    validateAction(action);
    const { validityWindow } = this.policy;
    if (action.timestamp < validityWindow.notBefore) return deny("MANDATE_NOT_YET_VALID");
    if (action.timestamp >= validityWindow.notAfter) return deny("MANDATE_EXPIRED");
    if (action.kind === "payment") return this.evaluatePayment(action);
    return this.evaluateEgress(action);
  }

  private evaluatePayment(action: PaymentAction): GuardDecision {
    const cap = this.policy.spendCap;
    if (action.asset !== cap.asset) {
      return deny("ASSET_MISMATCH");
    }
    if (!this.counterparties.has(action.counterparty)) {
      return deny("COUNTERPARTY_NOT_ALLOWED");
    }
    const spent = this.spentInWindow(action.timestamp);
    if (spent + action.amount > cap.amount) {
      return deny("SPEND_CAP_EXCEEDED");
    }
    return { allowed: true };
  }

  private evaluateEgress(action: { destination: string }): GuardDecision {
    if (this.policy.egressPolicy.mode === EGRESS_DENY_ALL) {
      return deny("EGRESS_DENIED");
    }
    if (!this.egressDestinations.has(action.destination)) {
      return deny("EGRESS_NOT_ALLOWED");
    }
    return { allowed: true };
  }

  // Action time never exceeds the guard clock, so the action-time check in evaluate also covers clock < notBefore.
  private prepare(action: GuardAction, enforcedAt: bigint): Prepared {
    action = { ...action };
    validateAction(action);
    if (typeof enforcedAt !== "bigint" || enforcedAt < this.lastEnforcedAt || enforcedAt >= 1n << 64n) {
      throw new Error("guard clock must be a monotonic uint64 Unix timestamp");
    }
    if (this.windowIndex(action.timestamp) !== this.windowIndex(enforcedAt)) {
      throw new Error("action timestamp must be in the guard clock's current window");
    }
    if (action.timestamp > enforcedAt) throw new Error("action timestamp must not be later than the guard clock");
    if (action.timestamp < this.lastTimestamp) throw new Error("action timestamp must not move backward");
    const decision = enforcedAt >= this.policy.validityWindow.notAfter ? deny("MANDATE_EXPIRED") : this.evaluate(action);
    const base = {
      seq: this.logHead.count,
      timestamp: action.timestamp,
      enforcedAt,
      mandateCommitment: this.mandateCommitment,
      actionDigest: actionDigestHex(action),
      actionKind: action.kind,
      action: Object.freeze(action),
    };
    const event: GuardEvent = Object.freeze(decision.allowed
      ? { type: "orynq.conduct.guard.action.v1", ...base }
      : {
          type: "orynq.conduct.guard.denial.v1",
          ...base,
          reason: decision.reason,
          rule: decision.rule,
        });
    return { event, decision, previous: this.logHead, head: nextGuardLogHead(this.logHead, event) };
  }

  private reserve({ event, decision, head }: Prepared): void {
    const action = event.action;
    if (decision.allowed && action.kind === "payment") {
      const window = this.windowIndex(action.timestamp);
      if (window !== this.spendWindow) {
        this.spendWindow = window;
        this.windowSpent = 0n;
      }
      this.windowSpent += action.amount;
    }
    this.logHead = head;
    this.lastTimestamp = event.timestamp;
    this.lastEnforcedAt = event.enforcedAt;
  }

  // A nested enforce inside a sink confirms a later head first, so an earlier confirmation must not move it back.
  private complete(head: GuardLogHead): void {
    if (head.count > this.confirmedHead.count) this.confirmedHead = head;
  }

  private checkSink(): void {
    if (this.sinkError) throw new Error("event sink failed; restore a new guard from durable events", { cause: this.sinkError });
    if (this.pending) throw new Error("an async enforcement is pending");
  }

  enforce(action: GuardAction): GuardDecision {
    this.checkSink();
    const sink = this.onEvent;
    const prepared = this.prepare(action, this.now());
    if (prepared.event.actionKind === "payment" && !sink) throw new Error("payment enforcement requires an event sink");
    this.reserve(prepared);
    if (!sink) {
      this.complete(prepared.head);
      return prepared.decision;
    }
    try {
      const result: unknown = sink(prepared.event, prepared.previous);
      if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") {
        // Observe the rejected sink while the synchronous caller receives a hard failure.
        void Promise.resolve(result).catch(cause => { this.sinkError = new Error("async event sink failed", { cause }); });
        throw new Error("promise-returning event sink requires enforceAsync");
      }
      confirmHead(result, prepared.head);
    } catch (cause) {
      this.sinkError = new Error("event sink failed", { cause });
      throw cause;
    }
    this.complete(prepared.head);
    return prepared.decision;
  }

  async enforceAsync(action: GuardAction): Promise<GuardDecision> {
    this.checkSink();
    const sink = this.onEvent;
    if (!sink) throw new Error("enforceAsync requires an event sink");
    const prepared = this.prepare(action, this.now());
    this.reserve(prepared);
    this.pending = true;
    try {
      confirmHead(await sink(prepared.event, prepared.previous), prepared.head);
      this.complete(prepared.head);
      return prepared.decision;
    } catch (cause) {
      this.sinkError = new Error("event sink failed", { cause });
      throw cause;
    } finally {
      this.pending = false;
    }
  }
}
