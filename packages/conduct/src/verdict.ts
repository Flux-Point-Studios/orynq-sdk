import type { VerdictName } from "./predicate.js";

export type DenialReason = Exclude<VerdictName, "ALLOW">;

export type GuardDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DenialReason; readonly rule: string };
