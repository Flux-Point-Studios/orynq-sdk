import fs from "node:fs/promises";
import path from "node:path";
import { defaultConfig } from "@fluxpointstudios/orynq-sdk-recorder-openclaw";
import { configDir, configPath, guessOpenClawRoot } from "../platform/paths.js";
import { installService, writeRunnerScripts, writeServiceEnvIfMissing } from "../platform/services.js";

export async function install(opts: { openclawRoot?: string; outDir?: string; service?: boolean }) {
  const openclawRoot = path.resolve(opts.openclawRoot || guessOpenClawRoot());
  const cfg = defaultConfig({
    openclawRoot,
    outDir: opts.outDir ? path.resolve(opts.outDir) : undefined
  });

  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(cfg, null, 2), "utf-8");

  await writeServiceEnvIfMissing();
  await writeRunnerScripts();

  console.log(`Installed config: ${configPath()}`);
  console.log(`   OpenClaw root: ${cfg.openclawRoot}`);
  console.log(`   Recorder out:  ${cfg.outDir}`);
  console.log("");

  if (opts.service) {
    await installService();
  } else {
    console.log("Next:");
    console.log(`  - Put your key in: ${path.join(configDir(), "service.env")}`);
    console.log("  - Run:            orynq-openclaw start");
    console.log("  - Optional daemon: orynq-openclaw install --service");
  }
}
