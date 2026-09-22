import fs from "node:fs/promises";
import path from "node:path";
import type { RecorderConfig } from "./config.js";
import { findJsonlFiles } from "./discover.js";
import { loadTailState, saveTailState, readNewJsonlLines } from "./tailer.js";
import { appendSpool, type SpoolEvent, readSpool } from "./spool.js";
import { sha256Hex, sleep, jitterMs } from "./util.js";
import { buildTraceFromSpool } from "./build-trace.js";
import { anchorManifest, checkAnchorStatus } from "./anchor.js";
import {
  classifyAnchorResponse,
  shouldPost,
  decideSubmitted,
  resolveNextAnchorAt,
  type AnchorRecord
} from "./anchor-policy.js";

/**
 * How long a bundle may sit unconfirmed before the recorder starts complaining.
 *
 * This is a WARNING threshold, never a re-post trigger. A submitted anchor has
 * a transaction on the network — measured, 15 of 15 submissions landed in
 * consecutive preprod blocks — so re-posting one would duplicate an anchor that
 * already succeeded. The only safe exit from "submitted" is the status poll.
 */
const SUBMITTED_WARN_MS = 6 * 60 * 60_000;

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
      nextAnchorAt = resolveNextAnchorAt(saved, Date.now(), interval);
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

      const prior = anchorState[bundleId] as AnchorRecord | undefined;
      if (!shouldPost(prior, contentDigest, Date.now(), 0.8 + Math.random() * 0.4)) {
        // Not due, already anchored, or awaiting a poll. The one case that
        // still needs work here is "submitted", handled next.
        if (prior?.state !== "submitted") continue;
      }

      // Submitted: ASK, never re-post.
      //
      // A submitted anchor already has a transaction on the network — measured,
      // 15 of 15 submissions landed in consecutive preprod blocks — so
      // re-posting one duplicates an anchor that already succeeded. Poll
      // instead. Only an unrecognised requestId justifies posting again: that
      // is the single case where the submission did not reach the server.
      //
      // A bundle that stays unconfirmed is made NOISY rather than retried:
      // visible, not silent, and no duplicates.
      if (prior?.contentDigest === contentDigest && prior?.state === "submitted") {
        const requestId = typeof prior.requestId === "string" ? prior.requestId : "";
        const lastAt = typeof prior.lastAttemptAt === "number" ? prior.lastAttemptAt : 0;
        const waited = Date.now() - lastAt;

        if (requestId) {
          const poll = await checkAnchorStatus({
            baseUrl: this.cfg.anchor.baseUrl,
            requestId,
            partnerKey
          }).catch((err) => ({
            state: "error" as const,
            detail: err instanceof Error ? err.message : String(err)
          }));

          const action = decideSubmitted(poll, waited, SUBMITTED_WARN_MS);
          if (action === "promote-anchored") {
            anchorState[bundleId] = { ...prior, state: "anchored", confirmedAt: Date.now() };
            await this.saveAnchorState(anchorState);
            console.error(`[anchor] ${bundleId} CONFIRMED (requestId ${requestId})`);
            continue;
          }
          if (action !== "repost") {
            // pending, or the poll itself failed — neither is evidence the
            // anchor is absent, so do not re-post.
            if (action === "warn-and-wait") {
              console.error(
                `[anchor] ${bundleId} STILL UNCONFIRMED after ${Math.round(waited / 3_600_000)}h ` +
                `(requestId ${requestId}, poll=${poll.state}${poll.detail ? `: ${poll.detail}` : ""}). ` +
                `Not re-posting — a submitted anchor may already be on chain.`
              );
            }
            continue;
          }
          console.error(
            `[anchor] ${bundleId} requestId ${requestId} not recognised by the server — re-posting`
          );
        }
        // No requestId recorded (state written by an older build): fall through.
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

        // Classification lives in anchor-policy.ts so tests exercise THIS
        // code rather than a copy of it.
        const body = (res.json ?? {}) as Record<string, unknown>;
        const txHash = typeof body.txHash === "string" && body.txHash.length > 0
          ? body.txHash
          : null;
        const state = classifyAnchorResponse(res);

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
      const reqId = typeof (receipt.response as Record<string, unknown>)?.requestId === "string"
        ? ((receipt.response as Record<string, unknown>).requestId as string)
        : undefined;
      anchorState[bundleId] = {
        contentDigest,
        manifestHash: manifest.manifestHash,
        ...(reqId ? { requestId: reqId } : {}),
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
