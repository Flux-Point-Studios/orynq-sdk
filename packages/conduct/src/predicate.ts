import { createHash } from "node:crypto";
import { buildAllowlistRoot } from "./allowlist.js";
import { equalBytes } from "./bytes.js";
import { decodeMandate, encodeMandate } from "./codec.js";
import { MandateError } from "./errors.js";
import { EGRESS_ALLOWLIST, type MandateV1 } from "./types.js";
import { validateAction, type GuardAction } from "./actions.js";

export const VERDICT = {
  ALLOW: 0,
  MANDATE_NOT_YET_VALID: 1,
  MANDATE_EXPIRED: 2,
  ASSET_MISMATCH: 3,
  SPEND_CAP_EXCEEDED: 4,
  COUNTERPARTY_NOT_ALLOWED: 5,
  EGRESS_DENIED: 6,
  EGRESS_NOT_ALLOWED: 7,
} as const;

export type VerdictName = keyof typeof VERDICT;
export type VerdictCode = (typeof VERDICT)[VerdictName];

export const VERDICT_NAME: readonly VerdictName[] = [
  "ALLOW",
  "MANDATE_NOT_YET_VALID",
  "MANDATE_EXPIRED",
  "ASSET_MISMATCH",
  "SPEND_CAP_EXCEEDED",
  "COUNTERPARTY_NOT_ALLOWED",
  "EGRESS_DENIED",
  "EGRESS_NOT_ALLOWED",
];

export function verdictOf(name: string): VerdictCode {
  const code = VERDICT_NAME.indexOf(name as VerdictName);
  if (code < 0) throw new MandateError("SCHEMA_BAD_TYPE", `unknown verdict name "${name}"`);
  return code as VerdictCode;
}

export function assetTag(asset: string): bigint {
  const h = createHash("sha256").update(new TextEncoder().encode(asset)).digest();
  let tag = 0n;
  for (let i = 1; i < 32; i++) tag = (tag << 8n) | BigInt(h[i] as number);
  return tag;
}

export interface PredicateInput {
  readonly name: string;
  readonly type: "uint64" | "uint8" | "field" | "boolean";
  readonly source: "mandate" | "action" | "witness";
}

export const PREDICATE_LAYOUT: readonly PredicateInput[] = [
  { name: "not_before", type: "uint64", source: "mandate" },
  { name: "not_after", type: "uint64", source: "mandate" },
  { name: "cap_asset", type: "field", source: "mandate" },
  { name: "cap_amount", type: "uint64", source: "mandate" },
  { name: "egress_mode", type: "uint8", source: "mandate" },
  { name: "action_kind", type: "uint8", source: "action" },
  { name: "action_timestamp", type: "uint64", source: "action" },
  { name: "action_asset", type: "field", source: "action" },
  { name: "action_amount", type: "uint64", source: "action" },
  { name: "counterparty_ok", type: "boolean", source: "witness" },
  { name: "prior_spent", type: "uint64", source: "witness" },
  { name: "egress_ok", type: "boolean", source: "witness" },
];

export type PredicateAction = GuardAction;

export type PredicateArgs = [
  bigint, bigint, bigint, bigint, bigint,
  bigint, bigint, bigint, bigint,
  boolean, bigint, boolean,
];

export interface PredicateAllowlists {
  readonly counterpartyAllowlist: readonly string[];
  readonly egressAllowlist?: readonly string[];
}

export interface CompiledPredicate {
  buildArgs(action: PredicateAction, priorSpent: bigint): PredicateArgs;
}

export function compileMandatePredicate(
  mandate: MandateV1,
  allowlists: PredicateAllowlists,
): CompiledPredicate {
  mandate = decodeMandate(encodeMandate(mandate));
  const counterpartyAllowlist = Array.from(allowlists.counterpartyAllowlist);
  const suppliedEgress = allowlists.egressAllowlist;
  const egressAllowlist = suppliedEgress === undefined ? undefined : Array.from(suppliedEgress);
  const counterpartyRoot = buildAllowlistRoot(counterpartyAllowlist);
  if (!equalBytes(counterpartyRoot, mandate.counterpartyAllowlistRoot)) {
    throw new MandateError(
      "SCHEMA_BAD_TYPE",
      "counterparty allowlist does not hash to mandate.counterpartyAllowlistRoot",
    );
  }
  if (mandate.egressPolicy.mode === EGRESS_ALLOWLIST) {
    if (egressAllowlist === undefined) {
      throw new MandateError(
        "SCHEMA_BAD_TYPE",
        "mandate egress mode is allowlist but no egressAllowlist was provided",
      );
    }
    if (!equalBytes(buildAllowlistRoot(egressAllowlist), mandate.egressPolicy.allowlistRoot)) {
      throw new MandateError(
        "SCHEMA_BAD_TYPE",
        "egress allowlist does not hash to mandate.egressPolicy.allowlistRoot",
      );
    }
  } else if (egressAllowlist !== undefined) {
    throw new MandateError(
      "SCHEMA_BAD_TYPE",
      "mandate egress mode is deny-all; an egressAllowlist must not be provided",
    );
  }

  const counterparties = new Set(counterpartyAllowlist);
  const egressDestinations = new Set(egressAllowlist ?? []);
  const mandateArgs = {
    not_before: mandate.validityWindow.notBefore,
    not_after: mandate.validityWindow.notAfter,
    cap_asset: assetTag(mandate.spendCap.asset),
    cap_amount: mandate.spendCap.amount,
    egress_mode: mandate.egressPolicy.mode,
  };

  return {
    buildArgs(action, priorSpent) {
      action = { ...action };
      validateAction(action);
      if (typeof priorSpent !== "bigint" || priorSpent < 0n || priorSpent >= 1n << 64n) {
        throw new MandateError("SCHEMA_BAD_TYPE", "priorSpent must be a uint64");
      }
      if (action.kind === "payment") {
        return [
          mandateArgs.not_before,
          mandateArgs.not_after,
          mandateArgs.cap_asset,
          mandateArgs.cap_amount,
          mandateArgs.egress_mode,
          0n,
          action.timestamp,
          assetTag(action.asset),
          action.amount,
          counterparties.has(action.counterparty),
          priorSpent,
          false,
        ];
      }
      return [
        mandateArgs.not_before,
        mandateArgs.not_after,
        mandateArgs.cap_asset,
        mandateArgs.cap_amount,
        mandateArgs.egress_mode,
        1n,
        action.timestamp,
        0n,
        0n,
        false,
        priorSpent,
        egressDestinations.has(action.destination),
      ];
    },
  };
}
