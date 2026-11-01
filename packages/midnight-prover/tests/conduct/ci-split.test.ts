import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { configDefaults } from "vitest/config";
import { describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../../../..");
const { scripts } = JSON.parse(readFileSync(resolve(repo, "packages/midnight-prover/package.json"), "utf8"));

// The CI step of a name, from its list entry to the next one.
function step(name: string): string {
  const ci = readFileSync(resolve(repo, ".woodpecker/ci.yaml"), "utf8");
  const start = ci.indexOf(`\n  - name: ${name}\n`);
  if (start < 0) throw new Error(`.woodpecker/ci.yaml has no ${name} step`);
  const end = ci.indexOf("\n  - name: ", start + 1);
  return ci.slice(start, end < 0 ? undefined : end);
}

describe("AM-9 the conduct circuits compile and run their suite in a CI step of their own", () => {
  it("build:circuits builds the real and on-chain circuits only, and build:conduct checks the conduct pins", () => {
    expect(scripts["build:circuits"]).toBe("node scripts/compile-circuits.mjs && node scripts/compile-onchain.mjs --check");
    expect(scripts["build:conduct"]).toBe("node scripts/compile-conduct.mjs --check");
  });

  it("the root vitest config leaves tests/conduct to the conduct config, which takes the root aliases and runs exactly them", async () => {
    const { default: root } = await import(resolve(repo, "vitest.config.mts"));
    const { default: conduct } = await import(resolve(repo, "packages/midnight-prover/vitest.conduct.config.mts"));
    expect(root.test.exclude).toEqual([...configDefaults.exclude, "packages/midnight-prover/tests/conduct/**"]);
    expect(conduct.root).toBe(repo);
    expect(conduct.test.include).toEqual(["packages/midnight-prover/tests/conduct/**/*.test.ts"]);
    expect(conduct.resolve.alias).toEqual(root.resolve.alias);
  });

  it("build-test neither compiles nor tests the conduct circuits; conduct-circuits does, after build-test and beside midnight-submit", () => {
    const buildTest = step("build-test");
    expect(buildTest).not.toMatch(/conduct/);
    const conduct = step("conduct-circuits");
    expect(conduct).toContain("depends_on: [build-test]");
    const image = (text: string) => /\n {4}image: (\S+)\n/.exec(text)?.[1];
    expect(image(conduct)).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(image(conduct)).toBe(image(buildTest));
    expect(conduct).toContain("\n      COMPACTC: /woodpecker/orynq-midnight-tools/compactc/compactc\n");
    expect(conduct).toContain("\n      MIDNIGHT_PP: /woodpecker/orynq-midnight-tools/zk-params\n");
    expect(step("midnight-submit")).toContain("depends_on: [build-test]");
    const build = conduct.indexOf("pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover build:conduct\n");
    const suite = conduct.indexOf("pnpm exec vitest run --config packages/midnight-prover/vitest.conduct.config.mts --maxWorkers=2\n");
    expect(build).toBeGreaterThan(0);
    expect(suite).toBeGreaterThan(build);
  });
});
