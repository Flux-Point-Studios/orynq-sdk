// Runs one approved intent unattended: the gate (gate.ts) before every attempt and again at every
// prompt, the reviewed tool in a pseudo-terminal (confirm.ts), retried with backoff until it
// finishes or the approval expires, with the status, the audit log and the tool's output written
// as it goes. The tools' write-ahead journals keep a retry from sending a transaction twice: a
// rerun shows the bytes a journal still holds, which the runner confirms again as the same
// transaction, and the runner confirms other bytes for a transaction only once the journal holds
// every earlier one failed or never held it (so never sent it).
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { formatDust, parseDust } from "../src/preflight.js";
import { checkAnchorSummary, checkDeploySummary, driveTool, type AnchorsIntent, type Decision, type DeployIntent } from "./confirm.js";
import { admit, confirmedDust, type Admitted } from "./gate.js";
import { LIMITS } from "./limits.js";
import { fillPlan, landedDeploy } from "./plan.js";
import { audit, ensureRunnerRoot, readStatus, runnerFiles, writeStatus, type RunnerPaths, type Status } from "./state.js";

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
  tool: (action: Admitted["action"], plan?: string) => string[];
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
  // Ends the run in `state`, naming `reason`; a run the tool finished, or one the runner stopped by
  // answering NO, spends the approval.
  const finish = (state: "done" | "refused" | "expired", reason?: string, spent = false): Status => {
    const at = iso(Date.now());
    if (spent) writeFileSync(files.used(id), JSON.stringify({ at, outcome: state, ...(reason ? { reason } : {}) }), { mode: 0o600, flag: "wx" });
    save({ state, next_attempt_at: undefined, ...(reason ? { refusals: [...status.refusals, { at, reason }] } : {}) });
    audit(root, { intent: id, event: state, ...(reason ? { reason } : {}) });
    return status;
  };

  let verdict = admit(paths, id, Date.now());
  audit(root, { intent: id, event: "approval-seen", approval_sha256: verdict.approvalSha256 ?? null, ...(verdict.ok ? { action: verdict.action, expires_at: verdict.approval.expires_at } : { refused: verdict.reason }) });
  if (!verdict.ok) {
    if (verdict.approvalSha256) save({ approval_sha256: verdict.approvalSha256 });
    return finish(verdict.expired ? "expired" : "refused", verdict.reason);
  }
  const { action, intent } = verdict;
  save({ action, state: "admitted", approval_sha256: verdict.approvalSha256, expires_at: verdict.approval.expires_at });

  // Anchors go to the registry deploy-mainnet's journal holds landed, once it does.
  let plan: string | undefined;
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
        written = fillPlan(anchors.plan, registry, paths.planOut);
      } catch (error) {
        return finish("refused", (error as Error).message);
      }
      plan = paths.planOut;
      audit(root, { intent: id, event: "plan", plan, registry, written });
    }
  }

  const journal = action === "deploy" ? paths.deployJournal : paths.anchorsJournal;
  const dailyCap = parseDust(LIMITS.maxDustPer24Hours)!;
  for (;;) {
    verdict = admit(paths, id, Date.now());
    if (!verdict.ok) return finish(verdict.expired ? "expired" : "refused", verdict.reason);
    const { approvalSha256, expiresAt, approval } = verdict;
    const attempt = status.attempt + 1;
    save({ state: "running", attempt, next_attempt_at: undefined });
    audit(root, { intent: id, event: "run-start", attempt });
    appendFileSync(files.log(id), `\n--- attempt ${attempt} at ${iso(Date.now())}\n`, { mode: 0o600 });

    let confirmed = false;
    let refusal: string | undefined;
    let expired = false;
    let lastLine = "";
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
      }
      const item = check.item ?? "an unnamed transaction";
      const earlier = status.transactions.filter((t) => t.item === item);
      const resumed = earlier.some((t) => t.tx_hash === check.txHash);
      if (problems.length === 0 && !resumed) {
        const mine = earlier.filter((t) => t.approval_sha256 === approvalSha256).length;
        if (mine >= LIMITS.maxConfirmationsPerTransaction) problems.push(`confirmed ${mine} times under this approval, the most limits.json allows`);
        for (const t of earlier) {
          const held = journalState(journal, t.tx_hash);
          if (held !== null && held !== "failed") problems.push(`the journal holds ${t.tx_hash}, confirmed for it earlier, ${held}; other bytes could land it twice`);
        }
        const spent = confirmedDust(root, at - DAY);
        if (spent + check.fee! > dailyCap) problems.push(`${formatDust(spent)} DUST confirmed in the last 24 h and this transaction's ${formatDust(check.fee!)} DUST come to more than the ${LIMITS.maxDustPer24Hours} DUST daily cap`);
      }
      if (problems.length > 0) {
        refusal ??= `${item}: ${problems.join("; ")}`;
        audit(root, { intent: id, event: "no", item, tx_hash: check.txHash ?? null, problems });
        return { ...check, problems };
      }
      confirmed = true;
      audit(root, { intent: id, event: "confirm", item, tx_hash: check.txHash, fee_dust: formatDust(check.fee!), resumed });
      if (!resumed) save({ transactions: [...status.transactions, { item, tx_hash: check.txHash!, fee_dust: formatDust(check.fee!), confirmed_at: iso(at), approval_sha256: approvalSha256 }] });
      return check;
    };
    const onText = (text: string) => {
      appendFileSync(files.log(id), text, { mode: 0o600 });
      const line = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
      if (line) save({ last_progress: (lastLine = line) });
    };

    const run = driveTool({ command: tool(action, plan), cwd, env, verb: action === "deploy" ? "DEPLOY" : "ANCHOR", decide, onText });
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
