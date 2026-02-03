import { spawn } from "node:child_process";
import fs from "node:fs";
import { outLogPath, errLogPath } from "../platform/paths.js";

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

export async function logs(opts: { follow: boolean }) {
  const out = outLogPath();
  const err = errLogPath();

  // Linux: prefer journalctl
  if (process.platform === "linux") {
    try {
      const args = ["--user", "-u", "orynq-openclaw.service"];
      if (opts.follow) args.push("-f");
      args.push("--no-pager");
      const code = await run("journalctl", args);
      if (code === 0) return;
    } catch { /* ignore */ }
  }

  if (process.platform === "darwin" || process.platform === "linux") {
    if (!exists(out) && !exists(err)) {
      console.log("No log files found yet.");
      console.log(`Expected:\n  ${out}\n  ${err}`);
      console.log("Start the service (or run orynq-openclaw start once).");
      return;
    }
    if (opts.follow) {
      await run("tail", ["-F", out, err].filter(Boolean));
      return;
    }
    await run("tail", ["-n", "200", out]);
    if (exists(err)) await run("tail", ["-n", "200", err]);
    return;
  }

  if (process.platform === "win32") {
    if (!exists(out) && !exists(err)) {
      console.log("No log files found yet.");
      console.log(`Expected:\n  ${out}\n  ${err}`);
      console.log("Start the task (or run orynq-openclaw start once).");
      return;
    }

    if (opts.follow) {
      await run("powershell.exe", ["-NoProfile", "-Command", `Get-Content -Path "${out}","${err}" -Wait`]);
      return;
    }

    await run("powershell.exe", ["-NoProfile", "-Command", `Get-Content -Path "${out}","${err}" -Tail 200`]);
    return;
  }
}
