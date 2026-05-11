#!/usr/bin/env node
/**
 * One-shot flush of legacy session-state JSON to the per-task queue.
 *
 * Reads ~/.local/state/materios-orynq-hook/<sessionId>.json (written by the
 * pre-drain hook), iterates run.events, and writes one queue entry per
 * task_completed event using the same format hook.mjs now emits.
 *
 * Idempotent: writes a sibling .flushed marker. Re-running for the same
 * session refuses unless --force is passed.
 *
 * Usage:
 *   node flush-session.mjs [<sessionId>] [--force] [--dry-run]
 *
 * Env:
 *   ORYNQ_FLUSH_DRY_RUN=1 — count events but write nothing
 *
 * Usage: pass the Claude Code sessionId as the first positional argument.
 *   node flush-session.mjs 93582ed9-742f-45d3-9e79-74b6bf1ef9fa
 *   node flush-session.mjs <session-id> --dry-run
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const STATE_DIR = path.join(HOME, ".local/state/materios-orynq-hook");
const QUEUE_DIR = path.join(STATE_DIR, "queue");

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DRY_RUN = args.includes("--dry-run") || process.env.ORYNQ_FLUSH_DRY_RUN === "1";
const positional = args.filter((a) => !a.startsWith("--"));
const SESSION_ID = positional[0];
if (!SESSION_ID) {
  console.error("usage: flush-session.mjs <sessionId> [--force] [--dry-run]");
  console.error("       Pass the Claude Code session UUID as the first positional arg.");
  process.exit(2);
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
}
async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }

function truncate(s, max = 2048) {
  if (!s) return s;
  const str = String(s);
  return str.length <= max ? str : str.slice(0, max) + `... [+${str.length - max} chars]`;
}

/** Build the canonical queue entry from a legacy task_completed event. */
function buildEntryFromLegacy(ev, sessionId) {
  const data = ev.data || {};
  const taskId = String(data.taskId ?? "unknown");
  const subject = data.subject || `Task ${taskId}`;
  const summary = data.summary || "";
  const timestamp = ev.timestamp || new Date().toISOString();

  // Same pre-image formula as hook.mjs::buildQueueEntry — keeps rootHash stable.
  const preImage = JSON.stringify({ sessionId, taskId, timestamp, subject, summary });
  const rootHash = sha256Hex(preImage);

  const publicView = {
    taskId,
    subject: truncate(subject, 200),
    sessionId,
    timestamp,
    summary,
    cwd: null,
    hostname: os.hostname(),
    flushedFromLegacy: true,
  };

  return {
    schemaVersion: "queue/1.0",
    contentHash: rootHash,
    rootHash,
    manifestHash: rootHash,
    publicView,
    raw: {
      hook_event_name: "PostToolUse",
      tool_name: "TaskUpdate",
      tool_input: { taskId, status: "completed", subject },
      tool_response: { subject, summary },
      legacyEventId: ev.id || null,
      legacySeq: ev.seq ?? null,
    },
  };
}

async function writeQueueEntry(entry) {
  await ensureDir(QUEUE_DIR);
  const stamp = entry.publicView.timestamp.replace(/[:.]/g, "-");
  const tid = entry.publicView.taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const base = `${stamp}-task-${tid}`;
  const finalPath = path.join(QUEUE_DIR, `${base}.json`);
  const tmpPath = path.join(QUEUE_DIR, `${base}.${process.pid}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(entry, null, 2), "utf-8");
  await fs.rename(tmpPath, finalPath);
  return finalPath;
}

async function main() {
  const statePath = path.join(STATE_DIR, `${SESSION_ID}.json`);
  const flushedMarker = path.join(STATE_DIR, `${SESSION_ID}.flushed`);

  if (!FORCE && !DRY_RUN) {
    try {
      await fs.access(flushedMarker);
      console.error(`refusing to re-flush: ${flushedMarker} exists. Pass --force to override.`);
      process.exit(2);
    } catch { /* not flushed yet */ }
  }

  let raw;
  try { raw = await fs.readFile(statePath, "utf-8"); }
  catch (e) {
    console.error(`cannot read ${statePath}: ${e?.message || e}`);
    process.exit(1);
  }

  let state;
  try { state = JSON.parse(raw); }
  catch (e) {
    console.error(`cannot parse ${statePath}: ${e?.message || e}`);
    process.exit(1);
  }

  const events = state?.run?.events || [];
  let flushed = 0;
  let skipped = 0;
  let errors = 0;

  for (const ev of events) {
    if (ev.kind !== "observation" || ev.observation !== "task_completed") {
      skipped += 1;
      continue;
    }
    try {
      const entry = buildEntryFromLegacy(ev, SESSION_ID);
      if (DRY_RUN) {
        console.log(`[dry-run] would write task=${entry.publicView.taskId} ts=${entry.publicView.timestamp} rootHash=${entry.rootHash}`);
      } else {
        const wp = await writeQueueEntry(entry);
        console.log(`flushed task=${entry.publicView.taskId} -> ${path.basename(wp)}`);
      }
      flushed += 1;
    } catch (e) {
      errors += 1;
      console.error(`error flushing event seq=${ev.seq}: ${e?.message || e}`);
    }
  }

  // Count the queue dir afterward.
  let queueCount = 0;
  try {
    const entries = await fs.readdir(QUEUE_DIR);
    queueCount = entries.filter((n) => n.endsWith(".json")).length;
  } catch { /* dir not yet present */ }

  console.log("");
  console.log(`session:        ${SESSION_ID}`);
  console.log(`state file:     ${statePath}`);
  console.log(`flushed:        ${flushed}`);
  console.log(`skipped:        ${skipped}`);
  console.log(`errors:         ${errors}`);
  console.log(`queue depth:    ${queueCount}`);
  console.log(`dry-run:        ${DRY_RUN}`);

  if (!DRY_RUN && errors === 0 && flushed > 0) {
    await fs.writeFile(flushedMarker, JSON.stringify({
      flushedAt: new Date().toISOString(),
      sessionId: SESSION_ID,
      eventCount: flushed,
    }, null, 2), "utf-8");
    console.log(`wrote marker:   ${flushedMarker}`);
  }
}

main().catch((e) => {
  console.error(`flush-session failed: ${e?.stack || e}`);
  process.exit(1);
});
