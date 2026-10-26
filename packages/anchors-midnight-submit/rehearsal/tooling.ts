import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export function toolingCommit(): string {
  const cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "packages/anchors-midnight-submit", "packages/anchors-midnight"], { cwd, encoding: "utf8" });
  if (dirty.trim()) throw new Error("Rehearsal tooling has uncommitted changes; commit or restore it before recording evidence");
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

// Resolve active dependency links rather than stale entries in a pnpm store.
export function installedPins() {
  const require = createRequire(import.meta.url);
  const version = (name: string): string => {
    const file = require.resolve.paths(name)?.map(base => join(base, name, "package.json")).find(existsSync);
    if (!file) throw new Error(`Rehearsal dependency ${name} is not installed`);
    return JSON.parse(readFileSync(file, "utf8")).version;
  };
  const compiler = /\nversion=([^\n]+)/.exec(readFileSync(new URL("../../../tools/compactc/install.sh", import.meta.url), "utf8"))?.[1];
  if (!compiler) throw new Error("Rehearsal compiler pin is missing");
  return {
    compactc: compiler,
    compactcPinSource: "tools/compactc/install.sh",
    ledger: version("@midnight-ntwrk/ledger-v8"),
    walletFacade: version("@midnight-ntwrk/wallet-sdk-facade"),
    dustWallet: version("@midnight-ntwrk/wallet-sdk-dust-wallet"),
    zkir: version("@midnight-ntwrk/zkir-v2"),
  };
}
