import { canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";
import { buildAllowlistRoot } from "./allowlist.js";
import { equalBytes } from "./bytes.js";
import { mandateCommitmentHex } from "./commitment.js";
import { decodeMandate, encodeMandate } from "./codec.js";
import { EGRESS_ALLOWLIST, EGRESS_DENY_ALL, type MandateV1 } from "./types.js";
import { actionDigestHex, validateAction, type GuardAction, type PaymentAction } from "./actions.js";
import { guardEventData, snapshotGuardEvent, type GuardEvent } from "./events.js";
import { DENIAL_RULES, type DenialReason, type GuardDecision } from "./verdict.js";

export interface GuardConfig {
  readonly mandate: MandateV1;
  readonly counterpartyAllowlist: readonly string[];
  readonly egressAllowlist?: readonly string[];
  readonly onEvent?: (event: GuardEvent) => unknown;
  readonly now?: () => bigint;
  readonly recordedEvents?: readonly GuardEvent[];
}

export class GuardConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardConfigError";
  }
}

const deny = (reason: DenialReason): GuardDecision => ({ allowed: false, reason, rule: DENIAL_RULES[reason] });

export class MandateGuard {
  private readonly policy: MandateV1;
  readonly mandateCommitment: string;
  private readonly counterparties: ReadonlySet<string>;
  private readonly egressDestinations: ReadonlySet<string>;
  private readonly onEvent: GuardConfig["onEvent"];
  private readonly now: () => bigint;
  private readonly spentByWindow = new Map<bigint, bigint>();
  private seq = 0n;
  private lastTimestamp = 0n;
  private lastEnforcedAt = 0n;
  private pending = false;
  private sinkError: Error | undefined;

  constructor(config: GuardConfig) {
    const { mandate, counterpartyAllowlist, egressAllowlist, onEvent, now, recordedEvents } = config;
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
    for (const source of Array.from(recordedEvents ?? [])) {
      try {
        const event = snapshotGuardEvent(source);
        const { event: expected, decision } = this.prepare(event.action, event.enforcedAt);
        if (canonicalize(guardEventData(event)) !== canonicalize(guardEventData(expected))) {
          throw new Error("event does not match replayed decision");
        }
        this.reserve(event, decision);
      } catch (cause) {
        throw new GuardConfigError(`invalid recorded guard event: ${cause instanceof Error ? cause.message : "validation failed"}`);
      }
    }
  }

  get mandate(): MandateV1 {
    return decodeMandate(encodeMandate(this.policy));
  }

  spentInWindow(timestamp: bigint): bigint {
    return this.spentByWindow.get(this.windowIndex(timestamp)) ?? 0n;
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

  private prepare(action: GuardAction, enforcedAt: bigint): { event: GuardEvent; decision: GuardDecision } {
    action = { ...action };
    validateAction(action);
    if (typeof enforcedAt !== "bigint" || enforcedAt < this.lastEnforcedAt || enforcedAt >= 1n << 64n) {
      throw new Error("guard clock must be a monotonic uint64 Unix timestamp");
    }
    if (this.windowIndex(action.timestamp) !== this.windowIndex(enforcedAt) || action.timestamp < this.lastTimestamp) {
      throw new Error("action timestamp must be in the current window and must not move backward");
    }
    const decision = enforcedAt < this.policy.validityWindow.notBefore ? deny("MANDATE_NOT_YET_VALID")
      : enforcedAt >= this.policy.validityWindow.notAfter ? deny("MANDATE_EXPIRED") : this.evaluate(action);
    const base = {
      seq: this.seq,
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
    canonicalize(guardEventData(event));
    return { event, decision };
  }

  private reserve(event: GuardEvent, decision: GuardDecision): void {
    const action = event.action;
    if (decision.allowed && action.kind === "payment") {
      const w = this.windowIndex(action.timestamp);
      this.spentByWindow.set(w, (this.spentByWindow.get(w) ?? 0n) + action.amount);
    }
    this.seq++;
    this.lastTimestamp = event.timestamp;
    this.lastEnforcedAt = event.enforcedAt;
  }

  private checkSink(): void {
    if (this.sinkError) throw new Error("event sink failed; restore a new guard from durable events", { cause: this.sinkError });
    if (this.pending) throw new Error("an async enforcement is pending");
  }

  enforce(action: GuardAction): GuardDecision {
    this.checkSink();
    const { event, decision } = this.prepare(action, this.now());
    this.reserve(event, decision);
    try {
      const result = this.onEvent?.(event);
      if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") {
        // Observe the rejected sink while the synchronous caller receives a hard failure.
        void Promise.resolve(result).catch(cause => { this.sinkError = new Error("async event sink failed", { cause }); });
        throw new Error("promise-returning event sink requires enforceAsync");
      }
    } catch (cause) {
      this.sinkError = new Error("event sink failed", { cause });
      throw cause;
    }
    return decision;
  }

  async enforceAsync(action: GuardAction): Promise<GuardDecision> {
    this.checkSink();
    if (!this.onEvent) throw new Error("enforceAsync requires an event sink");
    const { event, decision } = this.prepare(action, this.now());
    this.reserve(event, decision);
    this.pending = true;
    try {
      await this.onEvent(event);
      return decision;
    } catch (cause) {
      this.sinkError = new Error("event sink failed", { cause });
      throw cause;
    } finally {
      this.pending = false;
    }
  }
}
