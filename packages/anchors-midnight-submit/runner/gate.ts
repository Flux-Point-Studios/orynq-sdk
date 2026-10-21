// The approval gate: the runner executes an intent only while every condition here holds, and
// names the first that does not. It guards against mistakes and drift. Any process running as
// deci can still write an approval (README.md, threat model).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readAnchorPlan } from "../src/anchor-plan.js";
import { readJsonFile } from "../src/json-file.js";
import { formatDust, parseDust } from "../src/preflight.js";
import { afterDeployRegistry, intentEntries, intentSha256, type AnchorsIntent, type DeployIntent } from "./confirm.js";
import { LIMITS } from "./limits.js";
import { approvalUsed, readAudit, runnerFiles, type RunnerPaths } from "./state.js";

// What the CTO session writes once deci approved intent `intent_id` in chat.
export interface Approval {
  intent_id: string;
  intent_sha256: string;
  approved_at: string;
  expires_at: string;
  approved_via: "chat";
  approver: "deci";
}

export type Admitted = {
  ok: true;
  id: string;
  action: "deploy" | "anchors";
  intent: DeployIntent | AnchorsIntent;
  approval: Approval;
  intentSha256: string;
  approvalSha256: string;
  expiresAt: number;
  // How many transactions the intent sends, each declaring at most `maxFee` SPECK.
  transactions: number;
  maxFee: bigint;
};
export type Refused = { ok: false; reason: string; expired?: true; intentSha256?: string; approvalSha256?: string };

const HOUR = 3_600_000;
const APPROVAL_FIELDS = ["intent_id", "intent_sha256", "approved_at", "expires_at", "approved_via", "approver"];
const DEPLOY_FIELDS = ["action", "network", "authority", "verifierKeys", "payer", "maxFeeDust"];
const ANCHORS_FIELDS = ["action", "network", "plan", "planSha256", "registry", "entries", "authorKeys", "payer", "maxFeeDustPerAnchor"];
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Every refusal is thrown and caught by admit, along with any error reading what it checks.
const refuse = (reason: string): never => {
  throw new Error(reason);
};

// A reservation lasts through the later of confirmation and transaction expiry, plus the window.
export function confirmedDust(root: string, after: number, except?: string, exceptTransaction?: string): bigint {
  const fees = new Map<string, bigint>();
  for (const e of readAudit(root)) {
    if (e.event !== "confirm" || e.intent === except || e.tx_hash === exceptTransaction) continue;
    const confirmedAt = Date.parse(e.at);
    const validUntil = Date.parse(String(e.valid_until ?? e.at));
    const fee = parseDust(String(e.fee_dust));
    if (!Number.isFinite(confirmedAt) || !Number.isFinite(validUntil) || fee === null) throw new Error("the confirmation audit holds an invalid time or fee");
    if (Math.max(confirmedAt, validUntil) > after) fees.set(String(e.tx_hash), fee);
  }
  return [...fees.values()].reduce((sum, fee) => sum + fee, 0n);
}

// Every field of `intent` that limits.json pins, and no field the intent does not take.
function allowlisted(intent: Record<string, unknown>, what: "deploy" | "anchors", fields: string[], pinned: Record<string, unknown>) {
  if (!same(Object.keys(intent), fields)) refuse(`the ${what} intent has fields ${Object.keys(intent).join(", ")}; it takes ${fields.join(", ")}`);
  for (const [field, value] of Object.entries(pinned)) {
    if (!same(intent[field], value)) refuse(`the ${what === "deploy" ? "deploy's" : "anchors'"} ${field} is ${JSON.stringify(intent[field])}, not the allowlisted one`);
  }
}

// The anchors intent's plan holds exactly its entries, as they were when deci approved it, for the
// registry it names: deploy-mainnet's landed one, still to be written into an after-deploy plan.
function plannedAnchors(paths: RunnerPaths, intent: AnchorsIntent) {
  if (!existsSync(intent.plan)) refuse(`no plan ${intent.plan}`);
  const planSha256 = sha256(readFileSync(intent.plan));
  if (planSha256 !== intent.planSha256) refuse(`${intent.plan} hashes to ${planSha256}, not the intent's planSha256 ${intent.planSha256}`);
  const plan = readAnchorPlan(intent.plan, intent.planSha256);
  if (!same(intentEntries(plan), intent.entries)) refuse(`the intent's entries are not exactly those of ${intent.plan}`);
  if (/^[0-9a-f]{64}$/.test(intent.registry)) {
    if (plan.registry !== intent.registry) refuse(`the anchors' registry ${intent.registry} is not the registry ${intent.plan} names, ${plan.registry}`);
  } else if (intent.registry !== afterDeployRegistry(paths.deployJournal, paths.planOut)) {
    refuse(`the anchors' registry ${JSON.stringify(intent.registry)} is neither 64 hex characters nor the registry ${paths.deployJournal} records as landed`);
  }
  if (intent.entries.length > LIMITS.anchors.maxEntriesPerApproval) refuse(`the intent writes ${intent.entries.length} anchors, more than the ${LIMITS.anchors.maxEntriesPerApproval} one approval may write`);
}

// The approval of intent `id` as it stands at `now`.
function approvalOf(paths: RunnerPaths, id: string, sha: string, now: number) {
  const file = runnerFiles(paths.root).approval(id);
  if (!existsSync(file)) refuse(`no approval ${file}`);
  const text = readFileSync(file);
  const approvalSha256 = sha256(text);
  const approval = readJsonFile(file, approvalSha256) as Approval;
  if (typeof approval !== "object" || approval === null || Array.isArray(approval)) refuse("the approval is not a JSON object");
  const unknown = Object.keys(approval).find((field) => !APPROVAL_FIELDS.includes(field));
  if (unknown !== undefined) refuse(`the approval has field ${JSON.stringify(unknown)}; it takes ${APPROVAL_FIELDS.slice(0, -1).join(", ")} and ${APPROVAL_FIELDS.at(-1)}`);
  if (approval.intent_id !== id) refuse(`the approval names intent ${JSON.stringify(approval.intent_id)}, not ${id}`);
  if (approval.approver !== "deci" || approval.approved_via !== "chat") refuse(`the approval is not deci's in chat: approver ${JSON.stringify(approval.approver)}, approved_via ${JSON.stringify(approval.approved_via)}`);
  if (approval.intent_sha256 !== sha) refuse(`the approval names intent sha256 ${approval.intent_sha256}, but ${runnerFiles(paths.root).intent(id)} hashes to ${sha}`);
  const [approvedAt, expiresAt] = (["approved_at", "expires_at"] as const).map((field) => {
    const at = typeof approval[field] === "string" && /^\d{4}-\d\d-\d\dT/.test(approval[field]) ? Date.parse(approval[field]) : NaN;
    return Number.isNaN(at) ? refuse(`the approval's ${field} ${JSON.stringify(approval[field])} is not an ISO 8601 time`) : at;
  }) as [number, number];
  if (approvedAt > now) refuse(`the approval was given at ${approval.approved_at}, after now (${new Date(now).toISOString()})`);
  if (expiresAt - approvedAt > LIMITS.maxApprovalHours * HOUR) refuse(`the approval runs from ${approval.approved_at} to ${approval.expires_at}, longer than ${LIMITS.maxApprovalHours} h`);
  return { approval, approvalSha256, expiresAt };
}

// Whether intent `id` may run at `now`: its approval exists, names the intent's sha256, has not
// expired and has not been used; its action and every fact limits.json pins are allowlisted; its
// fee cap is within the per-transaction cap; and with what other intents confirmed in the last
// 24 hours, its maximum stays within the daily cap.
export function admit(paths: RunnerPaths, id: string, now: number): Admitted | Refused {
  const files = runnerFiles(paths.root);
  const read: { intentSha256?: string; approvalSha256?: string } = {};
  try {
    if (!/^[0-9a-f]{8}$/.test(id)) refuse(`${JSON.stringify(id)} is not an intent id: 8 lowercase hex characters`);
    if (!existsSync(files.intent(id))) refuse(`no intent ${files.intent(id)}`);
    const intent = readJsonFile(files.intent(id)) as DeployIntent | AnchorsIntent;
    const sha = (read.intentSha256 = intentSha256(intent));
    if (!sha.startsWith(id)) refuse(`${files.intent(id)} hashes to ${sha}, which is not intent ${id}`);
    const approved = approvalOf(paths, id, sha, now);
    const { approvalSha256 } = approved;
    read.approvalSha256 = approvalSha256;
    if (approved.expiresAt <= now) return { ok: false, expired: true, reason: `the approval expired at ${approved.approval.expires_at}`, ...read };
    if (approvalUsed(paths.root, id, approvalSha256)) refuse(`approval ${id} was already used`);

    let admitted: Pick<Admitted, "action" | "transactions"> & { maxFeeDust: string };
    if (intent.action === LIMITS.deploy.action) {
      const { action, authority, verifierKeys } = LIMITS.deploy;
      allowlisted(intent as unknown as Record<string, unknown>, "deploy", DEPLOY_FIELDS, { action, network: LIMITS.network, authority, verifierKeys, payer: LIMITS.payer });
      admitted = { action: "deploy", transactions: 1, maxFeeDust: (intent as DeployIntent).maxFeeDust };
    } else if (intent.action === LIMITS.anchors.action) {
      const anchors = intent as AnchorsIntent;
      allowlisted(intent as unknown as Record<string, unknown>, "anchors", ANCHORS_FIELDS, { action: LIMITS.anchors.action, network: LIMITS.network, authorKeys: LIMITS.anchors.authorKeys, payer: LIMITS.payer });
      plannedAnchors(paths, anchors);
      admitted = { action: "anchors", transactions: anchors.entries.length, maxFeeDust: anchors.maxFeeDustPerAnchor };
    } else return refuse(`action ${JSON.stringify(intent.action)} is not allowlisted`);

    const maxFee = (typeof admitted.maxFeeDust === "string" ? parseDust(admitted.maxFeeDust) : null) ?? refuse(`the fee cap ${JSON.stringify(admitted.maxFeeDust)} is not a DUST amount`);
    if (maxFee > parseDust(LIMITS.maxFeeDustPerTransaction)!) refuse(`the fee cap ${admitted.maxFeeDust} DUST is over the per-transaction cap ${LIMITS.maxFeeDustPerTransaction} DUST`);
    const others = confirmedDust(paths.root, now - 24 * HOUR, id);
    const most = maxFee * BigInt(admitted.transactions);
    if (others + most > parseDust(LIMITS.maxDustPer24Hours)!) {
      refuse(`${formatDust(others)} DUST reserved by other intents for the rolling 24 h window and this intent's maximum ${formatDust(most)} DUST come to more than the ${LIMITS.maxDustPer24Hours} DUST daily cap`);
    }
    return { ok: true, id, intent, approval: approved.approval, intentSha256: sha, approvalSha256, expiresAt: approved.expiresAt, action: admitted.action, transactions: admitted.transactions, maxFee };
  } catch (error) {
    return { ok: false, reason: (error as Error).message, ...read };
  }
}
