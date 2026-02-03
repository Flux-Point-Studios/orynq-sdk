import fs from "node:fs/promises";
import { uninstallService } from "../platform/services.js";
import { configDir } from "../platform/paths.js";

export async function uninstall(opts: { service: boolean; purge: boolean }) {
  if (opts.service) await uninstallService();
  if (opts.purge) {
    await fs.rm(configDir(), { recursive: true, force: true });
    console.log("Purged config directory.");
  }
}
