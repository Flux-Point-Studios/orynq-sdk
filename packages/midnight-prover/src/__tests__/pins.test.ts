import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageDir = resolve(import.meta.dirname, "../..");
const workspaceDir = resolve(packageDir, "../..");
const manifest = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
const rootManifest = JSON.parse(readFileSync(resolve(workspaceDir, "package.json"), "utf8")) as { pnpm: { overrides: Record<string, string> } };
const cargoLock = readFileSync(resolve(packageDir, "native/Cargo.lock"), "utf8");
const pnpmLock = readFileSync(resolve(workspaceDir, "pnpm-lock.yaml"), "utf8");

function nativeVersion(crate: string): string | undefined {
  return new RegExp(`\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = "([^"]+)"`).exec(cargoLock)?.[1];
}

function lockedVersions(name: string): string[] {
  const versions = [...pnpmLock.matchAll(new RegExp(`^  /${name.replace("/", "\\/")}@([^:(]+)[:(]`, "gm"))].map(match => match[1]!);
  return [...new Set(versions)];
}

// The JS runtime executes and decodes what the native ledger verified, so both must be the same release.
describe("JS and native Midnight pins", () => {
  it.each([
    ["@midnight-ntwrk/onchain-runtime-v3", "midnight-onchain-runtime"],
    ["@midnight-ntwrk/ledger-v8", "midnight-ledger"],
  ])("%s matches the native verifier's %s", (npmName, crate) => {
    expect(nativeVersion(crate)).toBeDefined();
    expect(manifest.dependencies[npmName]).toBe(nativeVersion(crate));
    expect(lockedVersions(npmName)).toEqual([nativeVersion(crate)]);
  });

  it("forces every workspace consumer onto the same onchain runtime", () => {
    expect(rootManifest.pnpm.overrides["@midnight-ntwrk/onchain-runtime-v3"]).toBe(manifest.dependencies["@midnight-ntwrk/onchain-runtime-v3"]);
  });
});
