import fs from "node:fs/promises";
import path from "node:path";
import type { RecorderConfig } from "./config.js";
import { findJsonlFiles } from "./discover.js";
import { loadTailState, saveTailState, readNewJsonlLines } from "./tailer.js";
import { appendSpool, type SpoolEvent, readSpool } from "./spool.js";
import { sha256Hex, sleep, jitterMs } from "./util.js";
import { buildTraceFromSpool } from "./build-trace.js";
import { anchorManifest } from "./anchor.js";

/**
 * How long a bundle may sit in "submitted" before it is retried.
 *
 * Long enough that a transaction which was going to confirm has confirmed, and
 * one that was not has fallen outside its validity window; short enough that a
 * bundle cannot be silently lost.
 */
const SUBMITTED_RECHECK_MS = 6 * 60 * 60_000;

export class OpenClawRecorder {
  constructor(private cfg: RecorderConfig) {}

  private statePath() {
    return path.join(this.cfg.outDir, "state", "tail-state.json");
  }

  private anchorStatePath() {
    return path.join(this.cfg.outDir, "state", "anchored.json");
  }

  private bundlesDir() {
    return path.join(this.cfg.outDir, "bundles");
  }

  private manifestsDir() {
    return path.join(this.cfg.outDir, "manifests");
  }

  private chunksDir(bundleId: string) {
    return path.join(this.cfg.outDir, "chunks", bundleId);
  }

  private secretRegexes() {
    return this.cfg.redaction.secretRegexes.map((s) => new RegExp(s, "g"));
  }

  private redactPayload(payload: string) {
    const hit = this.secretRegexes().some((r) => r.test(payload));
    const hash = `sha256:${sha256Hex(payload)}`;

    if (this.cfg.redaction.mode === "hash_only" || hit) {
      return { contentHash: hash, content: null as string | null };
    }
    return { contentHash: hash, content: payload };
  }

  private schedulePath() {
    return path.join(this.cfg.outDir, "state", "schedule.json");
  }

  async runForever() {
    await fs.mkdir(this.cfg.outDir, { recursive: true });
    await fs.mkdir(path.dirname(this.schedulePath()), { recursive: true });

    // Item 6: the anchor schedule used to live only in memory, so EVERY restart
    // pushed the next anchor a full cycle into the future. Combined with a crash
    // (item 5) that was unbounded starvation: crash, restart, wait 24h, crash.
    // Persist it, so a restart resumes the existing schedule instead of
    // resetting it.
    const interval = this.cfg.schedule.anchorEveryMinutes * 60_000;
    let nextAnchorAt = 0;
    try {
      const saved = JSON.parse(await fs.readFile(this.schedulePath(), "utf-8"));
      if (typeof saved?.nextAnchorAt === "number" && Number.isFinite(saved.nextAnchorAt)) {
        // Clamp: a corrupt or absurd future value must not starve anchoring.
        nextAnchorAt = Math.min(saved.nextAnchorAt, Date.now() + interval);
      }
    } catch {
      nextAnchorAt = 0;
    }
    if (!nextAnchorAt) {
      nextAnchorAt = Date.now() + jitterMs(interval, this.cfg.schedule.jitterSeconds);
      await this.saveSchedule(nextAnchorAt);
    }

    while (true) {
      await this.scanOnce();

      if (this.cfg.anchor.enabled && Date.now() >= nextAnchorAt) {
        await this.anchorLatestBundles();
        nextAnchorAt = Date.now() + jitterMs(
          this.cfg.schedule.anchorEveryMinutes * 60_000,
          this.cfg.schedule.jitterSeconds
        );
        await this.saveSchedule(nextAnchorAt);
      }

      await sleep(this.cfg.schedule.scanEverySeconds * 1000);
    }
  }

  async scanOnce() {
    const stateFile = this.statePath();
    const state = await loadTailState(stateFile);

    const jsonlFiles: string[] = [];

    for (const dir of this.cfg.sessionDirs) {
      const abs = path.join(this.cfg.openclawRoot, dir);
      jsonlFiles.push(...(await findJsonlFiles(abs)));
    }

    const spoolByBundle: Record<string, SpoolEvent[]> = {};

    for (const filePath of jsonlFiles) {
      const lastOffset = state[filePath] ?? 0;
      const { lines, newOffset } = await readNewJsonlLines(filePath, lastOffset);
      state[filePath] = newOffset;

      for (const line of lines) {
        const ev = this.parseOpenClawLine(line);
        if (!ev) continue;

        const bundleId = this.bundleIdFor(ev);
        (spoolByBundle[bundleId] ??= []).push(ev);
      }
    }

    // append new events to spool
    for (const [bundleId, events] of Object.entries(spoolByBundle)) {
      await appendSpool(this.cfg.outDir, bundleId, events);
    }

    await saveTailState(stateFile, state);
  }

  private parseOpenClawLine(line: string): SpoolEvent | null {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line); } catch { return null; }

    const ts = (obj.ts || obj.timestamp || new Date().toISOString()) as string;
    const agentId = (obj.agentId || obj.agent || (obj.meta as Record<string, unknown>)?.agentId) as string | undefined;
    const sessionId = (obj.sessionId || obj.session || (obj.meta as Record<string, unknown>)?.sessionId) as string | undefined;

    const kindRaw = obj.kind || obj.type || obj.eventType;
    const kind: SpoolEvent["kind"] =
      kindRaw === "user" ? "user" :
      kindRaw === "assistant" ? "assistant" :
      kindRaw === "tool" || kindRaw === "tool_call" ? "tool_call" :
      kindRaw === "tool_result" ? "tool_result" :
      "unknown";

    // Prefer a stable payload: content if present, else whole object
    const payload =
      typeof obj.content === "string" ? obj.content :
      obj.content != null ? JSON.stringify(obj.content) :
      JSON.stringify(obj);

    const red = this.redactPayload(payload);

    return {
      ts,
      kind,
      agentId,
      sessionId,
      contentHash: red.contentHash,
      content: red.content,
      meta: { source: "openclaw-jsonl" }
    };
  }

  private bundleIdFor(ev: SpoolEvent) {
    const day = (ev.ts || new Date().toISOString()).slice(0, 10);
    const a = ev.agentId || "unknown";
    return `${day}__${a}`;
  }

  async anchorLatestBundles() {
    const partnerKey = process.env[this.cfg.anchor.partnerKeyEnv] || "";

    // If no key, still build local artifacts, but skip network anchor.
    const hasKey = !!partnerKey;

    await fs.mkdir(this.bundlesDir(), { recursive: true });
    await fs.mkdir(this.manifestsDir(), { recursive: true });
    await fs.mkdir(path.dirname(this.anchorStatePath()), { recursive: true });

    const anchorState = await this.loadAnchorState();

    // Look at all spool files
    const spoolDir = path.join(this.cfg.outDir, "spool");
    let files: string[] = [];
    try { files = await fs.readdir(spoolDir); } catch { files = []; }

    for (const f of files.filter((x) => x.endsWith(".jsonl"))) {
      const bundleId = f.replace(/\.jsonl$/, "");
      const spoolEvents = await readSpool(this.cfg.outDir, bundleId);

      if (spoolEvents.length === 0) continue;


      // Build trace + manifest
      const agentId = `openclaw:${bundleId.split("__")[1] ?? "unknown"}`;
      const { bundle, manifest, chunks, contentDigest } = await buildTraceFromSpool({
        agentId,
        spoolEvents,
        chunkSize: 500_000
      });

      // Skip ONLY when the content is unchanged AND the last attempt actually
      // succeeded. The old check skipped on hash equality alone, so a failed
      // anchor would never have been retried either — both halves were wrong,
      // and they happened to cancel out into "retry everything, forever".
      const prior = anchorState[bundleId];
      if (prior?.contentDigest === contentDigest && prior?.state === "anchored") continue;

      // Content unchanged but the last attempt failed: retry with backoff so a
      // persistent server-side fault cannot turn into an hourly storm.
      // Submitted and possibly still landing: do NOT re-post immediately, or
      // the same bundle gets anchored twice.
      //
      // But it must not stick here forever either. The t-backend currently
      // writes CONFIRMED for no request at all, so a bundle that reaches
      // "submitted" would never advance to "anchored" and, if this were a plain
      // `continue`, would never be retried — silent under-anchoring, the exact
      // failure mode this commit exists to prevent. So a submitted bundle is
      // re-attempted after SUBMITTED_RECHECK_MS, which is far longer than any
      // Cardano validity window, so a transaction that was going to land has
      // already landed or expired by then.
      if (prior?.contentDigest === contentDigest && prior?.state === "submitted") {
        const lastAt = typeof prior.lastAttemptAt === "number" ? prior.lastAttemptAt : 0;
        if (Date.now() - lastAt < SUBMITTED_RECHECK_MS) continue;
      }

      if (prior?.contentDigest === contentDigest) {
        const attempts = typeof prior.attempts === "number" ? prior.attempts : 0;
        const lastAt = typeof prior.lastAttemptAt === "number" ? prior.lastAttemptAt : 0;
        // Double from 1 minute up to a 24h ceiling. The exponent is clamped at
        // 14 (2^14 min = 11.4 days) purely to keep the arithmetic bounded — the
        // 24h cap is what actually binds, so a permanently failing bundle
        // settles at one attempt a day rather than one an hour.
        const base = Math.min(2 ** Math.min(attempts, 14) * 60_000, 24 * 60 * 60_000);
        // +/-20% jitter. All 224 bundles failed together before the wallet was
        // funded, so an unjittered backoff keeps their retries synchronised and
        // delivers them as a burst on every retry boundary — straight into the
        // worker's single-output contention.
        const backoffMs = base * (0.8 + Math.random() * 0.4);
        if (Date.now() - lastAt < backoffMs) continue;
      }

      // Write local artifacts
      await fs.writeFile(
        path.join(this.bundlesDir(), `${bundleId}.bundle.json`),
        JSON.stringify(bundle, null, 2),
        "utf-8"
      );
      await fs.writeFile(
        path.join(this.manifestsDir(), `${bundleId}.manifest.json`),
        JSON.stringify(manifest, null, 2),
        "utf-8"
      );

      const cdir = this.chunksDir(bundleId);
      await fs.mkdir(cdir, { recursive: true });
      for (const ch of chunks) {
        const chunkInfo = ch.info as { hash: string };
        const p = path.join(cdir, `chunks/${chunkInfo.hash}.json`);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, ch.content, "utf-8");
      }

      // Anchor remotely (optional)
      let receipt: Record<string, unknown> = { anchored: false };

      if (this.cfg.anchor.enabled && hasKey) {
        try {
        const res = await anchorManifest({
          baseUrl: this.cfg.anchor.baseUrl,
          endpointPath: this.cfg.anchor.endpointPath,
          partnerKey,
          manifest: manifest as unknown as Record<string, unknown>
        });

        // anchored must mean ANCHORED, not "the HTTP call returned".
        // res.ok alone produced {"anchored": true, "status": 200} wrapping an
        // inner {"status":"ERROR","txHash":null} — 224 consecutive failures
        // that read as successes for seven months. Require a txHash and a
        // non-error inner status.
        const body = (res.json ?? {}) as Record<string, unknown>;
        const inner = String(body.status ?? "").toUpperCase();
        const txHash = typeof body.txHash === "string" && body.txHash.length > 0
          ? body.txHash
          : null;
        const confirmations = typeof body.confirmations === "number" ? body.confirmations : 0;

        // Three states, on an ALLOWLIST. A denylist ("not ERROR/FAILED") would
        // count any unknown future status carrying a stale txHash as anchored —
        // a new false success of exactly the kind this commit removes.
        //
        // A txHash alone is NOT anchored: it means a transaction was built and
        // handed to the network. It can be rejected ("All inputs are spent"),
        // dropped from the mempool, or fall outside its validity window.
        // An explicit failure from the worker is authoritative even when a
        // txHash is present: a transaction can be built and then rejected, and
        // that stale hash must not promote the bundle to "submitted" where it
        // would never be retried.
        const explicitFailure = inner === "ERROR" || inner === "FAILED";
        const state: "anchored" | "submitted" | "failed" =
          explicitFailure ? "failed"
          : res.ok && txHash && (inner === "CONFIRMED" || confirmations >= 1) ? "anchored"
          : res.ok && txHash ? "submitted"
          : "failed";

        receipt = {
          anchored: state === "anchored",
          state,
          httpStatus: res.status,
          txHash,
          response: res.json,
          manifestHash: manifest.manifestHash,
          rootHash: manifest.rootHash,
          merkleRoot: manifest.merkleRoot,
          timestamp: new Date().toISOString()
        };
        } catch (err) {
          // Item 5: one throw here used to kill the daemon. launchd restarts it,
          // and item 6's in-memory schedule then pushed the next anchor a full
          // cycle out — so a single transient network error silently cost a day
          // of anchoring. Record it as a failed attempt and carry on to the next
          // bundle.
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[anchor] ${bundleId} THREW: ${msg}`);
          receipt = {
            anchored: false,
            state: "failed",
            error: msg,
            manifestHash: manifest.manifestHash,
            rootHash: manifest.rootHash,
            merkleRoot: manifest.merkleRoot,
            timestamp: new Date().toISOString()
          };
        }
      } else {
        receipt = {
          anchored: false,
          state: "failed",
          reason: hasKey ? "anchor disabled in config" : `missing ${this.cfg.anchor.partnerKeyEnv}`,
          manifestHash: manifest.manifestHash,
          rootHash: manifest.rootHash,
          merkleRoot: manifest.merkleRoot,
          timestamp: new Date().toISOString()
        };
      }

      const receiptsDir = path.join(this.cfg.outDir, "receipts");
      await fs.mkdir(receiptsDir, { recursive: true });
      await fs.writeFile(
        path.join(receiptsDir, `${bundleId}.json`),
        JSON.stringify(receipt, null, 2),
        "utf-8"
      );

      const recState = typeof receipt.state === "string" ? receipt.state : "failed";
      const priorAttempts = typeof prior?.attempts === "number" ? prior.attempts : 0;
      anchorState[bundleId] = {
        contentDigest,
        manifestHash: manifest.manifestHash,
        state: recState,
        attempts: recState === "failed" ? priorAttempts + 1 : 0,
        lastAttemptAt: Date.now(),
        lastReceipt: receipt
      };
      if (recState === "failed") {
        // Item 7: no anchor outcome was ever logged, which is why an hourly
        // storm of failures was invisible from the console.
        console.error(
          `[anchor] ${bundleId} FAILED (attempt ${priorAttempts + 1}): ` +
          `http=${receipt.httpStatus ?? "n/a"} inner=${
            ((receipt.response as Record<string, unknown>)?.status) ?? "n/a"
          }`
        );
      }
      await this.saveAnchorState(anchorState);
    }
  }

  private async saveSchedule(nextAnchorAt: number) {
    try {
      await fs.writeFile(this.schedulePath(), JSON.stringify({ nextAnchorAt }), "utf-8");
    } catch (err) {
      // Never let bookkeeping stop anchoring; worst case we fall back to the
      // old in-memory behaviour for this process.
      console.error(`[anchor] could not persist schedule: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async loadAnchorState(): Promise<Record<string, Record<string, unknown>>> {
    try {
      return JSON.parse(await fs.readFile(this.anchorStatePath(), "utf-8"));
    } catch {
      return {};
    }
  }

  private async saveAnchorState(state: Record<string, Record<string, unknown>>) {
    await fs.writeFile(this.anchorStatePath(), JSON.stringify(state, null, 2), "utf-8");
  }
}
