import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalize } from "@fluxpointstudios/orynq-sdk-core";
import { REGISTRY_VERIFIER_KEY_SHA256, assertRegistryDeployBytes } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { readAnchorPlan, type AnchorPlan } from "./anchor-plan.js";
import { assertConfirmedHash, declaredFee, finalTransaction, type PreparedBytes } from "./submission.js";

export const intentDigest = (intent: unknown): string => createHash("sha256").update(canonicalize(intent, { removeNulls: false })).digest("hex");
export const planHash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

export function authorizationIntent(payer: string, maxFee: bigint, plan?: { path: string; value: AnchorPlan }) {
  const common = { network: "mainnet", payer, maxFeeSpeck: maxFee.toString() };
  if (!plan) return {
    ...common,
    action: "deploy the immutable orynq-anchor-registry",
    authority: { committee: [], threshold: 1, counter: "0" },
    verifierKeys: REGISTRY_VERIFIER_KEY_SHA256,
  };
  const hash = planHash(plan.path);
  if (intentDigest(readAnchorPlan(plan.path)) !== intentDigest(plan.value) || planHash(plan.path) !== hash) {
    throw new Error("the anchor plan changed while reading it; nothing was sent");
  }
  return { ...common, action: "anchors", planSha256: hash, registry: plan.value.registry, entries: plan.value.entries.map(({ label, kind }) => ({ label, kind })) };
}

export function assertPreauthorizedBytes(prepared: PreparedBytes, payer: string, maxFee: bigint, deploy: boolean): void {
  assertConfirmedHash(prepared);
  if (deploy) assertRegistryDeployBytes(prepared.bytes, "final");
  if (prepared.network !== "mainnet") throw new Error("pre-authorized network mismatch; nothing was sent");
  if (prepared.payer !== payer) throw new Error("pre-authorized payer mismatch; nothing was sent");
  const fee = declaredFee(finalTransaction(prepared.bytes));
  if (fee !== prepared.declaredFee || fee > maxFee) throw new Error("declared fee exceeds the pre-authorized cap or summary mismatch; nothing was sent");
}
