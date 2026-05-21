/**
 * Trace-detail explorer page (task #271).
 *
 * Serves a self-contained HTML page at GET /trace/:contentHash that shows the
 * end-to-end chain-of-custody for a single orynq-sdk trace blob:
 *
 *   manifest (blob-gateway) → pallet-orinq-receipts (M-of-N cert) → Cardano L1 anchor
 *
 * Read-only and public — no auth, CORS open, no JS dependencies, no external
 * fetches from the rendered page (everything is server-rendered).
 *
 * Data sources:
 *   - Manifest:        storage.getManifest()                       (local)
 *   - Receipt-by-CH:   custom RPC `orinq_getReceiptsByContent`     (Materios)
 *   - Receipt detail:  custom RPC `orinq_getReceipt`               (Materios)
 *   - Receipt status:  custom RPC `orinq_getReceiptStatus`         (Materios)
 *   - Cert attestors:  events-indexer `/preprod-events/receipt-attestors`
 *   - Anchor record:   local `getBatch()` keyed by rootHash         (anchor-worker-materios)
 *
 * The fetch implementation is overridable via `__test__setFetchImpl` so unit
 * tests don't need a real chain or HTTP loopback.
 */
import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { getManifest, getBatch } from "../storage.js";

export const traceRouter = Router();

const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
const RECEIPT_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const SS58_RE = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;
const HEX_TX_RE = /^[0-9a-f]{64}$/;
// Mirrors `DEFAULT_MIN_ATTESTATION_THRESHOLD` in
// `routes/explorer-validators.ts` (task #337). Both routes display a
// committee-threshold counter; keeping the constant in lockstep avoids
// "this page says 3/N, that page says 3/4" drift. If the on-chain
// `MinAttestationThreshold` constant changes, both routes need a bump.
const DEFAULT_MIN_ATTESTATION_THRESHOLD = 3;

type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init as RequestInit);

export function __test__setFetchImpl(f: FetchLike): void {
  fetchImpl = f;
}

export function __test__resetFetchImpl(): void {
  fetchImpl = (url, init) => fetch(url, init as RequestInit);
}

interface ReceiptRecord {
  receiptId: string;
  contentHash: string;
  baseRootSha256: string;
  baseManifestHash: string;
  availabilityCertHash: string;
  createdAtMillis: number;
  submitter: string;
  status: string;
}

interface AttestorCertInfo {
  certified: boolean;
  certHash: string | null;
  certifiedAtBlock: number | null;
  certifiedAtHash: string | null;
  signers: Array<{ attester: string; rewardBase: string }>;
  signerCount: number;
}

interface AnchorInfo {
  found: boolean;
  cardanoTxHash: string | null;
  cardanoNetwork: "preprod" | "mainnet" | null;
  cardanoBlockHeight: number | null;
  cardanoMetadataLabel: number | null;
  anchorId: string | null;
  source: string | null;
  timestamp: string | null;
}

interface RenderInput {
  contentHash: string;
  manifest: Record<string, unknown>;
  receipt: ReceiptRecord | null;
  cert: AttestorCertInfo | null;
  anchor: AnchorInfo;
  minAttestationThreshold: number | null;
}

function rpcHttpUrl(): string | null {
  const raw = config.materiosRpcUrl;
  if (!raw) return null;
  return raw.replace("ws://", "http://").replace("wss://", "https://");
}

async function rpcCall<T>(method: string, params: unknown[] = []): Promise<T | null> {
  const url = rpcHttpUrl();
  if (!url) return null;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: T; error?: unknown };
    if (data.error) return null;
    return (data.result ?? null) as T | null;
  } catch {
    return null;
  }
}

function bytesToHex(arr: unknown): string {
  if (!Array.isArray(arr)) return "";
  return arr
    .map((b) => (typeof b === "number" ? b.toString(16).padStart(2, "0") : ""))
    .join("");
}

function isAllZeroHex(hex: string): boolean {
  return /^0*$/.test(hex);
}

async function fetchReceiptByContent(contentHash: string): Promise<ReceiptRecord | null> {
  const hex = `0x${contentHash}`;
  const ids = await rpcCall<string[]>("orinq_getReceiptsByContent", [hex]);
  if (!ids || ids.length === 0) return null;
  const receiptId = ids[0];
  if (!RECEIPT_ID_RE.test(receiptId)) return null;
  const detail = await rpcCall<Record<string, unknown>>("orinq_getReceipt", [receiptId]);
  if (!detail) return null;
  const status =
    (await rpcCall<string>("orinq_getReceiptStatus", [receiptId])) ?? "Unknown";

  return {
    receiptId,
    contentHash: bytesToHex(detail.content_hash),
    baseRootSha256: bytesToHex(detail.base_root_sha256),
    baseManifestHash: bytesToHex(detail.base_manifest_hash),
    availabilityCertHash: bytesToHex(detail.availability_cert_hash),
    createdAtMillis:
      typeof detail.created_at_millis === "number" ? detail.created_at_millis : 0,
    submitter: typeof detail.submitter === "string" ? detail.submitter : "",
    status,
  };
}

async function fetchEventsIndexerCert(receiptId: string): Promise<AttestorCertInfo> {
  const base =
    process.env.EVENTS_INDEXER_URL ||
    "https://materios.fluxpointstudios.com/preprod-events";
  try {
    const res = await fetchImpl(
      `${base}/receipt-attestors?receiptId=${encodeURIComponent(receiptId)}`,
    );
    if (!res.ok) {
      return {
        certified: false,
        certHash: null,
        certifiedAtBlock: null,
        certifiedAtHash: null,
        signers: [],
        signerCount: 0,
      };
    }
    const body = (await res.json()) as Record<string, unknown>;
    const rawSigners = Array.isArray(body.signers) ? body.signers : [];
    const signers: Array<{ attester: string; rewardBase: string }> = [];
    for (const s of rawSigners) {
      if (s && typeof s === "object") {
        const o = s as Record<string, unknown>;
        const att = typeof o.attester === "string" ? o.attester : "";
        const rb = typeof o.reward_base === "string" ? o.reward_base : "";
        if (SS58_RE.test(att)) {
          signers.push({ attester: att, rewardBase: rb });
        }
      }
    }
    return {
      certified: body.certified === true,
      certHash:
        typeof body.cert_hash === "string" && /^0x[0-9a-f]{64}$/i.test(body.cert_hash)
          ? body.cert_hash
          : null,
      certifiedAtBlock:
        typeof body.certified_at_block === "number" ? body.certified_at_block : null,
      certifiedAtHash:
        typeof body.certified_at_hash === "string" ? body.certified_at_hash : null,
      signers,
      signerCount: typeof body.signer_count === "number" ? body.signer_count : signers.length,
    };
  } catch {
    return {
      certified: false,
      certHash: null,
      certifiedAtBlock: null,
      certifiedAtHash: null,
      signers: [],
      signerCount: 0,
    };
  }
}

async function fetchAnchorRecord(rootHash: string): Promise<AnchorInfo> {
  // The anchor-worker-materios PUTs batch records keyed by anchorId. The
  // rootHash IS the anchorId when the batch holds a single receipt — for
  // multi-receipt batches the rootHash is the merkle root of leafHashes
  // and the anchorId is a separate value. We try both: first the rootHash
  // as the key, then fall back to scanning batches dir if needed.
  //
  // For the initial ship we try rootHash directly — it covers the
  // overwhelming-common single-receipt case. Multi-receipt resolution is
  // a follow-up (see deferred-scope in the PR).
  const empty: AnchorInfo = {
    found: false,
    cardanoTxHash: null,
    cardanoNetwork: null,
    cardanoBlockHeight: null,
    cardanoMetadataLabel: null,
    anchorId: null,
    source: null,
    timestamp: null,
  };
  try {
    const record = await getBatch(rootHash);
    if (!record) return empty;
    const r = record as Record<string, unknown>;
    const tx =
      typeof r.cardanoTxHash === "string" && HEX_TX_RE.test(r.cardanoTxHash.toLowerCase())
        ? r.cardanoTxHash.toLowerCase()
        : null;
    const net =
      r.cardanoNetwork === "mainnet" || r.cardanoNetwork === "preprod"
        ? r.cardanoNetwork
        : null;
    return {
      found: true,
      cardanoTxHash: tx,
      cardanoNetwork: net,
      cardanoBlockHeight:
        typeof r.cardanoBlockHeight === "number" ? r.cardanoBlockHeight : null,
      cardanoMetadataLabel:
        typeof r.cardanoMetadataLabel === "number" ? r.cardanoMetadataLabel : null,
      anchorId: typeof r.anchorId === "string" ? r.anchorId : null,
      source: typeof r.source === "string" ? r.source : null,
      timestamp: typeof r.timestamp === "string" ? r.timestamp : null,
    };
  } catch {
    return empty;
  }
}

function escapeHtml(s: unknown): string {
  if (s === null || s === undefined) return "";
  const str = String(s);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function cexplorerUrl(txHash: string, network: "preprod" | "mainnet"): string {
  const host = network === "mainnet" ? "cexplorer.io" : "preprod.cexplorer.io";
  return `https://${host}/tx/${txHash}`;
}

function renderShell(title: string, bodyHtml: string): string {
  // Inline CSS only — no external deps so the page loads even with strict
  // CSP, offline, or JS disabled.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    background:#0b0d11;
    color:#e6e8eb;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    line-height:1.5;
    min-height:100vh;
  }
  .wrap{max-width:1100px;margin:0 auto;padding:24px 16px}
  h1{font-size:18px;margin:0 0 8px 0;color:#9da3ad;font-weight:500;text-transform:uppercase;letter-spacing:0.04em}
  h2{font-size:14px;margin:0 0 12px 0;color:#9da3ad;font-weight:500;text-transform:uppercase;letter-spacing:0.04em}
  .hash{
    font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    font-size:13px;
    word-break:break-all;
    background:#161a20;
    padding:8px 10px;
    border-radius:4px;
    border:1px solid #232830;
    user-select:all;
  }
  .hash.lg{font-size:14px;padding:12px 14px}
  .card{
    background:#11141a;
    border:1px solid #1f242c;
    border-radius:8px;
    padding:16px;
    margin-bottom:16px;
  }
  .row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px}
  .col{flex:1 1 220px;min-width:0}
  .label{font-size:11px;color:#8a8f99;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px}
  .val{font-size:14px;color:#e6e8eb;word-break:break-word}
  .val.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12.5px}
  .badge{
    display:inline-block;
    padding:3px 10px;
    border-radius:999px;
    font-size:11px;
    font-weight:600;
    letter-spacing:0.04em;
    text-transform:uppercase;
  }
  .badge.ok{background:#0e3b1f;color:#7be38f;border:1px solid #1c5a2e}
  .badge.warn{background:#3b2e0e;color:#ffd66b;border:1px solid #5a4a1c}
  .badge.err{background:#3b0e0e;color:#ff7b7b;border:1px solid #5a1c1c}
  a{color:#7eb8ff;text-decoration:none}
  a:hover{text-decoration:underline}
  ul{list-style:none;margin:0;padding:0}
  li{padding:6px 0;border-top:1px solid #1f242c}
  li:first-child{border-top:0}
  .signer{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .signer .att{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12.5px}
  .small{font-size:12px;color:#8a8f99}
  footer{margin-top:32px;font-size:12px;color:#5e636d;text-align:center}
  @media (max-width:480px){
    .wrap{padding:14px 10px}
    .hash.lg{font-size:12px}
    .row{flex-direction:column;gap:8px}
  }
</style>
</head>
<body>
<div class="wrap">
${bodyHtml}
<footer>Served by blob-gateway · Materios L2 chain-of-custody explorer</footer>
</div>
</body>
</html>`;
}

function renderTraceSummaryCard(
  contentHash: string,
  manifest: Record<string, unknown>,
): string {
  const formatVersion = typeof manifest.formatVersion === "string" ? manifest.formatVersion : "unknown";
  const agentId = typeof manifest.agentId === "string" ? manifest.agentId : "—";
  const runId = typeof manifest.runId === "string" ? manifest.runId : "—";
  const startedAt = typeof manifest.startedAt === "string" ? manifest.startedAt : "—";
  const endedAt = typeof manifest.endedAt === "string" ? manifest.endedAt : "—";
  const durationMs = typeof manifest.durationMs === "number" ? manifest.durationMs : null;
  const totalEvents = typeof manifest.totalEvents === "number" ? manifest.totalEvents : null;
  const totalSpans = typeof manifest.totalSpans === "number" ? manifest.totalSpans : null;
  const rootHash = typeof manifest.rootHash === "string" ? manifest.rootHash : null;
  const manifestHash = typeof manifest.manifestHash === "string" ? manifest.manifestHash : null;

  let chunkCount = 0;
  let totalBytes = 0;
  if (Array.isArray(manifest.chunks)) {
    chunkCount = manifest.chunks.length;
    for (const c of manifest.chunks) {
      if (c && typeof c === "object") {
        const size = (c as Record<string, unknown>).size;
        if (typeof size === "number") totalBytes += size;
      }
    }
  }

  const durHuman = durationMs !== null ? `${durationMs} ms` : "—";

  return `
<h1>Content Hash</h1>
<div class="hash lg" id="contentHash">${escapeHtml(contentHash)}</div>

<h2 style="margin-top:24px">Trace summary</h2>
<div class="card">
  <div class="row">
    <div class="col"><div class="label">Schema version</div><div class="val">${escapeHtml(formatVersion)}</div></div>
    <div class="col"><div class="label">Agent</div><div class="val">${escapeHtml(agentId)}</div></div>
    <div class="col"><div class="label">Run</div><div class="val">${escapeHtml(runId)}</div></div>
  </div>
  <div class="row">
    <div class="col"><div class="label">Started</div><div class="val">${escapeHtml(startedAt)}</div></div>
    <div class="col"><div class="label">Ended</div><div class="val">${escapeHtml(endedAt)}</div></div>
    <div class="col"><div class="label">Duration</div><div class="val">${escapeHtml(durHuman)}</div></div>
  </div>
  <div class="row">
    <div class="col"><div class="label">Spans</div><div class="val">${escapeHtml(totalSpans ?? "—")}</div></div>
    <div class="col"><div class="label">Events</div><div class="val">${escapeHtml(totalEvents ?? "—")}</div></div>
    <div class="col"><div class="label">Chunks</div><div class="val">${escapeHtml(chunkCount)} · ${escapeHtml(formatBytes(totalBytes))}</div></div>
  </div>
  ${
    rootHash
      ? `<div class="row"><div class="col"><div class="label">Root hash</div><div class="val mono">${escapeHtml(rootHash)}</div></div></div>`
      : ""
  }
  ${
    manifestHash
      ? `<div class="row"><div class="col"><div class="label">Manifest hash</div><div class="val mono">${escapeHtml(manifestHash)}</div></div></div>`
      : ""
  }
</div>`;
}

function renderReceiptCard(
  receipt: ReceiptRecord | null,
  cert: AttestorCertInfo | null,
  threshold: number | null,
): string {
  if (!receipt) {
    return `
<h2>Materios L2 receipt</h2>
<div class="card">
  <div class="row">
    <div class="col"><span class="badge warn">PENDING</span></div>
  </div>
  <div class="small">No receipt found on chain for this content hash yet. Receipts are submitted once the trace upload completes and the submitter signs <code>submit_receipt_v2</code>.</div>
</div>`;
  }
  const finalized = receipt.status === "Certified" && cert?.certified === true;
  const badge = finalized
    ? `<span class="badge ok">FINALIZED</span>`
    : `<span class="badge warn">PENDING</span>`;

  const signerCount = cert?.signerCount ?? 0;
  const thresholdLabel = threshold !== null ? threshold : "N";
  const signersHtml = cert && cert.signers.length > 0
    ? `<ul>${cert.signers
        .map(
          (s) =>
            `<li class="signer"><span class="att">${escapeHtml(s.attester)}</span><span class="small">+${escapeHtml(s.rewardBase)} base reward</span></li>`,
        )
        .join("")}</ul>`
    : `<div class="small">Signer list unavailable (events indexer reported none, or cert pre-dates indexer history).</div>`;

  return `
<h2>Materios L2 receipt</h2>
<div class="card">
  <div class="row">
    <div class="col"><div class="label">Status</div><div class="val">${badge} <span class="small">${escapeHtml(receipt.status)}</span></div></div>
    <div class="col"><div class="label">Attestations</div><div class="val">${escapeHtml(signerCount)} / ${escapeHtml(thresholdLabel)}</div></div>
    ${
      cert?.certifiedAtBlock !== null && cert?.certifiedAtBlock !== undefined
        ? `<div class="col"><div class="label">Certified at block</div><div class="val">${escapeHtml(cert.certifiedAtBlock)}</div></div>`
        : ""
    }
  </div>
  <div class="row">
    <div class="col"><div class="label">Receipt ID</div><div class="val mono">${escapeHtml(receipt.receiptId)}</div></div>
  </div>
  ${
    cert?.certHash
      ? `<div class="row"><div class="col"><div class="label">Availability cert hash</div><div class="val mono">${escapeHtml(cert.certHash)}</div></div></div>`
      : ""
  }
  <div class="row">
    <div class="col"><div class="label">Submitter</div><div class="val mono">${escapeHtml(receipt.submitter)}</div></div>
  </div>
  <h2 style="margin-top:16px">Attestor signers</h2>
  ${signersHtml}
</div>`;
}

function renderAnchorCard(rootHash: string | null, anchor: AnchorInfo): string {
  if (!anchor.found || !anchor.cardanoTxHash || !anchor.cardanoNetwork) {
    return `
<h2>Cardano L1 anchor</h2>
<div class="card">
  <div class="row">
    <div class="col"><span class="badge warn">PENDING</span></div>
  </div>
  <div class="small">No Cardano anchor record found yet for ${
    rootHash ? `root <span class="val mono">${escapeHtml(rootHash)}</span>` : "this trace"
  }. The Materios → Cardano anchor batch rolls up multiple certified receipts and posts a single L1 transaction every ~5 minutes.</div>
</div>`;
  }
  const explorer = cexplorerUrl(anchor.cardanoTxHash, anchor.cardanoNetwork);
  return `
<h2>Cardano L1 anchor</h2>
<div class="card">
  <div class="row">
    <div class="col"><div class="label">Status</div><div class="val"><span class="badge ok">FINALIZED</span> <span class="small">${escapeHtml(anchor.cardanoNetwork)}</span></div></div>
    ${
      anchor.cardanoMetadataLabel !== null
        ? `<div class="col"><div class="label">Metadata label</div><div class="val">${escapeHtml(anchor.cardanoMetadataLabel)}</div></div>`
        : ""
    }
    ${
      anchor.cardanoBlockHeight !== null
        ? `<div class="col"><div class="label">L1 block height</div><div class="val">${escapeHtml(anchor.cardanoBlockHeight)}</div></div>`
        : ""
    }
  </div>
  <div class="row">
    <div class="col"><div class="label">Cardano tx</div><div class="val mono"><a href="${escapeHtml(explorer)}" target="_blank" rel="noopener noreferrer">${escapeHtml(anchor.cardanoTxHash)}</a></div></div>
  </div>
  ${
    anchor.anchorId
      ? `<div class="row"><div class="col"><div class="label">Anchor ID</div><div class="val mono">${escapeHtml(anchor.anchorId)}</div></div></div>`
      : ""
  }
  ${
    anchor.timestamp
      ? `<div class="row"><div class="col"><div class="label">Timestamp</div><div class="val">${escapeHtml(anchor.timestamp)}</div></div></div>`
      : ""
  }
</div>`;
}

function renderTimeline(
  manifest: Record<string, unknown>,
  receipt: ReceiptRecord | null,
  cert: AttestorCertInfo | null,
  anchor: AnchorInfo,
): string {
  const events: Array<{ ts: string | null; kind: string; signer: string; detail: string }> = [];

  const startedAt = typeof manifest.startedAt === "string" ? manifest.startedAt : null;
  const endedAt = typeof manifest.endedAt === "string" ? manifest.endedAt : null;
  if (startedAt) {
    events.push({
      ts: startedAt,
      kind: "trace.started",
      signer: typeof manifest.agentId === "string" ? manifest.agentId : "agent",
      detail: "",
    });
  }
  if (endedAt) {
    events.push({
      ts: endedAt,
      kind: "trace.ended",
      signer: typeof manifest.agentId === "string" ? manifest.agentId : "agent",
      detail: typeof manifest.durationMs === "number" ? `${manifest.durationMs} ms` : "",
    });
  }

  if (receipt) {
    events.push({
      ts:
        receipt.createdAtMillis > 0
          ? new Date(receipt.createdAtMillis).toISOString()
          : null,
      kind: "receipt.submitted",
      signer: receipt.submitter,
      detail: `receipt_id=${receipt.receiptId.slice(0, 18)}…`,
    });
  }
  if (cert && cert.certified) {
    for (const s of cert.signers) {
      events.push({
        ts: null,
        kind: "receipt.attested",
        signer: s.attester,
        detail: `+${s.rewardBase} base`,
      });
    }
    if (cert.certifiedAtBlock !== null) {
      events.push({
        ts: null,
        kind: "receipt.certified",
        signer: "consensus",
        detail: `certified_at_block=${cert.certifiedAtBlock}`,
      });
    }
  }
  if (anchor.found && anchor.cardanoTxHash) {
    events.push({
      ts: anchor.timestamp,
      kind: "anchor.cardano",
      signer: anchor.source ?? "anchor-worker",
      detail: `tx=${anchor.cardanoTxHash.slice(0, 18)}…`,
    });
  }

  const items = events
    .map(
      (e) =>
        `<li><div class="signer"><span class="small">${escapeHtml(e.ts ?? "—")}</span> <strong>${escapeHtml(e.kind)}</strong> <span class="att">${escapeHtml(e.signer)}</span></div>${
          e.detail ? `<div class="small">${escapeHtml(e.detail)}</div>` : ""
        }</li>`,
    )
    .join("");

  return `
<h2>Event timeline</h2>
<div class="card">
  <ul>${items || `<li class="small">No events yet.</li>`}</ul>
</div>`;
}

function renderTracePage(input: RenderInput): string {
  const rootHash =
    typeof input.manifest.rootHash === "string" ? input.manifest.rootHash : null;
  const body = [
    renderTraceSummaryCard(input.contentHash, input.manifest),
    renderReceiptCard(input.receipt, input.cert, input.minAttestationThreshold),
    renderAnchorCard(rootHash, input.anchor),
    renderTimeline(input.manifest, input.receipt, input.cert, input.anchor),
  ].join("\n");
  return renderShell(`Trace ${input.contentHash.slice(0, 16)}… · Materios`, body);
}

function render400(reason: string): string {
  return renderShell(
    "Invalid content hash · Materios",
    `<h1>Invalid content hash</h1><div class="card"><div class="small">${escapeHtml(reason)}</div></div>`,
  );
}

function render404(contentHash: string): string {
  return renderShell(
    "Not found · Materios",
    `<h1>Not found</h1><div class="card"><div class="small">No trace manifest is stored under <span class="val mono">${escapeHtml(contentHash)}</span> on this gateway.</div></div>`,
  );
}

traceRouter.get("/trace/:contentHash", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=15");

  const raw = (req.params.contentHash || "").trim();
  if (!CONTENT_HASH_RE.test(raw)) {
    res
      .status(400)
      .send(
        render400(
          "Content hash must be exactly 64 lowercase hex characters (SHA-256 of the trace manifest content).",
        ),
      );
    return;
  }

  try {
    const manifest = (await getManifest(raw)) as Record<string, unknown> | null;
    if (!manifest) {
      res.status(404).send(render404(raw));
      return;
    }

    const receipt = await fetchReceiptByContent(raw);
    let cert: AttestorCertInfo | null = null;
    if (receipt) {
      cert = await fetchEventsIndexerCert(receipt.receiptId);
    }

    const rootHashStr =
      typeof manifest.rootHash === "string" ? manifest.rootHash : null;
    const anchor = rootHashStr
      ? await fetchAnchorRecord(rootHashStr)
      : {
          found: false,
          cardanoTxHash: null,
          cardanoNetwork: null,
          cardanoBlockHeight: null,
          cardanoMetadataLabel: null,
          anchorId: null,
          source: null,
          timestamp: null,
        };

    // Hide bytewise-zero defaults that are noise to the reader.
    if (receipt) {
      if (isAllZeroHex(receipt.baseManifestHash)) receipt.baseManifestHash = "";
      if (isAllZeroHex(receipt.availabilityCertHash)) receipt.availabilityCertHash = "";
    }

    res.status(200).send(
      renderTracePage({
        contentHash: raw,
        manifest,
        receipt,
        cert,
        anchor,
        minAttestationThreshold: DEFAULT_MIN_ATTESTATION_THRESHOLD,
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[trace] render error for ${raw}: ${msg}`);
    res.status(500).send(
      renderShell(
        "Error · Materios",
        `<h1>Render error</h1><div class="card"><div class="small">${escapeHtml(msg)}</div></div>`,
      ),
    );
  }
});
