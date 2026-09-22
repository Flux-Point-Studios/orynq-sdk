import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

export type RecorderConfig = {
  openclawRoot: string;
  sessionDirs: string[];   // directories under openclawRoot to scan for *.jsonl
  outDir: string;          // where we write spool/bundles/manifests/receipts/state

  redaction: {
    mode: "hash_only" | "store_text";
    secretRegexes: string[];
  };

  anchor: {
    enabled: boolean;
    baseUrl: string;       // e.g. https://api-v3.fluxpointstudios.com
    endpointPath: string;  // default /anchors/process-trace
    partnerKeyEnv: string; // default ORYNQ_PARTNER_KEY
    // v1: partner key mode only. Keep room for x402 later.
    mode: "partner_key";
  };

  schedule: {
    scanEverySeconds: number;     // tail logs
    anchorEveryMinutes: number;   // attempt anchor bundles
    jitterSeconds: number;        // avoid stampede
  };
};

export function defaultConfig(partial?: Partial<RecorderConfig>): RecorderConfig {
  const openclawRoot = partial?.openclawRoot ?? path.join(os.homedir(), ".openclaw");
  const outDir = partial?.outDir ?? path.join(openclawRoot, "orynq", "recorder");

  return {
    openclawRoot,
    sessionDirs: partial?.sessionDirs ?? ["sessions", "history"],
    outDir,

    redaction: {
      mode: partial?.redaction?.mode ?? "hash_only",
      secretRegexes: partial?.redaction?.secretRegexes ?? [
        "AKIA[0-9A-Z]{16}",
        "-----BEGIN(.*?)PRIVATE KEY-----",
        "sk-[A-Za-z0-9]{20,}",
        "xprv[a-zA-Z0-9]{20,}"
      ]
    },

    anchor: {
      enabled: partial?.anchor?.enabled ?? true,
      baseUrl: partial?.anchor?.baseUrl ?? "https://api-v3.fluxpointstudios.com",
      endpointPath: partial?.anchor?.endpointPath ?? "/anchors/process-trace",
      partnerKeyEnv: partial?.anchor?.partnerKeyEnv ?? "ORYNQ_PARTNER_KEY",
      mode: "partner_key"
    },

    schedule: {
      scanEverySeconds: partial?.schedule?.scanEverySeconds ?? 10,
      anchorEveryMinutes: partial?.schedule?.anchorEveryMinutes ?? 1440,
      jitterSeconds: partial?.schedule?.jitterSeconds ?? 180
    }
  };
}

export async function loadConfig(filePath: string): Promise<RecorderConfig> {
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<RecorderConfig>;
  const cfg = defaultConfig(parsed);

  // normalize to absolute paths
  cfg.openclawRoot = path.resolve(cfg.openclawRoot);
  cfg.outDir = path.resolve(cfg.outDir);

  // basic guards
  if (!cfg.openclawRoot) throw new Error("openclawRoot is required");
  if (!Array.isArray(cfg.sessionDirs) || cfg.sessionDirs.length === 0) throw new Error("sessionDirs must be non-empty");
  if (!cfg.outDir) throw new Error("outDir is required");
  if (cfg.schedule.scanEverySeconds < 2) throw new Error("scanEverySeconds must be >= 2");

  return cfg;
}
