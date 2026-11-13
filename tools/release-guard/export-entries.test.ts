import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// An export subpath that the build never emits installs fine and fails on import. Each
// published package's export map is held against what its build is told to produce.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packages = readdirSync(join(root, "packages"))
  .map((dir) => join(root, "packages", dir))
  .filter((dir) => existsSync(join(dir, "package.json")))
  .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) }))
  .filter(({ manifest }) => !manifest.private && manifest.exports);

const targets = (exports: unknown): string[] =>
  typeof exports === "string" ? [exports] : exports && typeof exports === "object" ? Object.values(exports).flatMap(targets) : [];

// `./dist/signers/index.js`, `.cjs`, `.d.ts` and `.d.cts` all come from `src/signers/index.ts`.
const sourceOf = (target: string) => /^\.\/dist\/(.+?)(?:\.d)?\.c?[jt]s$/.exec(target)?.[1];

describe("every export subpath is a build entry", () => {
  it("covers the workspace's published packages", () => {
    expect(packages.length).toBeGreaterThan(20);
  });

  it.each(packages.map(({ dir, manifest }) => [manifest.name as string, dir, manifest] as const))("%s", (_name, dir, manifest) => {
    const tsup = join(dir, "tsup.config.ts");
    const built = existsSync(tsup) ? readFileSync(tsup, "utf8") : undefined;
    const missing = [...new Set(targets(manifest.exports))].filter((target) => {
      const source = sourceOf(target);
      if (source === undefined) return true;
      // tsup emits only its listed entries; tsc emits every source file.
      return built === undefined ? !existsSync(join(dir, "src", `${source}.ts`)) : !built.includes(`"src/${source}.ts"`);
    });
    expect(missing).toEqual([]);
  });
});
