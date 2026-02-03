import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function configDir() {
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "orynq-openclaw");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg || path.join(os.homedir(), ".config"), "orynq-openclaw");
}

export function configPath() {
  return path.join(configDir(), "openclaw.json");
}

export function envPath() {
  return path.join(configDir(), "service.env");
}

export function runShPath() {
  return path.join(configDir(), "run.sh");
}

export function runPs1Path() {
  return path.join(configDir(), "run.ps1");
}

export function outLogPath() {
  return path.join(configDir(), "service.out.log");
}

export function errLogPath() {
  return path.join(configDir(), "service.err.log");
}

export function guessOpenClawRoot() {
  const candidates = [
    process.env.OPENCLAW_ROOT,
    path.join(os.homedir(), ".openclaw"),
    path.join(os.homedir(), ".config", "openclaw")
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return candidates[0] || path.join(os.homedir(), ".openclaw");
}
