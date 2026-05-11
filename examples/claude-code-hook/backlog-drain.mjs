#!/usr/bin/env node
/**
 * Backlog drainer: scan Materios for receipts that are Certified on-chain
 * but absent from the cert-daemon's checkpoint-history.json, and POST each
 * to /anchor in order.
 *
 * NOT triggered automatically. The user runs this manually (after reviewing
 * the proposed list) when the standard pipeline has missed historical
 * receipts — typically after an extended cert-daemon outage or container
 * replacement that lost local history.
 *
 * Default mode is DRY-RUN. Set BACKLOG_APPLY=1 to actually POST.
 *
 * IMPORTANT: this script imports @polkadot/api from the anchor-worker's
 * node_modules. Either run it with the anchor-worker dir as cwd, or set
 * `ANCHOR_WORKER_DIR` so the fallback import can find @polkadot/api:
 *
 *   cd $ANCHOR_WORKER_DIR
 *   node /path/to/examples/claude-code-hook/backlog-drain.mjs                       # dry-run
 *   BACKLOG_APPLY=1 node /path/to/examples/claude-code-hook/backlog-drain.mjs       # apply
 *
 * Config:
 *   MATERIOS_RPC_URL                 — substrate WS endpoint (default = SDK default)
 *   ANCHOR_WORKER_URL=http://127.0.0.1:3333
 *   ANCHOR_WORKER_DIR                — directory with @polkadot/api in node_modules
 *                                      (default $HOME/materios-anchor-worker)
 *   ANCHOR_WORKER_TOKEN_FILE         — default $ANCHOR_WORKER_DIR/.anchor-worker-token
 *   CERT_DAEMON_HISTORY=/data/checkpoint-history.json   inside the docker container
 *   BACKLOG_APPLY=1                  — flip from dry-run to real POSTs
 *   BACKLOG_LIMIT=N                  — cap to N receipts (debug)
 *   BACKLOG_THROTTLE_MS=2000         — gap between POSTs
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const AW_DIR = process.env.ANCHOR_WORKER_DIR || path.join(HOME, "materios-anchor-worker");
const MAT_RPC = process.env.MATERIOS_RPC_URL || "wss://materios.fluxpointstudios.com/preprod-rpc";
const AW_URL = process.env.ANCHOR_WORKER_URL || "http://127.0.0.1:3333";
const AW_TOKEN_FILE = process.env.ANCHOR_WORKER_TOKEN_FILE
  || path.join(AW_DIR, ".anchor-worker-token");
const APPLY = process.env.BACKLOG_APPLY === "1";
const LIMIT = process.env.BACKLOG_LIMIT ? Number(process.env.BACKLOG_LIMIT) : Infinity;
const THROTTLE_MS = Number(process.env.BACKLOG_THROTTLE_MS || 2000);
const CONTAINER = process.env.CERT_DAEMON_CONTAINER || "materios-node-cert-daemon-preprod-1";

function log(msg) {
  console.log(`[backlog] ${new Date().toISOString()} ${msg}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function loadPolkadotApi() {
  // Try cwd first (works when invoked from inside the anchor-worker dir),
  // then fall back to ANCHOR_WORKER_DIR/node_modules.
  try { return await import("@polkadot/api"); } catch { /* fall through */ }
  const { pathToFileURL } = await import("node:url");
  const abs = path.join(AW_DIR, "node_modules", "@polkadot", "api", "index.js");
  return await import(pathToFileURL(abs).href);
}

async function fetchCertifiedFromChain() {
  const { ApiPromise, WsProvider } = await loadPolkadotApi();
  const api = await ApiPromise.create({ provider: new WsProvider(MAT_RPC) });
  log(`connected to ${MAT_RPC}; chain genesis ${api.genesisHash.toHex().slice(0, 18)}...`);
  const entries = await api.query.orinqReceipts.receipts.entries();
  log(`enumerated ${entries.length} receipts on chain`);
  const certified = [];
  for (const [key, value] of entries) {
    const args = key.args;
    const ridBytes = args[0].toU8a();
    const rid = "0x" + Buffer.from(ridBytes).toString("hex");
    const r = value.toJSON();
    const ach = r?.availability_cert_hash || r?.availabilityCertHash;
    if (!ach) continue;
    const achHex = Array.isArray(ach)
      ? ach.map((b) => b.toString(16).padStart(2, "0")).join("")
      : String(ach).replace(/^0x/, "");
    if (/^0+$/.test(achHex)) continue;
    const contentHash = r?.content_hash || r?.contentHash;
    const baseRoot = r?.base_root_sha256 || r?.baseRootSha256;
    const manifestHash = r?.storage_locator_hash || r?.storageLocatorHash;
    const toHex = (v) => Array.isArray(v)
      ? v.map((b) => b.toString(16).padStart(2, "0")).join("")
      : String(v ?? "").replace(/^0x/, "");
    certified.push({
      receiptId: rid,
      contentHash: "0x" + toHex(contentHash),
      rootHash: "0x" + toHex(baseRoot || contentHash),
      manifestHash: "0x" + toHex(manifestHash || contentHash),
      certHash: "0x" + achHex,
    });
  }
  await api.disconnect();
  return certified;
}

function loadCheckpointHistory() {
  // Read from inside the docker container — the file is on the cert-daemon's
  // /data PVC and not bind-mounted to the host.
  try {
    const out = execSync(
      `docker exec ${CONTAINER} cat /data/checkpoint-history.json`,
      { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
    );
    const arr = JSON.parse(out);
    const seen = new Set();
    for (const batch of arr) {
      for (const leaf of batch.leaves || []) {
        seen.add(leaf.receipt_id);
      }
    }
    return seen;
  } catch (e) {
    log(`WARN could not read cert-daemon history (${e?.message || e}); proceeding with empty history`);
    return new Set();
  }
}

async function postAnchor(payload, token) {
  const res = await fetch(`${AW_URL.replace(/\/+$/, "")}/anchor`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-token": token,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

async function main() {
  log(`mode = ${APPLY ? "APPLY (will POST /anchor)" : "DRY-RUN (no POST)"}`);
  log(`anchor-worker target = ${AW_URL}/anchor`);

  const certified = await fetchCertifiedFromChain();
  log(`certified on chain: ${certified.length}`);
  const seen = loadCheckpointHistory();
  log(`receipts in cert-daemon history: ${seen.size}`);

  const backlog = certified.filter((c) => !seen.has(c.receiptId));
  log(`backlog (certified but absent from history): ${backlog.length}`);

  if (backlog.length === 0) {
    log("nothing to do — backlog is empty");
    return;
  }

  const slice = Number.isFinite(LIMIT) ? backlog.slice(0, LIMIT) : backlog;
  log(`will process ${slice.length} receipt(s)`);
  for (const r of slice) {
    log(`  ${r.receiptId.slice(0, 18)}... root=${r.rootHash.slice(0, 18)}... cert=${r.certHash.slice(0, 18)}...`);
  }
  if (!APPLY) {
    log("dry-run complete; rerun with BACKLOG_APPLY=1 to POST");
    return;
  }

  const token = readFileSync(AW_TOKEN_FILE, "utf-8").trim();
  if (!token) throw new Error(`empty token at ${AW_TOKEN_FILE}`);
  log(`loaded token (${token.length} chars)`);

  let ok = 0, fail = 0;
  for (let i = 0; i < slice.length; i++) {
    const r = slice[i];
    log(`POST ${i + 1}/${slice.length}  ${r.receiptId.slice(0, 18)}...`);
    try {
      const { status, body } = await postAnchor(
        { contentHash: r.contentHash, rootHash: r.rootHash, manifestHash: r.manifestHash },
        token,
      );
      if (status === 200) {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        log(`  OK txHash=${parsed?.txHash || parsed?.cardanoTxHash || "?"}`);
        ok++;
      } else {
        log(`  FAIL status=${status} body=${body.slice(0, 200)}`);
        fail++;
      }
    } catch (e) {
      log(`  ERR ${e?.message || e}`);
      fail++;
    }
    if (i + 1 < slice.length) await sleep(THROTTLE_MS);
  }
  log(`done. ok=${ok} fail=${fail}`);
}

main().catch((e) => {
  console.error(`[backlog] fatal: ${e?.stack || e}`);
  process.exit(1);
});
