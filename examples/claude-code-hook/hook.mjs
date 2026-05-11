#!/usr/bin/env node
/**
 * Materios orynq auto-trace hook for Claude Code.
 *
 * Persistent per-task anchoring: every PostToolUse(TaskUpdate, status=completed)
 * event atomically writes ONE bundle to the queue/ directory. A separate drain
 * daemon (drain.mjs) submits the queue to Materios as certified receipts.
 *
 * This survives session crashes, multi-day Claude Code sessions, and reboots —
 * the hook returns in <10ms (file-write only, no network IO, no SDK imports).
 *
 * Config:
 *   ORYNQ_NO_AUTO_TRACE=1               disable entirely
 *   ORYNQ_HOOK_ENV=/path/to/envfile     override env file path (default: ~/.materios-orynq-hook.env)
 *   ORYNQ_SDK_PATH=/path/to/orynq-sdk   (read by drain.mjs, ignored here)
 *
 *   MATERIOS_RPC_URL, MATERIOS_SIGNER_URI, MATERIOS_BLOB_GATEWAY_URL
 *     — only consumed by drain.mjs. The hook just queues.
 */

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

if (process.env.ORYNQ_NO_AUTO_TRACE === "1") process.exit(0);

const HOME = process.env.HOME || process.env.USERPROFILE || "/home/deci";
const ENV_FILE = process.env.ORYNQ_HOOK_ENV || path.join(HOME, ".materios-orynq-hook.env");
const STATE_DIR = path.join(HOME, ".local/state/materios-orynq-hook");
const QUEUE_DIR = path.join(STATE_DIR, "queue");

function loadEnvFile(file) {
  try {
    for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
  } catch { /* file absent is fine */ }
}
loadEnvFile(ENV_FILE);

// ---------- redaction ----------
const REDACT_PATTERNS = [
  { re: /\bxpub[A-HJ-NP-Za-km-z1-9]{79,}\b/g, rep: "[REDACTED-XPUB]" },
  { re: /\b(mnemonic|seed[ _]phrase|private[ _]key|api[ _]key|signer[ _]uri)\s*[:=]\s*\S+/gi, rep: "[REDACTED-SECRET]" },
  { re: /\b[a-f0-9]{64}\b/gi, rep: "[REDACTED-32B-HEX]" },
];
function looksLikeBip39(s) {
  const m = s.match(/\b([a-z]+\s+){11,}[a-z]+\b/g);
  if (!m) return null;
  return m.find((chunk) => {
    const words = chunk.trim().split(/\s+/);
    return words.length >= 12 && words.every((w) => w.length >= 3 && w.length <= 8);
  });
}
function redact(s) {
  if (!s || typeof s !== "string") return s;
  let out = s;
  for (const { re, rep } of REDACT_PATTERNS) out = out.replace(re, rep);
  const mn = looksLikeBip39(out);
  if (mn) out = out.replace(mn, "[REDACTED-MNEMONIC-SHAPED]");
  return out;
}
function truncate(s, max = 2048) {
  if (!s) return s;
  const str = String(s);
  return str.length <= max ? str : str.slice(0, max) + `... [+${str.length - max} chars]`;
}

// ---------- I/O helpers ----------
async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const s = Buffer.concat(chunks).toString("utf-8").trim();
  return s ? JSON.parse(s) : {};
}
async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }

function isTaskUpdateCompleted(input) {
  if (input.tool_name !== "TaskUpdate") return false;
  const ti = input.tool_input || {};
  return ti.status === "completed";
}

// ---------- queue write (the load-bearing path) ----------
function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
}

/**
 * Build a deterministic queue entry from a TaskUpdate completed event.
 *
 * Determinism: rootHash is sha256 of {sessionId, taskId, timestamp, subject, summary}.
 * Re-running the same closure produces the same hash → idempotent at chain level.
 */
export function buildQueueEntry(input, nowIso) {
  const ti = input.tool_input || {};
  const resp = input.tool_response || {};
  const sessionId = input.session_id || "unknown-session";
  const taskId = String(ti.taskId ?? ti.task_id ?? "unknown");
  const subject = resp.subject || ti.subject || `Task ${taskId}`;
  const activeForm = resp.activeForm || ti.activeForm || "";
  const timestamp = nowIso || new Date().toISOString();

  const summary = redact(truncate(JSON.stringify({
    taskId,
    subject,
    activeForm,
    description: resp.description || ti.description || null,
    owner: resp.owner || ti.owner || null,
    blocks: resp.blocks || null,
    blockedBy: resp.blockedBy || null,
  }), 1800));

  const publicView = {
    taskId,
    subject: redact(truncate(subject, 200)),
    sessionId,
    timestamp,
    summary,
    cwd: input.cwd || null,
    hostname: os.hostname(),
  };

  // Canonical content: the exact bytes the drain daemon uploads to the
  // blob gateway. cert-daemon's schema-aware verifier (operator-kit
  // daemon/schemas/orynq_trace.py) requires sha256(uploaded bytes) ==
  // on-chain content_hash so the JSON bytes are byte-pinned by the
  // receipt. The hook must therefore hash exactly what drain uploads —
  // not a different envelope shape. Drain reads `entry.content` and
  // uploads it verbatim; doing the construction here keeps both sides
  // in lockstep without duplicating field-selection logic.
  //
  // Five fields chosen to give the trace a stable closure-defining
  // identity (same task closed twice → same hash → idempotent on chain).
  // Fields use publicView's redacted forms so the upload + on-chain
  // commitment never expose redacted content.
  const content = JSON.stringify({
    sessionId: publicView.sessionId,
    taskId: publicView.taskId,
    timestamp: publicView.timestamp,
    subject: publicView.subject,
    summary: publicView.summary,
  });
  const contentHash = sha256Hex(content);

  return {
    schemaVersion: "queue/2.0",
    content,
    contentHash,
    rootHash: contentHash,
    manifestHash: contentHash,
    publicView,
    raw: {
      hook_event_name: input.hook_event_name,
      tool_name: input.tool_name,
      tool_input: ti,
      tool_response: resp,
    },
  };
}

/**
 * Atomically write a queue entry under STATE_DIR/queue/.
 * Filename: <ISO-timestamp>-task-<taskId>.json (sortable chronologically).
 * Uses .tmp + rename for atomicity (drain daemon may be polling concurrently).
 */
export async function writeQueueEntry(entry) {
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

// ---------- main ----------
async function main() {
  const input = await readStdinJson();
  const event = input.hook_event_name;
  if (!event) return;

  if (event === "PostToolUse" && isTaskUpdateCompleted(input)) {
    const entry = buildQueueEntry(input);
    const written = await writeQueueEntry(entry);
    // Single-line log; harmless if Claude Code captures stderr.
    console.error(`[orynq-hook] queued ${path.basename(written)}`);
    return;
  }

  if (event === "SessionEnd") {
    // Per-task drain replaces SessionEnd batching. No-op kept for backward-compat:
    // legacy session state files (~/.local/state/materios-orynq-hook/<sid>.json)
    // are intentionally left in place — flush-session.mjs handles them.
    console.error(`[orynq-hook] SessionEnd is now a no-op (per-task drain in effect)`);
    return;
  }

  // Other events: silently ignore.
}

main().catch((e) => {
  console.error(`[orynq-hook] fatal: ${e?.stack || e}`);
  process.exit(0); // never break the user's workflow
});
