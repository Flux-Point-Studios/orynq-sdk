import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { configDir, envPath, runShPath, runPs1Path, configPath, outLogPath, errLogPath } from "./paths.js";

function spawnPromise(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on("error", reject);
  });
}

export async function writeServiceEnvIfMissing() {
  await fs.mkdir(configDir(), { recursive: true });
  try {
    await fs.access(envPath());
  } catch {
    const env = [
      "# Orynq OpenClaw recorder env",
      "# Put your partner key here:",
      "ORYNQ_PARTNER_KEY=",
      `ORYNQ_OPENCLAW_CONFIG=${configPath()}`,
      ""
    ].join(os.EOL);
    await fs.writeFile(envPath(), env, "utf-8");
  }
}

export async function writeRunnerScripts() {
  await fs.mkdir(configDir(), { recursive: true });

  // POSIX runner
  const runSh = `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$DIR/service.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$DIR/service.env"
  set +a
fi

CFG="\${ORYNQ_OPENCLAW_CONFIG:-$DIR/openclaw.json}"
OUT="$DIR/service.out.log"
ERR="$DIR/service.err.log"
touch "$OUT" "$ERR" 2>/dev/null || true

exec npx --yes @fluxpointstudios/orynq-openclaw@latest start --config "$CFG" >>"$OUT" 2>>"$ERR"
`;
  await fs.writeFile(runShPath(), runSh, "utf-8");
  await fs.chmod(runShPath(), 0o755);

  // Windows runner
  const runPs1 = `$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $dir "service.env"

if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match "^\\s*#") { return }
    if ($_ -match "^\\s*$") { return }
    $parts = $_ -split "=", 2
    if ($parts.Length -eq 2) {
      [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
    }
  }
}

$cfg = $env:ORYNQ_OPENCLAW_CONFIG
if (-not $cfg) { $cfg = Join-Path $dir "openclaw.json" }

$out = Join-Path $dir "service.out.log"
$err = Join-Path $dir "service.err.log"
New-Item -ItemType File -Path $out -Force | Out-Null
New-Item -ItemType File -Path $err -Force | Out-Null

& npx --yes @fluxpointstudios/orynq-openclaw@latest start --config $cfg 1>> $out 2>> $err
`;
  await fs.writeFile(runPs1Path(), runPs1, "utf-8");
}

export async function installService() {
  await writeServiceEnvIfMissing();
  await writeRunnerScripts();

  if (process.platform === "linux") return installSystemdUser();
  if (process.platform === "darwin") return installLaunchdUser();
  if (process.platform === "win32") return installWindowsTask();

  throw new Error(`Unsupported platform: ${process.platform}`);
}

export async function uninstallService() {
  if (process.platform === "linux") return uninstallSystemdUser();
  if (process.platform === "darwin") return uninstallLaunchdUser();
  if (process.platform === "win32") return uninstallWindowsTask();
  throw new Error(`Unsupported platform: ${process.platform}`);
}

export async function startServiceNow() {
  if (process.platform === "linux") return spawnPromise("systemctl", ["--user", "start", "orynq-openclaw.service"]);
  if (process.platform === "darwin") return launchdKickstart();
  if (process.platform === "win32") return spawnPromise("schtasks", ["/Run", "/TN", "Orynq OpenClaw Recorder"]);
}

export async function stopServiceNow() {
  if (process.platform === "linux") return spawnPromise("systemctl", ["--user", "stop", "orynq-openclaw.service"]);
  if (process.platform === "darwin") return launchdStop();
  if (process.platform === "win32") return spawnPromise("schtasks", ["/End", "/TN", "Orynq OpenClaw Recorder"]);
}

export async function restartServiceNow() {
  if (process.platform === "linux") return spawnPromise("systemctl", ["--user", "restart", "orynq-openclaw.service"]);
  if (process.platform === "darwin") return launchdKickstart(); // restart-ish
  if (process.platform === "win32") {
    try { await stopServiceNow(); } catch { /* ignore */ }
    return startServiceNow();
  }
}

async function installSystemdUser() {
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  const unitPath = path.join(unitDir, "orynq-openclaw.service");
  await fs.mkdir(unitDir, { recursive: true });

  const unit = `[Unit]
Description=Orynq OpenClaw Recorder
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/orynq-openclaw/service.env
ExecStart=%h/.config/orynq-openclaw/run.sh
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
  await fs.writeFile(unitPath, unit, "utf-8");
  await spawnPromise("systemctl", ["--user", "daemon-reload"]);
  await spawnPromise("systemctl", ["--user", "enable", "--now", "orynq-openclaw.service"]);

  console.log("systemd user service installed and started:");
  console.log(`   ${unitPath}`);
  console.log("Edit your env:");
  console.log(`   ${envPath()}`);
}

async function uninstallSystemdUser() {
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  const unitPath = path.join(unitDir, "orynq-openclaw.service");
  try { await spawnPromise("systemctl", ["--user", "disable", "--now", "orynq-openclaw.service"]); } catch { /* ignore */ }
  try { await fs.rm(unitPath); } catch { /* ignore */ }
  try { await spawnPromise("systemctl", ["--user", "daemon-reload"]); } catch { /* ignore */ }
  console.log("systemd user service removed.");
}

async function installLaunchdUser() {
  const plistDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(plistDir, "com.fluxpointstudios.orynq-openclaw.plist");
  await fs.mkdir(plistDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.fluxpointstudios.orynq-openclaw</string>
    <key>ProgramArguments</key>
    <array>
      <string>${runShPath()}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${outLogPath()}</string>
    <key>StandardErrorPath</key><string>${errLogPath()}</string>
  </dict>
</plist>
`;
  await fs.writeFile(plistPath, plist, "utf-8");

  const uid = process.getuid?.() ?? 0;
  const target = `gui/${uid}`;

  try {
    await spawnPromise("launchctl", ["bootstrap", target, plistPath]);
  } catch {
    await spawnPromise("launchctl", ["load", "-w", plistPath]);
  }

  console.log("launchd user agent installed:");
  console.log(`   ${plistPath}`);
  console.log("Edit your env:");
  console.log(`   ${envPath()}`);
}

async function uninstallLaunchdUser() {
  const plistDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(plistDir, "com.fluxpointstudios.orynq-openclaw.plist");
  try { await spawnPromise("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, plistPath]); } catch { /* ignore */ }
  try { await spawnPromise("launchctl", ["unload", plistPath]); } catch { /* ignore */ }
  try { await fs.rm(plistPath); } catch { /* ignore */ }
  console.log("launchd user agent removed.");
}

async function installWindowsTask() {
  const taskName = "Orynq OpenClaw Recorder";
  const ps1 = runPs1Path();

  const cmd = [
    "/Create",
    "/F",
    "/TN", taskName,
    "/SC", "ONLOGON",
    "/RL", "LIMITED",
    "/TR", `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`
  ];

  await spawnPromise("schtasks", cmd);

  console.log("Scheduled task installed:");
  console.log(`   ${taskName}`);
  console.log("Edit your env:");
  console.log(`   ${envPath()}`);
}

async function uninstallWindowsTask() {
  const taskName = "Orynq OpenClaw Recorder";
  try { await spawnPromise("schtasks", ["/Delete", "/F", "/TN", taskName]); } catch { /* ignore */ }
  console.log("Scheduled task removed.");
}

async function launchdKickstart() {
  const uid = process.getuid?.() ?? 0;
  const label = "com.fluxpointstudios.orynq-openclaw";
  const target = `gui/${uid}/${label}`;
  try { await spawnPromise("launchctl", ["kickstart", "-k", target]); }
  catch { await spawnPromise("launchctl", ["start", target]); }
}

async function launchdStop() {
  const uid = process.getuid?.() ?? 0;
  const label = "com.fluxpointstudios.orynq-openclaw";
  const target = `gui/${uid}/${label}`;
  await spawnPromise("launchctl", ["stop", target]);
}
