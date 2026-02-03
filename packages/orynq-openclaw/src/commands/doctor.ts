import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "@fluxpointstudios/orynq-sdk-recorder-openclaw";

export async function doctor(opts: { config: string }) {
  if (!fs.existsSync(opts.config)) {
    console.error(`Config not found: ${opts.config}`);
    process.exit(2);
  }

  const cfg = await loadConfig(opts.config);

  console.log(`Config:        ${opts.config}`);
  console.log(`OpenClaw root: ${cfg.openclawRoot} (${fs.existsSync(cfg.openclawRoot) ? "exists" : "missing"})`);
  console.log(`Out dir:       ${cfg.outDir} (${fs.existsSync(cfg.outDir) ? "exists" : "missing"})`);

  for (const d of cfg.sessionDirs) {
    const p = path.join(cfg.openclawRoot, d);
    console.log(`- Session dir:   ${p} (${fs.existsSync(p) ? "exists" : "missing"})`);
  }

  if (cfg.anchor.enabled) {
    const key = process.env[cfg.anchor.partnerKeyEnv];
    console.log(`- ${cfg.anchor.partnerKeyEnv}: ${key ? "set" : "NOT set"} (service.env recommended)`);
  }
}
