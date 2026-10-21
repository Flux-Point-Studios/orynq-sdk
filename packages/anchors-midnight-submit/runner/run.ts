// Runs one approved intent unattended: the gate (gate.ts) before every attempt and again at every
// prompt, the reviewed tool in a pseudo-terminal (confirm.ts), retried with backoff until it
// finishes or the approval expires, with the status, the audit log and the tool's output written
// as it goes. The tools' write-ahead journals keep a retry from sending a transaction twice: a
// rerun shows the bytes a journal still holds, which the runner confirms again as the same
// transaction, and the runner confirms other bytes for a transaction only once the journal holds
// every earlier one failed or never held it (so never sent it).
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readAnchorPlan } from "../src/anchor-plan.js";
import { formatDust, parseDust } from "../src/preflight.js";
import { checkAnchorSummary, checkDeploySummary, driveTool, intentEntries, type AnchorsIntent, type Decision, type DeployIntent } from "./confirm.js";
import { admit, confirmedDust, type Admitted } from "./gate.js";
import { LIMITS } from "./limits.js";
import { fillPlan, landedDeploy } from "./plan.js";
import { audit, ensureRunnerRoot, flushDirectory, readAudit, readStatus, runnerFiles, writeStatus, type RunnerPaths, type Status } from "./state.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// The waits before the first, second, ... retry, the last one repeating.
export const BACKOFF_MS: readonly number[] = [1, 2, 4, 8, 16, 30].map((m) => m * MINUTE);
const iso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RunOptions {
  paths: RunnerPaths;
  id: string;
  // The reviewed tool's command for the intent's action, given the plan anchors are written from;
  // it runs in `cwd` with `env`.
  tool: (action: Admitted["action"], plan?: string, planSha256?: string) => string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  backoffMs?: readonly number[];
  // How often the deploy journal is read while anchors wait for the deploy to land.
  pollMs?: number;
}

// How the journal at `path` holds `txHash`, read only; null where it holds none, which for a
// write-ahead journal means the bytes were never sent.
function journalState(path: string, txHash: string): string | null {
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("select state from attempts where tx_hash = ?").get(txHash) as { state: string } | undefined)?.state ?? null;
  } finally {
    db.close();
  }
}

export async function runIntent({ paths, id, tool, cwd, env, backoffMs = BACKOFF_MS, pollMs = 15_000 }: RunOptions): Promise<Status> {
  const { root } = paths;
  ensureRunnerRoot(root);
  const files = runnerFiles(root);
  let status: Status = readStatus(root, id) ?? { intent_id: id, state: "admitted", attempt: 0, transactions: [], refusals: [], updated_at: iso(Date.now()) };
  const save = (change: Partial<Status>) => (status = writeStatus(root, { ...status, ...change }));
  let verdict = admit(paths, id, Date.now());
  const originalApproval = verdict.approvalSha256;
  // Ends the run in `state`, naming `reason`; a run the tool finished, or one the runner stopped by
  // answering NO, spends the approval.
  const finish = (state: "done" | "refused" | "expired", reason?: string, spent = false): Status => {
    const at = iso(Date.now());
    if (spent) {
      if (!originalApproval) throw new Error("cannot consume an approval without its digest");
      const used = files.used(id, originalApproval);
      writeFileSync(used, JSON.stringify({ at, approval_sha256: originalApproval, outcome: state, ...(reason ? { reason } : {}) }), { mode: 0o600, flag: "wx", flush: true });
      flushDirectory(dirname(used));
    }
    save({ state, next_attempt_at: undefined, ...(reason ? { refusals: [...status.refusals, { at, reason }] } : {}) });
    audit(root, { intent: id, event: state, approval_sha256: originalApproval, ...(reason ? { reason } : {}) });
    return status;
  };

  audit(root, { intent: id, event: "approval-seen", approval_sha256: verdict.approvalSha256 ?? null, ...(verdict.ok ? { action: verdict.action, expires_at: verdict.approval.expires_at } : { refused: verdict.reason }) });
  if (!verdict.ok) {
    // The approval this refusal is about, or none where the gate refused before naming one.
    save({ approval_sha256: verdict.approvalSha256 });
    return finish(verdict.expired ? "expired" : "refused", verdict.reason);
  }
  const { action, intent, intentSha256 } = verdict;
  const recovered = new Map(status.transactions.map((t) => [t.tx_hash, t]));
  for (const event of readAudit(root)) {
    if (event.event !== "confirm" || event.intent !== id || recovered.has(String(event.tx_hash))) continue;
    if (typeof event.approval_sha256 !== "string" || typeof event.item !== "string" || typeof event.tx_hash !== "string" || typeof event.fee_dust !== "string") {
      return finish("refused", "a confirmation record lacks its approval identity or transaction facts");
    }
    recovered.set(event.tx_hash, { item: event.item, tx_hash: event.tx_hash, fee_dust: event.fee_dust, confirmed_at: event.at, approval_sha256: event.approval_sha256, ...(typeof event.valid_until === "string" ? { valid_until: event.valid_until } : {}) });
  }
  status.transactions = [...recovered.values()];
  save({ action, state: "admitted", approval_sha256: verdict.approvalSha256, expires_at: verdict.approval.expires_at });

  // Anchors go to the registry deploy-mainnet's journal holds landed, once it does.
  let plan: string | undefined;
  let planSha256: string | undefined;
  let registry = "";
  if (action === "anchors") {
    const anchors = intent as AnchorsIntent;
    let landed = landedDeploy(paths.deployJournal);
    if (!landed) save({ state: "waiting-for-deploy" });
    while (!landed) {
      const left = verdict.expiresAt - Date.now();
      if (left <= 0) return finish("expired", `the approval expired at ${verdict.approval.expires_at} while ${paths.deployJournal} held no landed registry deploy`);
      await sleep(Math.min(pollMs, left));
      landed = landedDeploy(paths.deployJournal);
    }
    registry = landed.address;
    audit(root, { intent: id, event: "deploy-landed", registry, tx_hash: landed.txHash, height: landed.height });
    if (/^[0-9a-f]{64}$/.test(anchors.registry)) {
      if (anchors.registry !== registry) return finish("refused", `the plan's registry ${anchors.registry} is not ${registry}, the one ${paths.deployJournal} holds landed`);
      plan = anchors.plan;
    } else {
      let written: boolean;
      try {
        written = fillPlan(anchors.plan, registry, paths.planOut, anchors.planSha256);
      } catch (error) {
        return finish("refused", (error as Error).message);
      }
      plan = paths.planOut;
      audit(root, { intent: id, event: "plan", plan, registry, written });
    }
    planSha256 = createHash("sha256").update(readFileSync(plan)).digest("hex");
    const parsed = readAnchorPlan(plan, planSha256);
    if (parsed.registry !== registry || JSON.stringify(intentEntries(parsed)) !== JSON.stringify(anchors.entries)) {
      return finish("refused", "the execution plan differs from the approved entries or landed registry");
    }
  }

  const journal = action === "deploy" ? paths.deployJournal : paths.anchorsJournal;
  const dailyCap = parseDust(LIMITS.maxDustPer24Hours)!;
  for (;;) {
    verdict = admit(paths, id, Date.now());
    if (!verdict.ok) return finish(verdict.expired ? "expired" : "refused", verdict.reason);
    if (verdict.intentSha256 !== intentSha256 || verdict.approvalSha256 !== originalApproval) return finish("refused", "the intent or approval changed during the run");
    const { approvalSha256, expiresAt, approval } = verdict;
    const attempt = status.attempt + 1;
    save({ state: "running", attempt, next_attempt_at: undefined });
    audit(root, { intent: id, event: "run-start", attempt });
    appendFileSync(files.log(id), `\n--- attempt ${attempt} at ${iso(Date.now())}\n`, { mode: 0o600 });

    let confirmed = false;
    let refusal: string | undefined;
    let expired = false;
    let lastLine = "";
    const confirmedItems = new Set<string>();
    // The runner's answer at a prompt: the summary matches the intent, the approval still holds,
    // and other bytes for a transaction confirmed before come only after the journal let go of
    // those, within the confirmations per transaction and the daily cap.
    const decide = (summary: string, token: string): Decision => {
      const at = Date.now();
      const check = action === "deploy" ? checkDeploySummary(intent as DeployIntent, summary, token) : checkAnchorSummary(intent as AnchorsIntent, registry, summary, token);
      const problems = [...check.problems];
      const current = admit(paths, id, at);
      if (!current.ok) {
        problems.push(`the approval no longer holds: ${current.reason}`);
        expired ||= current.expired === true;
      } else if (current.intentSha256 !== intentSha256 || current.approvalSha256 !== originalApproval) {
        problems.push("the intent or approval changed during the run");
      }
      const item = check.item ?? "an unnamed transaction";
      if (confirmedItems.has(item)) problems.push("already confirmed in this attempt");
      const earlier = status.transactions.filter((t) => t.item === item);
      const resumed = earlier.some((t) => t.tx_hash === check.txHash);
      if (problems.length === 0 && !resumed) {
        const mine = earlier.filter((t) => t.approval_sha256 === approvalSha256).length;
        if (mine >= LIMITS.maxConfirmationsPerTransaction) problems.push(`confirmed ${mine} times under this approval, the most limits.json allows`);
        for (const t of earlier) {
          const held = journalState(journal, t.tx_hash);
          if (held !== null && held !== "failed") problems.push(`the journal holds ${t.tx_hash}, confirmed for it earlier, ${held}; other bytes could land it twice`);
        }
      }
      if (problems.length === 0) {
        const spent = confirmedDust(root, at - DAY, undefined, check.txHash);
        if (spent + check.fee! > dailyCap) problems.push(`${formatDust(spent)} DUST reserved for the rolling 24 h window and this transaction's ${formatDust(check.fee!)} DUST come to more than the ${LIMITS.maxDustPer24Hours} DUST daily cap`);
      }
      if (problems.length > 0) return { ...check, item, problems };
      confirmedItems.add(item);
      audit(root, { intent: id, event: "confirm", item, tx_hash: check.txHash, fee_dust: formatDust(check.fee!), valid_until: check.validUntil, resumed, approval_sha256: approvalSha256 });
      if (!resumed) save({ transactions: [...status.transactions, { item, tx_hash: check.txHash!, fee_dust: formatDust(check.fee!), confirmed_at: iso(at), approval_sha256: approvalSha256, valid_until: check.validUntil! }] });
      if (Date.now() >= expiresAt) {
        expired = true;
        return { ...check, item, problems: ["the approval expired before confirmation was recorded"] };
      }
      confirmed = true;
      return check;
    };
    // Every NO, whether `decide` or driveTool found the problem, is in the audit log, flushed,
    // before the tool reads it, so a run interrupted after it cannot use the approval again.
    const onNo = ({ item, txHash, problems }: Decision) => {
      refusal ??= item ? `${item}: ${problems.join("; ")}` : problems.join("; ");
      audit(root, { intent: id, event: "no", approval_sha256: originalApproval, item, tx_hash: txHash ?? null, problems });
    };
    const onText = (text: string) => {
      appendFileSync(files.log(id), text, { mode: 0o600 });
      const line = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
      if (line) save({ last_progress: (lastLine = line) });
    };

    // Keep wallet access and confirmation accounting serialized until the tool exits.
    appendFileSync(files.executionLock, "", { mode: 0o600 });
    const command = ["flock", "--exclusive", files.executionLock, ...tool(action, plan, planSha256)];
    const run = driveTool({ command, cwd, env, verb: action === "deploy" ? "DEPLOY" : "ANCHOR", decide, onNo, onText });
    // At expiry a tool that has confirmed nothing is stopped; one that has goes on to finish what it sends.
    let stopped = false;
    const timer = setTimeout(() => {
      if (confirmed) return;
      stopped = true;
      run.stop();
    }, Math.max(0, expiresAt - Date.now()));
    const { code } = await run.exited;
    clearTimeout(timer);
    audit(root, { intent: id, event: "run-end", attempt, code });

    if (refusal) return finish(expired ? "expired" : "refused", refusal, !expired);
    if (stopped) return finish("expired", `the approval expired at ${approval.expires_at} before attempt ${attempt} confirmed anything; the tool was stopped`);
    if (code === 0) return finish("done", undefined, true);
    const wait = backoffMs[Math.min(attempt, backoffMs.length) - 1]!;
    const next = Date.now() + wait;
    if (next >= expiresAt) return finish("expired", `the approval expires at ${approval.expires_at}, before the next attempt at ${iso(next)}`);
    save({ state: "retrying", next_attempt_at: iso(next) });
    audit(root, { intent: id, event: "retry", attempt, after_ms: wait, reason: lastLine });
    await sleep(wait);
  }
}
