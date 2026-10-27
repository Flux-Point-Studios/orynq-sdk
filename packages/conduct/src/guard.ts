import { buildAllowlistRoot } from "./allowlist.js";
import { equalBytes } from "./bytes.js";
import { mandateCommitmentHex } from "./commitment.js";
import { decodeMandate, encodeMandate } from "./codec.js";
import { EGRESS_ALLOWLIST, EGRESS_DENY_ALL, type MandateV1 } from "./types.js";
import { actionDigestHex, validateAction, type GuardAction, type PaymentAction } from "./actions.js";
import type { GuardEvent } from "./events.js";
import type { DenialReason, GuardDecision } from "./verdict.js";

export interface GuardConfig {
  readonly mandate: MandateV1;
  readonly counterpartyAllowlist: readonly string[];
  readonly egressAllowlist?: readonly string[];
  readonly onEvent?: (event: GuardEvent) => void;
}

export class GuardConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardConfigError";
  }
}

const deny = (reason: DenialReason, rule: string): GuardDecision => ({
  allowed: false,
  reason,
  rule,
});

export class MandateGuard {
  private readonly policy: MandateV1;
  readonly mandateCommitment: string;
  private readonly counterparties: ReadonlySet<string>;
  private readonly egressDestinations: ReadonlySet<string>;
  private readonly onEvent: ((event: GuardEvent) => void) | undefined;
  private readonly spentByWindow = new Map<bigint, bigint>();
  private seq = 0n;

  constructor(config: GuardConfig) {
    this.policy = decodeMandate(encodeMandate(config.mandate));
    this.mandateCommitment = mandateCommitmentHex(this.policy);
    this.onEvent = config.onEvent;

    const counterpartyRoot = buildAllowlistRoot(config.counterpartyAllowlist);
    if (!equalBytes(counterpartyRoot, config.mandate.counterpartyAllowlistRoot)) {
      throw new GuardConfigError(
        "counterparty allowlist does not hash to mandate.counterpartyAllowlistRoot",
      );
    }
    this.counterparties = new Set(config.counterpartyAllowlist);

    if (config.mandate.egressPolicy.mode === EGRESS_ALLOWLIST) {
      const egressList = config.egressAllowlist;
      if (egressList === undefined) {
        throw new GuardConfigError(
          "mandate egress mode is allowlist but no egressAllowlist was provided",
        );
      }
      const egressRoot = buildAllowlistRoot(egressList);
      if (!equalBytes(egressRoot, config.mandate.egressPolicy.allowlistRoot)) {
        throw new GuardConfigError(
          "egress allowlist does not hash to mandate.egressPolicy.allowlistRoot",
        );
      }
      this.egressDestinations = new Set(egressList);
    } else {
      if (config.egressAllowlist !== undefined) {
        throw new GuardConfigError(
          "mandate egress mode is deny-all; an egressAllowlist must not be provided",
        );
      }
      this.egressDestinations = new Set();
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
    validateAction(action);
    const { validityWindow } = this.policy;
    if (action.timestamp < validityWindow.notBefore) {
      return deny(
        "MANDATE_NOT_YET_VALID",
        `timestamp ${action.timestamp} < notBefore ${validityWindow.notBefore}`,
      );
    }
    if (action.timestamp >= validityWindow.notAfter) {
      return deny(
        "MANDATE_EXPIRED",
        `timestamp ${action.timestamp} >= notAfter ${validityWindow.notAfter}`,
      );
    }
    if (action.kind === "payment") return this.evaluatePayment(action);
    return this.evaluateEgress(action);
  }

  private evaluatePayment(action: PaymentAction): GuardDecision {
    const cap = this.policy.spendCap;
    if (action.asset !== cap.asset) {
      return deny(
        "ASSET_MISMATCH",
        `asset "${action.asset}" is not the mandated asset "${cap.asset}"`,
      );
    }
    if (!this.counterparties.has(action.counterparty)) {
      return deny(
        "COUNTERPARTY_NOT_ALLOWED",
        `counterparty "${action.counterparty}" is not in the mandate allowlist`,
      );
    }
    const spent = this.spentInWindow(action.timestamp);
    if (spent + action.amount > cap.amount) {
      return deny(
        "SPEND_CAP_EXCEEDED",
        `window spend ${spent} + ${action.amount} exceeds cap ${cap.amount}`,
      );
    }
    return { allowed: true };
  }

  private evaluateEgress(action: { destination: string }): GuardDecision {
    if (this.policy.egressPolicy.mode === EGRESS_DENY_ALL) {
      return deny("EGRESS_DENIED", "mandate egress policy is deny-all");
    }
    if (!this.egressDestinations.has(action.destination)) {
      return deny(
        "EGRESS_NOT_ALLOWED",
        `destination "${action.destination}" is not in the egress allowlist`,
      );
    }
    return { allowed: true };
  }

  enforce(action: GuardAction): GuardDecision {
    action = { ...action };
    const decision = this.evaluate(action);
    const digest = actionDigestHex(action);
    if (decision.allowed && action.kind === "payment") {
      const w = this.windowIndex(action.timestamp);
      this.spentByWindow.set(w, (this.spentByWindow.get(w) ?? 0n) + action.amount);
    }
    const base = {
      seq: this.seq++,
      timestamp: action.timestamp,
      mandateCommitment: this.mandateCommitment,
      actionDigest: digest,
      actionKind: action.kind,
      action,
    };
    const event: GuardEvent = decision.allowed
      ? { type: "orynq.conduct.guard.action.v1", ...base }
      : {
          type: "orynq.conduct.guard.denial.v1",
          ...base,
          reason: decision.reason,
          rule: decision.rule,
        };
    this.onEvent?.(event);
    return decision;
  }
}
