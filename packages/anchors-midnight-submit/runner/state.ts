import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensurePrivateDir } from "../src/keys.js";
import { ANCHORS_JOURNAL, DEPLOY_JOURNAL, STATE, home } from "../scripts/mainnet-session.js";

// Where the runner reads and writes: its state root, the deploy-mainnet and anchor-mainnet
// journals it reads, and the plan it writes for anchors authorized before the deploy landed.
export interface RunnerPaths {
  root: string;
  deployJournal: string;
  anchorsJournal: string;
  planOut: string;
}

// The mainnet tools' own paths, as their defaults name them.
export const mainnetPaths = (): RunnerPaths => ({ root: `${STATE}/runner`, deployJournal: DEPLOY_JOURNAL, anchorsJournal: ANCHORS_JOURNAL, planOut: `${home}/orynq-midnight-mainnet-plan.json` });

// The state root: what the CTO session writes (intents, approvals) and what the runner writes
// (single-use markers, status, the audit log, each intent's tool output).
export const runnerFiles = (root: string) => ({
  intent: (id: string) => join(root, "intents", `${id}.json`),
  approval: (id: string) => join(root, "approvals", `${id}.json`),
  used: (id: string, approvalSha256?: string) => join(root, "used", approvalSha256 ? `${id}.${approvalSha256}` : id),
  status: (id: string) => join(root, "status", `${id}.json`),
  log: (id: string) => join(root, "logs", `${id}.log`),
  approvals: join(root, "approvals"),
  statuses: join(root, "status"),
  audit: join(root, "audit.jsonl"),
  executionLock: join(root, "execution.lock"),
});

// Creates the state root and its directories owner-only, refusing any that group or others can enter.
export function ensureRunnerRoot(root: string): void {
  for (const dir of [root, ...["intents", "approvals", "used", "status", "logs"].map((d) => join(root, d))]) ensurePrivateDir(dir);
  flushDirectory(root);
  flushDirectory(dirname(root));
}

export function flushDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export type State = "admitted" | "waiting-for-deploy" | "running" | "retrying" | "done" | "refused" | "expired";
export const FINISHED: readonly State[] = ["done", "refused", "expired"];

export interface Status {
  intent_id: string;
  action?: "deploy" | "anchors";
  state: State;
  attempt: number;
  approval_sha256?: string | undefined;
  expires_at?: string;
  next_attempt_at?: string | undefined;
  last_progress?: string;
  // Every transaction the runner confirmed for this intent, under the approval named.
  transactions: { item: string; tx_hash: string; fee_dust: string; confirmed_at: string; approval_sha256: string; valid_until?: string }[];
  refusals: { at: string; reason: string }[];
  updated_at: string;
}

export function readStatus(root: string, id: string): Status | null {
  const file = runnerFiles(root).status(id);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Status) : null;
}

// Replaces the status file whole, owner-only, and returns the status as written.
export function writeStatus(root: string, status: Status): Status {
  const file = runnerFiles(root).status(status.intent_id);
  const written = JSON.parse(JSON.stringify({ ...status, updated_at: new Date().toISOString() })) as Status;
  writeFileSync(`${file}.${process.pid}.next`, `${JSON.stringify(written, null, 1)}\n`, { mode: 0o600, flush: true });
  renameSync(`${file}.${process.pid}.next`, file);
  flushDirectory(dirname(file));
  return written;
}

export interface AuditEvent {
  intent: string;
  event: string;
  [field: string]: unknown;
}

// Appends one line to the audit log, which is only ever appended to.
export function audit(root: string, event: AuditEvent): void {
  appendFileSync(runnerFiles(root).audit, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600, flush: true });
  flushDirectory(root);
}

// Every line of the audit log; a line that does not read back is an error, never skipped.
export function readAudit(root: string): (AuditEvent & { at: string })[] {
  const file = runnerFiles(root).audit;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${file} line ${i + 1} is not JSON`);
      }
    });
}

// A durable NO survives loss of both the status and the used marker. Legacy consumption without
// an approval identity cannot safely be assigned to a replacement, so it keeps the intent closed,
// and it is all that can be checked for an approval without an identity.
export function approvalUsed(root: string, id: string, approvalSha256?: string): boolean {
  const files = runnerFiles(root);
  return existsSync(files.used(id)) || existsSync(files.used(id, approvalSha256)) || readAudit(root).some((event) =>
    event.intent === id && (event.event === "no" || event.event === "done") &&
    (typeof event.approval_sha256 !== "string" || event.approval_sha256 === approvalSha256),
  );
}
