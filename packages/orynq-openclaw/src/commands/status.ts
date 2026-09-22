import { spawn } from "node:child_process";
import fs from "node:fs";
import { configPath, envPath, outLogPath, errLogPath } from "../platform/paths.js";

function run(cmd: string, args: string[]) {
  return new Promise<number>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("exit", (code) => resolve(code ?? 0));
    p.on("error", reject);
  });
}

function exists(p: string) {
  try { return fs.existsSync(p); } catch { return false; }
}

export async function status() {
  // Linux systemd user
  if (process.platform === "linux") {
    try {
      const code = await run("systemctl", ["--user", "status", "orynq-openclaw.service", "--no-pager"]);
      if (code === 0) return;
    } catch { /* ignore */ }
  }

  // mac launchd
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    const target = `gui/${uid}/com.fluxpointstudios.orynq-openclaw`;
    try {
      const code = await run("launchctl", ["print", target]);
      if (code === 0) return;
    } catch { /* ignore */ }
  }

  // windows schtasks
  if (process.platform === "win32") {
    const taskName = "Orynq OpenClaw Recorder";
    try {
      const code = await run("schtasks", ["/Query", "/TN", taskName, "/V", "/FO", "LIST"]);
      if (code === 0) return;
    } catch { /* ignore */ }
  }

  console.log("Could not query service manager (or service not installed).");
  console.log("");
  console.log("Expected files:");
  console.log(`- Config:     ${configPath()}   (${exists(configPath()) ? "exists" : "missing"})`);
  console.log(`- Service env:${envPath()}      (${exists(envPath()) ? "exists" : "missing"})`);
  console.log(`- Out log:    ${outLogPath()}   (${exists(outLogPath()) ? "exists" : "missing"})`);
  console.log(`- Err log:    ${errLogPath()}   (${exists(errLogPath()) ? "exists" : "missing"})`);
  console.log("");
  console.log("Tips:");
  console.log("- Install daemon: orynq-openclaw install --service");
  console.log("- View logs:      orynq-openclaw logs -f");
}
