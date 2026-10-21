// The runner's command line (orynq-midnight-runner beside this file runs it):
//   status [<id>]  one line per intent, from its status file
//   check <id>     the intent's sha256 and what the gate says of it now; runs nothing
//   dispatch       starts the unit of every approval not yet used or finished under that approval
//   run <id>       runs the intent; only as orynq-midnight-runner@<id>.service, started by systemd
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { agentDriven } from "../src/custody.js";
import { formatDust } from "../src/preflight.js";
import { admit } from "./gate.js";
import { runIntent } from "./run.js";
import { FINISHED, approvalUsed, audit, ensureRunnerRoot, mainnetPaths, readStatus, runnerFiles, writeStatus, type Status } from "./state.js";

const USAGE = "usage: orynq-midnight-runner status [<intent id>] | check <intent id> | dispatch | run <intent id>";
const PACKAGE = new URL("..", import.meta.url).pathname;
const AGENT = "this process carries Claude Code or Codex environment; only systemd starts the runner, with the user manager's environment";
const unit = (id: string) => `orynq-midnight-runner@${id}.service`;
const paths = mainnetPaths();
const files = runnerFiles(paths.root);

const line = (s: Status) => {
  const txs = s.transactions.map((t) => t.tx_hash.slice(0, 16)).join(",") || "-";
  const refusal = s.refusals.at(-1);
  return [
    `${s.intent_id} ${s.action ?? "-"} ${s.state} attempt ${s.attempt}`,
    ...(s.next_attempt_at ? [`next ${s.next_attempt_at}`] : []),
    `tx ${txs} refusals ${s.refusals.length}${refusal ? ` (${refusal.reason})` : ""} | ${s.last_progress ?? ""}`,
  ].join(" ");
};

// Records why the run of intent `id` did not start (`refused-start`) or broke off (`failed`) in its
// status and the audit log, and exits 1; dispatch starts an unfinished run again.
function stop(id: string, event: "refused-start" | "failed", reason: string): never {
  ensureRunnerRoot(paths.root);
  const at = new Date().toISOString();
  const status = readStatus(paths.root, id) ?? { intent_id: id, state: "refused", attempt: 0, transactions: [], refusals: [], updated_at: at };
  writeStatus(paths.root, { ...status, refusals: [...status.refusals, { at, reason }] });
  audit(paths.root, { intent: id, event, reason });
  process.stderr.write(`orynq-midnight-runner: ${reason}\n`);
  process.exit(1);
}

// Why this process is not the one systemd started as intent `id`'s unit, or null when it is.
function notTheUnit(id: string): string | null {
  const invocation = process.env.INVOCATION_ID;
  if (!invocation) return "this process was not started by systemd (it has no INVOCATION_ID)";
  const reported = execFileSync("systemctl", ["--user", "show", "--property=InvocationID", "--value", unit(id)], { encoding: "utf8" }).trim();
  return reported === invocation ? null : `INVOCATION_ID ${invocation} is not that of ${unit(id)} (${reported || "none"})`;
}

const [command, id, ...rest] = process.argv.slice(2);
const named = command === "check" || command === "run";
const intentId = id === undefined || /^[0-9a-f]{8}$/.test(id);
if (rest.length > 0 || !intentId || !(command === "status" || (command === "dispatch" && id === undefined) || (named && id !== undefined))) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

if (command === "status") {
  const ids = id ? [id] : existsSync(files.statuses) ? readdirSync(files.statuses).filter((f) => /^[0-9a-f]{8}\.json$/.test(f)).map((f) => f.slice(0, 8)) : [];
  for (const each of ids.sort()) {
    const status = readStatus(paths.root, each);
    process.stdout.write(`${status ? line(status) : `${each} no status`}\n`);
  }
} else if (command === "check") {
  const verdict = admit(paths, id!, Date.now());
  const sha = verdict.intentSha256 ? ` sha256 ${verdict.intentSha256}` : "";
  process.stdout.write(
    verdict.ok
      ? `${id}${sha}: admitted, ${verdict.action}, ${verdict.transactions} transaction${verdict.transactions === 1 ? "" : "s"} of at most ${formatDust(verdict.maxFee)} DUST, approval expires ${verdict.approval.expires_at}\n`
      : `${id}${sha}: refused, ${verdict.reason}\n`,
  );
  process.exit(verdict.ok ? 0 : 1);
} else if (command === "dispatch") {
  if (agentDriven(process.env)) {
    process.stderr.write(`orynq-midnight-runner: ${AGENT}\n`);
    process.exit(1);
  }
  ensureRunnerRoot(paths.root);
  for (const file of readdirSync(files.approvals).sort()) {
    const each = /^([0-9a-f]{8})\.json$/.exec(file)?.[1];
    if (!each) continue;
    const text = readFileSync(files.approval(each));
    const approvalSha256 = createHash("sha256").update(text).digest("hex");
    if (approvalUsed(paths.root, each, approvalSha256)) continue;
    // The run decides everything else, an expired approval included, and records it in the status.
    const status = readStatus(paths.root, each);
    if (status && FINISHED.includes(status.state) && status.approval_sha256 === approvalSha256) continue;
    // `start` of an active unit does nothing; asking first keeps the audit log to real starts.
    if (spawnSync("systemctl", ["--user", "is-active", "--quiet", unit(each)]).status === 0) continue;
    execFileSync("systemctl", ["--user", "start", "--no-block", unit(each)]);
    audit(paths.root, { intent: each, event: "dispatch", approval_sha256: approvalSha256 });
    process.stdout.write(`started ${unit(each)}\n`);
  }
} else {
  if (agentDriven(process.env)) stop(id!, "refused-start", AGENT);
  const outside = notTheUnit(id!);
  if (outside) stop(id!, "refused-start", outside);
  const status = await runIntent({
    paths,
    id: id!,
    cwd: PACKAGE,
    env: process.env,
    tool: (action, plan, planSha256) => [process.execPath, "--import", "tsx", ...(action === "deploy" ? ["scripts/deploy-mainnet.ts"] : ["scripts/anchor-mainnet.ts", "--plan", plan!, "--plan-sha256", planSha256!])],
  }).catch((error: Error) => stop(id!, "failed", `the run broke off: ${error.message}`));
  process.stdout.write(`${line(status)}\n`);
}
