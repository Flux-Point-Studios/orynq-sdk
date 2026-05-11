#!/usr/bin/env node
/**
 * Materios orynq drain daemon.
 *
 * Watches ~/.local/state/materios-orynq-hook/queue/ for queue entries dropped
 * by hook.mjs (one per Claude Code task closure) and submits each one to
 * Materios as a certified receipt via @orynq/anchors-materios.
 *
 * Sequential: one submit at a time (low volume + cert-daemon throttles anyway).
 * On success: queue/<file> -> done/<file> (with receipt info appended).
 * On failure: queue/<file> -> failed/<file> + sibling .error.txt.
 *
 * Watches via fs.watch; 5s poll fallback for filesystems that miss events.
 * After 3 consecutive submit failures, sleeps 60s before retrying.
 *
 * Config (read from ~/.materios-orynq-hook.env, same as hook.mjs):
 *   MATERIOS_RPC_URL, MATERIOS_SIGNER_URI, MATERIOS_BLOB_GATEWAY_URL,
 *   MATERIOS_BLOB_GATEWAY_API_KEY (optional)
 *
 *   ORYNQ_SDK_PATH=/path/to/orynq-sdk (default /tmp/orynq-sdk)
 *   ORYNQ_DRAIN_DRY_RUN=1 — log "would submit" and skip the network call
 *   ORYNQ_DRAIN_POLL_MS=5000 — poll fallback interval
 *
 * Chain-aware anchor backstop (defends against cert-daemon stalls without
 * producing duplicate Cardano anchors in healthy operation):
 *
 *   After successful certification we drop a sentinel into pending-anchor/
 *   carrying { contentHash, rootHash, manifestHash, certHash, blockNum, dueAt }.
 *   A periodic sweep treats any sentinel past dueAt
 *   (ORYNQ_DRAIN_ANCHOR_BACKSTOP_MS, default 600_000 = 10 min) as a candidate
 *   for the backstop. Before POSTing /anchor it consults cert-daemon's
 *   authoritative state via two read-only sources:
 *
 *     1. /data/checkpoint-history.json (read via `docker exec ... cat`).
 *        cert-daemon only appends to this file AFTER its `_submit_to_cardano`
 *        returns 200 (see /app/daemon/checkpoint.py:209-211 in container
 *        materios-node-cert-daemon-preprod-1). So presence of our sentinel's
 *        certHash in any batch's leaves[].cert_hash means cert-daemon already
 *        anchored — we must NOT POST. Sentinel is deleted, log says "skipped".
 *
 *     2. cert-daemon's metrics endpoint (curl http://127.0.0.1:8081/metrics).
 *        The line `materios_cert_daemon_last_processed_block <N>` tells us how
 *        far cert-daemon has scanned. Only when N >= sentinel.blockNum + 30 do
 *        we treat absence-from-history as "cert-daemon had its chance and chose
 *        not to anchor" → wedge → POST /anchor as backstop.
 *
 *   If either probe fails (docker exec error, metrics unreachable), we log a
 *   warning and DO NOT POST — better to retry next sweep than risk a duplicate
 *   anchor when our diagnostic is broken. Sentinel stays past-due.
 *
 *   Note: cert-daemon does NOT persist the resulting Cardano tx_hash in
 *   checkpoint-history.json (verified 2026-05-04 against live container — the
 *   file only has root_hash/manifest_hash/leaves; tx_hash field is absent).
 *   So the chain-aware result reports {anchored, batchRoot, batchTimestamp,
 *   leafBlockNum} but txHash is null.
 *
 *   ANCHOR_WORKER_URL=http://127.0.0.1:3333 (default)
 *   ANCHOR_WORKER_TOKEN_FILE=$HOME/materios-anchor-worker/.anchor-worker-token (default)
 *   ANCHOR_WORKER_TOKEN=<token>                       — overrides the token file
 *   ORYNQ_DRAIN_ANCHOR_BACKSTOP_MS=600000             — backstop delay (10 min)
 *   ORYNQ_DRAIN_ANCHOR_DISABLED=1                     — disable backstop entirely
 *   ORYNQ_DRAIN_CERT_DAEMON_CONTAINER=materios-node-cert-daemon-preprod-1
 *   ORYNQ_DRAIN_CERT_DAEMON_METRICS_URL=http://127.0.0.1:8081/metrics
 *   ORYNQ_DRAIN_CERT_DAEMON_LEAD_BLOCKS=30            — N: cert-daemon must be
 *                                                       this many blocks past
 *                                                       sentinel.blockNum to
 *                                                       allow the backstop POST.
 */

import fs from "node:fs/promises";
import { readFileSync, watch as fsWatch } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const HOME = process.env.HOME || process.env.USERPROFILE || "/home/deci";
const ENV_FILE = process.env.ORYNQ_HOOK_ENV || path.join(HOME, ".materios-orynq-hook.env");
const ORYNQ_SDK = process.env.ORYNQ_SDK_PATH || "/tmp/orynq-sdk";
const STATE_DIR = path.join(HOME, ".local/state/materios-orynq-hook");
const QUEUE_DIR = path.join(STATE_DIR, "queue");
const DONE_DIR = path.join(STATE_DIR, "done");
const FAILED_DIR = path.join(STATE_DIR, "failed");
const PENDING_ANCHOR_DIR = path.join(STATE_DIR, "pending-anchor");
const POLL_MS = Number(process.env.ORYNQ_DRAIN_POLL_MS || 5000);
const DRY_RUN = process.env.ORYNQ_DRAIN_DRY_RUN === "1";

// Schema discriminator for orynq trace receipts. cert-daemon's
// daemon/schemas/orynq_trace.py defines this same constant; the value MUST
// stay byte-for-byte in lockstep. Computed as sha256("orynq_trace_v1") in
// the Python module; we hardcode the pre-computed hex here to avoid a
// runtime crypto import in this hot path. If you change this, also update:
//   - operator-kit/daemon/schemas/orynq_trace.py::SCHEMA_HASH_ORYNQ_TRACE_V1
//   - operator-kit TRUSTED_DISCRIMINATOR_SCHEMAS set
// (and ship both side-by-side or cert-daemon will reject every receipt).
const SCHEMA_HASH_ORYNQ_TRACE_V1 =
  "0xcab0f81814eb84c9338938e702c8e8854c6cb17b371a9fd784a08e41c75d71b5";

// Anchor backstop config
const ANCHOR_WORKER_URL = process.env.ANCHOR_WORKER_URL || "http://127.0.0.1:3333";
const ANCHOR_WORKER_TOKEN_FILE = process.env.ANCHOR_WORKER_TOKEN_FILE
  || path.join(HOME, "materios-anchor-worker", ".anchor-worker-token");
const ANCHOR_BACKSTOP_MS = Number(process.env.ORYNQ_DRAIN_ANCHOR_BACKSTOP_MS || 600_000);
const ANCHOR_BACKSTOP_DISABLED = process.env.ORYNQ_DRAIN_ANCHOR_DISABLED === "1";
const ANCHOR_BACKSTOP_SWEEP_MS = 60_000;

// Chain-aware backstop config
const CERT_DAEMON_CONTAINER = process.env.ORYNQ_DRAIN_CERT_DAEMON_CONTAINER
  || "materios-node-cert-daemon-preprod-1";
const CERT_DAEMON_HISTORY_PATH = process.env.ORYNQ_DRAIN_CERT_DAEMON_HISTORY_PATH
  || "/data/checkpoint-history.json";
const CERT_DAEMON_METRICS_URL = process.env.ORYNQ_DRAIN_CERT_DAEMON_METRICS_URL
  || "http://127.0.0.1:8081/metrics";
const CERT_DAEMON_LEAD_BLOCKS = Number(process.env.ORYNQ_DRAIN_CERT_DAEMON_LEAD_BLOCKS || 30);

// Reuse hook.mjs's env-loader pattern (deliberate small duplication, < 30 lines).
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

function log(msg) {
  console.log(`[orynq-drain] ${new Date().toISOString()} ${msg}`);
}

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }
async function ensureDirs() {
  await ensureDir(QUEUE_DIR);
  await ensureDir(DONE_DIR);
  await ensureDir(FAILED_DIR);
  await ensureDir(PENDING_ANCHOR_DIR);
}

// ---------- anchor backstop ----------

let cachedAnchorToken = null;
function getAnchorToken() {
  if (cachedAnchorToken !== null) return cachedAnchorToken;
  if (process.env.ANCHOR_WORKER_TOKEN) {
    cachedAnchorToken = process.env.ANCHOR_WORKER_TOKEN.trim();
    return cachedAnchorToken;
  }
  try {
    cachedAnchorToken = readFileSync(ANCHOR_WORKER_TOKEN_FILE, "utf-8").trim();
  } catch (e) {
    log(`warn: could not read anchor token from ${ANCHOR_WORKER_TOKEN_FILE}: ${e?.message || e}`);
    cachedAnchorToken = "";
  }
  return cachedAnchorToken;
}

/**
 * Resolve a Materios block-hash to its block number via JSON-RPC.
 * Returns the integer block number, or null if the lookup fails (we keep the
 * sentinel writable in that case; the chain-aware sweep will treat blockNum
 * absent as "skip the lead-blocks gate" and stay in conservative no-POST mode).
 */
async function resolveBlockNumber(blockHash) {
  if (!blockHash || typeof blockHash !== "string") return null;
  const rpcUrl = process.env.MATERIOS_RPC_URL;
  if (!rpcUrl) return null;
  // Materios RPC may be ws:// — translate to http:// for one-shot fetch.
  const httpUrl = rpcUrl.replace(/^ws(s?):\/\//, "http$1://");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(httpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "chain_getHeader",
        params: [blockHash],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const numHex = j?.result?.number;
    if (!numHex) return null;
    return parseInt(String(numHex).replace(/^0x/, ""), 16) || null;
  } catch {
    return null;
  }
}

/**
 * Write a sentinel marking a receipt as awaiting anchor confirmation.
 * Sweeper picks it up after ANCHOR_BACKSTOP_MS and runs a chain-aware check
 * (cert-daemon's checkpoint-history + metrics) before deciding whether to POST.
 *
 * Sentinel filename mirrors the queue entry so we can correlate by eyeball.
 * Body is small JSON with everything /anchor needs PLUS certHash + blockNum
 * for the chain-aware check.
 */
async function writePendingAnchor(baseName, entry, anchored) {
  if (ANCHOR_BACKSTOP_DISABLED) return;
  // Resolve block number once at sentinel write time so the sweeper doesn't
  // have to keep an RPC connection open. Acceptable for the hash to be null
  // (older sentinels written before this change, or RPC unreachable).
  const blockNum = await resolveBlockNumber(anchored?.blockHash);
  const sentinel = {
    schemaVersion: "pending-anchor/2.0",
    contentHash: entry.contentHash ?? entry.rootHash,
    rootHash: entry.rootHash,
    manifestHash: entry.manifestHash ?? entry.rootHash,
    certHash: anchored?.certHash || null,
    blockHash: anchored?.blockHash || null,
    blockNum,
    receiptId: anchored?.receiptId || null,
    queueEntry: baseName,
    queuedAt: new Date().toISOString(),
    dueAt: new Date(Date.now() + ANCHOR_BACKSTOP_MS).toISOString(),
  };
  const dest = path.join(PENDING_ANCHOR_DIR, baseName);
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(sentinel, null, 2), "utf-8");
    await fs.rename(tmp, dest);
  } catch (e) {
    log(`warn: could not write pending-anchor sentinel for ${baseName}: ${e?.message || e}`);
  }
}

// ---------- chain-aware backstop diagnostics ----------

/**
 * Normalize a Materios cert hash for comparison against checkpoint-history.
 * SDK returns 0x-prefixed hex; cert-daemon writes naked hex; both are lowercase
 * but we normalize defensively. Returns "" for falsy/non-string input.
 */
function normalizeCertHash(h) {
  if (!h || typeof h !== "string") return "";
  const t = h.trim().toLowerCase();
  return t.startsWith("0x") ? t.slice(2) : t;
}

/**
 * Read cert-daemon's checkpoint-history.json from inside the docker container.
 * Returns the parsed array on success, null on any failure (caller treats null
 * as "diagnostic broken — do not POST").
 *
 * Uses execFile (no shell) per the project's Cardano-tx-chaining lesson about
 * never inlining content in shell-quoted strings.
 */
async function readCertDaemonHistory() {
  try {
    const { stdout } = await execFile(
      "docker",
      ["exec", CERT_DAEMON_CONTAINER, "cat", CERT_DAEMON_HISTORY_PATH],
      { maxBuffer: 64 * 1024 * 1024, timeout: 15_000 },
    );
    const data = JSON.parse(stdout);
    return Array.isArray(data) ? data : null;
  } catch (e) {
    log(`chain-check: docker exec / parse failed: ${e?.message || e}`);
    return null;
  }
}

/**
 * Fetch cert-daemon's last_processed_block from its Prometheus-style metrics
 * endpoint. Returns the integer block number on success, null on any failure.
 */
async function readCertDaemonHead() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    const res = await fetch(CERT_DAEMON_METRICS_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/^materios_cert_daemon_last_processed_block\s+(\d+)/m);
    if (!m) return null;
    return parseInt(m[1], 10);
  } catch (e) {
    log(`chain-check: metrics fetch failed: ${e?.message || e}`);
    return null;
  }
}

/**
 * Search the cert-daemon batch history for a leaf matching `certHash`.
 * Returns the first matching {batchIndex, batchRoot, batchTimestamp,
 * leafBlockNum} or null if not found.
 */
function findCertHashInHistory(history, certHash) {
  const target = normalizeCertHash(certHash);
  if (!target || !Array.isArray(history)) return null;
  for (let i = 0; i < history.length; i++) {
    const batch = history[i];
    const leaves = Array.isArray(batch?.leaves) ? batch.leaves : [];
    for (const leaf of leaves) {
      if (normalizeCertHash(leaf?.cert_hash) === target) {
        return {
          batchIndex: i,
          batchRoot: batch.root_hash || null,
          batchTimestamp: batch.timestamp ?? null,
          leafBlockNum: leaf.block_num ?? null,
        };
      }
    }
  }
  return null;
}

/**
 * Chain-aware check: should we POST /anchor for this sentinel?
 *
 * Returns one of:
 *   { decision: "skip-anchored", anchored: { batchRoot, batchTimestamp,
 *                                             leafBlockNum, txHash: null } }
 *   { decision: "skip-too-early", certDaemonHead, leadShortBy }
 *   { decision: "skip-diagnostic-broken", reason }
 *   { decision: "post", certDaemonHead, leadBlocks, anchored: null }
 *
 * Notes:
 *   - txHash is always null because cert-daemon does not persist the resulting
 *     Cardano tx_hash to checkpoint-history.json (verified 2026-05-04 against
 *     live container — only root_hash + manifest + leaves are stored). Callers
 *     that need the tx_hash must look it up via the anchor-worker's status
 *     endpoint or block-explorer; the chain-aware check only confirms anchor
 *     completion (presence in history ⇒ /anchor returned 200 to cert-daemon).
 *   - Sentinels missing certHash (legacy schemaVersion < 2.0) get
 *     skip-diagnostic-broken so they fall through to the next sweep without
 *     risking a dupe POST.
 */
async function chainAwareDecision(sentinel) {
  if (!sentinel?.certHash) {
    return { decision: "skip-diagnostic-broken", reason: "sentinel missing certHash (legacy v1?)" };
  }

  const history = await readCertDaemonHistory();
  if (history === null) {
    return { decision: "skip-diagnostic-broken", reason: "cert-daemon history unreadable" };
  }
  const hit = findCertHashInHistory(history, sentinel.certHash);
  if (hit) {
    return {
      decision: "skip-anchored",
      anchored: {
        batchRoot: hit.batchRoot,
        batchTimestamp: hit.batchTimestamp,
        leafBlockNum: hit.leafBlockNum,
        txHash: null,
      },
    };
  }

  const head = await readCertDaemonHead();
  if (head === null) {
    return { decision: "skip-diagnostic-broken", reason: "cert-daemon metrics unreachable" };
  }

  // If we don't know the receipt's block number, we can't apply the lead-blocks
  // gate safely. Stay conservative — don't POST.
  if (!Number.isFinite(sentinel.blockNum) || sentinel.blockNum == null) {
    return { decision: "skip-diagnostic-broken", reason: "sentinel missing blockNum" };
  }

  const required = sentinel.blockNum + CERT_DAEMON_LEAD_BLOCKS;
  if (head < required) {
    return {
      decision: "skip-too-early",
      certDaemonHead: head,
      leadShortBy: required - head,
    };
  }

  return {
    decision: "post",
    certDaemonHead: head,
    leadBlocks: head - sentinel.blockNum,
    anchored: null,
  };
}

/**
 * POST /anchor as backstop. Anchor-worker rejects payloads containing BIP39
 * mnemonic-shaped strings; our payload only carries hex hashes so we're safe.
 * Returns true on 200, false otherwise (caller decides whether to retry).
 */
async function postAnchorBackstop(sentinel) {
  const token = getAnchorToken();
  if (!token) {
    log("backstop POST aborted: anchor-worker token unreadable");
    return false;
  }
  const url = `${ANCHOR_WORKER_URL.replace(/\/+$/, "")}/anchor`;
  const body = JSON.stringify({
    contentHash: sentinel.contentHash,
    rootHash: sentinel.rootHash,
    manifestHash: sentinel.manifestHash,
  });
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": token,
      },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status === 200) {
      const data = await res.json().catch(() => ({}));
      log(`backstop OK ${sentinel.queueEntry} root=${sentinel.rootHash.slice(0, 10)}... txHash=${data?.txHash || data?.cardanoTxHash || "?"}`);
      return true;
    }
    const text = await res.text().catch(() => "");
    log(`backstop FAIL ${sentinel.queueEntry} status=${res.status} body=${text.slice(0, 200)}`);
    return false;
  } catch (e) {
    log(`backstop ERROR ${sentinel.queueEntry}: ${e?.message || e}`);
    return false;
  }
}

let sweeping = false;

/**
 * Sweep pending-anchor/ for sentinels past their dueAt. For each, run a
 * chain-aware decision against cert-daemon's checkpoint-history + metrics:
 *
 *   - Already anchored by cert-daemon  → delete sentinel, no POST.
 *   - Past due but cert-daemon hasn't reached our block + lead-blocks → wait.
 *   - Diagnostic broken (docker exec / metrics fail / missing fields) → wait.
 *   - Past due AND cert-daemon should have anchored but didn't → POST /anchor.
 *
 * Single-pass per sweep tick. No exponential backoff: in healthy operation the
 * backstop never fires; if it does fire repeatedly the operator needs a real
 * diagnosis, not auto-recovery.
 */
async function sweepPendingAnchors() {
  if (sweeping || ANCHOR_BACKSTOP_DISABLED) return;
  sweeping = true;
  try {
    let entries;
    try { entries = await fs.readdir(PENDING_ANCHOR_DIR); }
    catch { return; }
    const now = Date.now();
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const sentinelPath = path.join(PENDING_ANCHOR_DIR, name);
      let sentinel;
      try {
        sentinel = JSON.parse(await fs.readFile(sentinelPath, "utf-8"));
      } catch (e) {
        log(`sweep: unreadable sentinel ${name}: ${e?.message || e} — moving aside`);
        try { await fs.rename(sentinelPath, sentinelPath + ".broken"); } catch { /* ignore */ }
        continue;
      }
      const dueAt = Date.parse(sentinel.dueAt || "");
      if (!Number.isFinite(dueAt) || dueAt > now) continue;

      const certShort = (sentinel.certHash || "").slice(0, 12);
      const decision = await chainAwareDecision(sentinel);
      switch (decision.decision) {
        case "skip-anchored": {
          const a = decision.anchored || {};
          log(
            `chain-check ${name} cert=${certShort}... already anchored by cert-daemon `
            + `(batchRoot=${(a.batchRoot || "").slice(0, 10)}..., leafBlock=${a.leafBlockNum}) — deleting sentinel`,
          );
          try { await fs.unlink(sentinelPath); }
          catch (e) { log(`sweep: could not unlink ${name}: ${e?.message || e}`); }
          break;
        }
        case "skip-too-early": {
          log(
            `chain-check ${name} cert=${certShort}... cert-daemon head=${decision.certDaemonHead} `
            + `< sentinel.blockNum+${CERT_DAEMON_LEAD_BLOCKS} (short by ${decision.leadShortBy}) — wait`,
          );
          break;
        }
        case "skip-diagnostic-broken": {
          log(`chain-check ${name} cert=${certShort}... DIAGNOSTIC BROKEN: ${decision.reason} — not posting (will retry)`);
          break;
        }
        case "post": {
          log(
            `backstop firing for ${name} (queued ${sentinel.queuedAt}, root=${(sentinel.rootHash || "").slice(0, 10)}..., `
            + `cert=${certShort}..., cert-daemon head=${decision.certDaemonHead} leadBlocks=${decision.leadBlocks})`,
          );
          const ok = await postAnchorBackstop(sentinel);
          if (ok) {
            try { await fs.unlink(sentinelPath); }
            catch (e) { log(`sweep: could not unlink ${name}: ${e?.message || e}`); }
          }
          break;
        }
        default:
          log(`chain-check ${name}: unknown decision ${decision.decision} — staying conservative (no POST)`);
      }
    }
  } catch (e) {
    log(`sweep: unexpected error: ${e?.stack || e}`);
  } finally {
    sweeping = false;
  }
}

let cachedSdk = null;
async function importOrynq() {
  if (cachedSdk) return cachedSdk;
  const am = await import(pathToFileURL(path.join(ORYNQ_SDK, "packages/anchors-materios/dist/index.js")).href);
  cachedSdk = { am };
  return cachedSdk;
}

let cachedProvider = null;
async function getProvider() {
  if (cachedProvider) return cachedProvider;
  const { am } = await importOrynq();
  const rpcUrl = process.env.MATERIOS_RPC_URL;
  const signerUri = process.env.MATERIOS_SIGNER_URI;
  if (!rpcUrl || !signerUri) {
    throw new Error("MATERIOS_RPC_URL or MATERIOS_SIGNER_URI not set");
  }
  const provider = new am.MateriosProvider({ rpcUrl, signerUri });
  await provider.connect();
  cachedProvider = provider;
  return provider;
}

async function disconnectProvider() {
  if (!cachedProvider) return;
  try { await cachedProvider.disconnect(); } catch { /* ignore */ }
  cachedProvider = null;
}

/** Atomic move (rename) with conflict-resolving suffix. */
async function moveFile(src, destDir, baseName) {
  let dest = path.join(destDir, baseName);
  try {
    await fs.rename(src, dest);
    return dest;
  } catch (e) {
    if (e.code === "EEXIST") {
      dest = path.join(destDir, `${baseName}.${Date.now()}`);
      await fs.rename(src, dest);
      return dest;
    }
    throw e;
  }
}

/**
 * Submit one queue entry to Materios.
 * Returns { ok: true, anchored } or { ok: false, error }.
 */
async function submitQueueEntry(filePath) {
  let entry;
  try {
    const text = await fs.readFile(filePath, "utf-8");
    entry = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `unreadable: ${e?.message || e}` };
  }

  if (!entry.rootHash || !entry.publicView) {
    return { ok: false, error: "malformed queue entry: missing rootHash or publicView" };
  }

  if (DRY_RUN) {
    log(`DRY-RUN would submit ${path.basename(filePath)} rootHash=${entry.rootHash} task=${entry.publicView.taskId}`);
    return { ok: true, anchored: { dryRun: true } };
  }

  const { am } = await importOrynq();
  const provider = await getProvider();

  // Canonical content: exactly the bytes hook.mjs hashed into
  // entry.contentHash. cert-daemon's schema-aware verifier requires
  // sha256(uploaded bytes) == on-chain content_hash, so we MUST upload
  // the same bytes the hook hashed — not a derived envelope. For
  // queue/2.0 entries the hook ships `entry.content` directly. Older
  // queue/1.0 entries pre-date this convention; their on-chain
  // content_hash was computed over a different shape and the chunk-merkle
  // check can never satisfy. Skip them out to the failure path.
  if (!entry.content) {
    return {
      ok: false,
      error: "queue entry missing `content` (pre-2026-05-11 queue/1.0 shape); cert-daemon chunk-merkle pin cannot be satisfied — dropping",
    };
  }
  const content = Buffer.from(entry.content, "utf-8");

  const gatewayUrl = process.env.MATERIOS_BLOB_GATEWAY_URL || "https://materios.fluxpointstudios.com/preprod-blobs";
  const gatewayApiKey = process.env.MATERIOS_BLOB_GATEWAY_API_KEY;

  const keypair = provider.getKeypair();
  const blobGateway = { baseUrl: gatewayUrl };
  if (gatewayApiKey) blobGateway.apiKey = gatewayApiKey;
  else blobGateway.signerKeypair = {
    address: keypair.address,
    sign: (msg) => keypair.sign(msg),
  };

  const result = await am.submitCertifiedReceipt(
    provider,
    {
      contentHash: entry.contentHash ?? entry.rootHash,
      rootHash: entry.rootHash,
      manifestHash: entry.manifestHash ?? entry.rootHash,
      // Tag this receipt class for cert-daemon's schema-aware verifier
      // (operator-kit daemon/schemas/orynq_trace.py). Without this tag,
      // cert-daemon recomputes chunk-Merkle of the JSON-encoded publicView
      // and rejects because the gateway's chunk-Merkle != rootHash (the
      // semantic trace Merkle). Tagging routes us to the trust-the-
      // discriminator path where chunk integrity pins the JSON bytes and
      // base_root_sha256 is accepted as the trace's semantic Merkle root.
      // Value = sha256("orynq_trace_v1"); MUST stay byte-for-byte in
      // lockstep with daemon/schemas/orynq_trace.SCHEMA_HASH_ORYNQ_TRACE_V1.
      schemaHash: SCHEMA_HASH_ORYNQ_TRACE_V1,
    },
    content,
    {
      blobGateway,
      certificationPollOpts: { timeoutMs: 90_000 },
    }
  );
  return {
    ok: true,
    anchored: {
      receiptId: result.receiptId,
      certHash: result.certHash || null,
      blockHash: result.blockHash || null,
      confirmed: result.confirmed !== false,
    },
  };
}

/** List queue/ entries (chronologically by filename). */
async function listQueue() {
  let entries;
  try { entries = await fs.readdir(QUEUE_DIR); }
  catch { return []; }
  return entries
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => path.join(QUEUE_DIR, n));
}

let consecutiveFailures = 0;
let processing = false;

/** Drain the queue once, sequentially. */
async function drainOnce() {
  if (processing) return;
  processing = true;
  try {
    while (true) {
      const list = await listQueue();
      if (list.length === 0) break;
      const file = list[0];
      const baseName = path.basename(file);
      log(`processing ${baseName} (queue depth ${list.length})`);

      let result;
      try {
        result = await submitQueueEntry(file);
      } catch (e) {
        result = { ok: false, error: e?.stack || String(e) };
      }

      if (result.ok) {
        consecutiveFailures = 0;
        // Snapshot the entry once for both annotation + backstop sentinel.
        let parsedEntry = null;
        try {
          const text = await fs.readFile(file, "utf-8");
          parsedEntry = JSON.parse(text);
        } catch (e) {
          log(`warn: could not read ${baseName} for annotation: ${e?.message || e}`);
        }
        // Annotate with receipt info before moving.
        if (parsedEntry) {
          try {
            parsedEntry.anchored = result.anchored;
            parsedEntry.anchoredAt = new Date().toISOString();
            await fs.writeFile(file, JSON.stringify(parsedEntry, null, 2), "utf-8");
          } catch (e) {
            log(`warn: could not annotate ${baseName}: ${e?.message || e}`);
          }
        }
        const moved = await moveFile(file, DONE_DIR, baseName);
        log(`done ${baseName} -> ${moved}  receipt=${result.anchored?.receiptId || "(dry-run)"}`);
        // Drop a backstop sentinel — the cert-daemon will normally anchor
        // within 2-3 min, but if it's wedged the sweeper POSTs /anchor at
        // dueAt. Skipped for dry-run to keep the queue clean.
        if (parsedEntry && !DRY_RUN) {
          await writePendingAnchor(baseName, parsedEntry, result.anchored);
        }
      } else {
        consecutiveFailures += 1;
        log(`FAIL ${baseName}: ${result.error}`);
        const errPath = path.join(FAILED_DIR, `${baseName}.error.txt`);
        try { await fs.writeFile(errPath, String(result.error), "utf-8"); } catch { /* best-effort */ }
        try { await moveFile(file, FAILED_DIR, baseName); } catch (e) {
          log(`warn: could not move failed entry: ${e?.message || e}`);
        }

        if (consecutiveFailures >= 3) {
          log(`backing off 60s (consecutive failures = ${consecutiveFailures})`);
          // Drop the WS provider — it may be wedged.
          await disconnectProvider();
          await sleep(60_000);
          consecutiveFailures = 0;
        }
      }
    }
  } finally {
    processing = false;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let drainScheduled = false;
function scheduleDrain() {
  if (drainScheduled) return;
  drainScheduled = true;
  setImmediate(async () => {
    drainScheduled = false;
    try { await drainOnce(); }
    catch (e) { log(`drain loop error: ${e?.stack || e}`); }
  });
}

async function main() {
  await ensureDirs();
  log(`starting; queue=${QUEUE_DIR} sdk=${ORYNQ_SDK} dryRun=${DRY_RUN}`);

  // Initial drain.
  scheduleDrain();

  // fs.watch: trigger a drain whenever a new file appears.
  let watcher;
  try {
    watcher = fsWatch(QUEUE_DIR, { persistent: true }, (eventType, filename) => {
      if (filename && filename.endsWith(".json")) scheduleDrain();
    });
  } catch (e) {
    log(`warn: fs.watch failed (${e?.message || e}); relying on poll fallback`);
  }

  // Poll fallback: covers filesystems that miss inotify events (NFS, etc).
  setInterval(() => scheduleDrain(), POLL_MS).unref();

  // Anchor backstop sweeper. Independent of drain so a wedged provider
  // never starves the L1 backstop path.
  if (!ANCHOR_BACKSTOP_DISABLED) {
    log(
      `chain-aware-backstop-armed delay=${ANCHOR_BACKSTOP_MS}ms sweep=${ANCHOR_BACKSTOP_SWEEP_MS}ms `
      + `target=${ANCHOR_WORKER_URL}/anchor cert-daemon=${CERT_DAEMON_CONTAINER} `
      + `metrics=${CERT_DAEMON_METRICS_URL} leadBlocks=${CERT_DAEMON_LEAD_BLOCKS}`,
    );
    // Initial sweep covers any sentinels left over from a prior process.
    setImmediate(() => { sweepPendingAnchors().catch((e) => log(`sweep init: ${e?.stack || e}`)); });
    setInterval(() => {
      sweepPendingAnchors().catch((e) => log(`sweep tick: ${e?.stack || e}`));
    }, ANCHOR_BACKSTOP_SWEEP_MS).unref();
  } else {
    log("anchor backstop DISABLED via ORYNQ_DRAIN_ANCHOR_DISABLED=1");
  }

  // Graceful shutdown.
  const shutdown = async (sig) => {
    log(`received ${sig}, shutting down`);
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    await disconnectProvider();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Named exports for the test harness. Runtime code never imports drain.mjs;
// the daemon entry path is the bottom guard below. Exporting these doesn't
// change runtime behavior.
export {
  chainAwareDecision,
  findCertHashInHistory,
  normalizeCertHash,
  readCertDaemonHistory,
  readCertDaemonHead,
  resolveBlockNumber,
};

// Run as daemon only when invoked as the main module (node drain.mjs ...).
// Importing this file from a test harness must NOT spawn the daemon.
const isMainModule = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMainModule) {
  main().catch((e) => {
    console.error(`[orynq-drain] fatal: ${e?.stack || e}`);
    process.exit(1); // systemd will Restart=always
  });
}
