import type { VerdictName } from "./predicate.js";

export type DenialReason = Exclude<VerdictName, "ALLOW">;

export const DENIAL_RULES: Readonly<Record<DenialReason, string>> = {
  MANDATE_NOT_YET_VALID: "timestamp precedes mandate validity",
  MANDATE_EXPIRED: "timestamp reaches or exceeds mandate expiry",
  ASSET_MISMATCH: "asset is not the mandated asset",
  COUNTERPARTY_NOT_ALLOWED: "counterparty is not in the mandate allowlist",
  SPEND_CAP_EXCEEDED: "payment exceeds the remaining window spend cap",
  EGRESS_DENIED: "mandate egress policy is deny-all",
  EGRESS_NOT_ALLOWED: "destination is not in the egress allowlist",
};

export type GuardDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DenialReason; readonly rule: string };
