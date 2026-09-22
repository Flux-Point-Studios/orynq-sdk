import fs from "node:fs/promises";
import path from "node:path";
import type { RecorderConfig } from "./config.js";
import { findJsonlFiles } from "./discover.js";
import { loadTailState, saveTailState, readNewJsonlLines } from "./tailer.js";
import { appendSpool, type SpoolEvent, readSpool } from "./spool.js";
import { sha256Hex, sleep, jitterMs } from "./util.js";
import { buildTraceFromSpool } from "./build-trace.js";
import { anchorManifest } from "./anchor.js";

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

  async runForever() {
    await fs.mkdir(this.cfg.outDir, { recursive: true });

    let nextAnchorAt = Date.now() + jitterMs(
      this.cfg.schedule.anchorEveryMinutes * 60_000,
      this.cfg.schedule.jitterSeconds
    );

    while (true) {
      await this.scanOnce();

      if (this.cfg.anchor.enabled && Date.now() >= nextAnchorAt) {
        await this.anchorLatestBundles();
        nextAnchorAt = Date.now() + jitterMs(
          this.cfg.schedule.anchorEveryMinutes * 60_000,
          this.cfg.schedule.jitterSeconds
        );
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
      const { bundle, manifest, chunks } = await buildTraceFromSpool({
        agentId,
        spoolEvents,
        chunkSize: 500_000
      });

      // If unchanged since last time, skip
      if (anchorState[bundleId]?.manifestHash === manifest.manifestHash) continue;

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
        const res = await anchorManifest({
          baseUrl: this.cfg.anchor.baseUrl,
          endpointPath: this.cfg.anchor.endpointPath,
          partnerKey,
          manifest: manifest as unknown as Record<string, unknown>
        });

        receipt = {
          anchored: res.ok,
          status: res.status,
          response: res.json,
          manifestHash: manifest.manifestHash,
          rootHash: manifest.rootHash,
          merkleRoot: manifest.merkleRoot,
          timestamp: new Date().toISOString()
        };
      } else {
        receipt = {
          anchored: false,
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

      anchorState[bundleId] = { manifestHash: manifest.manifestHash, lastReceipt: receipt };
      await this.saveAnchorState(anchorState);
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
