import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { configDefaults } from "vitest/config";
import { describe, expect, it } from "vitest";

// build-test's root run collects this file and no conduct test, so removing or disabling the conduct-circuits step fails CI here.
const repo = resolve(import.meta.dirname, "../../..");
const CONDUCT_TESTS = "packages/midnight-prover/tests/conduct";
const CONDUCT_CONFIG = "packages/midnight-prover/vitest.conduct.config.mts";
const { scripts } = JSON.parse(readFileSync(resolve(repo, "packages/midnight-prover/package.json"), "utf8"));

/** A step of .woodpecker/ci.yaml as its keys, each with its value and the lines indented under it. */
function step(name: string): Readonly<Record<string, string>> {
  const ci = readFileSync(resolve(repo, ".woodpecker/ci.yaml"), "utf8");
  const start = ci.indexOf(`\n  - name: ${name}\n`);
  if (start < 0) throw new Error(`.woodpecker/ci.yaml has no ${name} step`);
  const end = ci.indexOf("\n  - name: ", start + 1);
  const keys: Record<string, string> = {};
  let key: string | undefined;
  for (const line of ci.slice(start, end < 0 ? undefined : end).split("\n").slice(2)) {
    const top = /^ {4}([\w-]+):(.*)$/.exec(line);
    if (top !== null) keys[key = top[1]!] = top[2]!.trim();
    else if (key !== undefined && line.startsWith("      ")) keys[key] += `\n${line.slice(6)}`;
    else if (line.trim() !== "" && !line.startsWith("  #")) throw new Error(`unexpected line in the ${name} step: ${JSON.stringify(line)}`);
  }
  return keys;
}

describe("AM-9 the conduct circuits compile and run their suite in a CI step of their own", () => {
  it("build:circuits builds the real and on-chain circuits only, and build:conduct checks the conduct pins", () => {
    expect(scripts["build:circuits"]).toBe("node scripts/compile-circuits.mjs && node scripts/compile-onchain.mjs --check");
    expect(scripts["build:conduct"]).toBe("node scripts/compile-conduct.mjs --check");
  });

  it("the root config collects this guard and leaves tests/conduct to the conduct config, which runs all of it with the root aliases", async () => {
    const { default: root } = await import(resolve(repo, "vitest.config.mts"));
    const { default: conduct } = await import(resolve(repo, CONDUCT_CONFIG));
    expect(root.test.include).toContain("packages/**/tests/**/*.test.ts");
    expect(root.test.exclude).toEqual([...configDefaults.exclude, `${CONDUCT_TESTS}/**`]);
    expect(Object.keys(conduct).sort()).toEqual(["resolve", "root", "test"]);
    expect(conduct.root).toBe(repo);
    expect(conduct.resolve.alias).toEqual(root.resolve.alias);
    const { globals, environment, testTimeout, hookTimeout } = root.test;
    expect(conduct.test).toEqual({ globals, environment, testTimeout, hookTimeout, include: [`${CONDUCT_TESTS}/**/*.test.ts`] });
  });

  it("conduct-circuits always runs after build-test, beside midnight-submit, with its image and Compact install, build:conduct then the conduct suite", () => {
    const buildTest = step("build-test");
    expect(Object.values(buildTest).join("\n")).not.toMatch(/conduct/);
    const conduct = step("conduct-circuits");
    expect(Object.keys(conduct)).toEqual(["image", "depends_on", "environment", "commands"]);
    expect(conduct.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(conduct.image).toBe(buildTest.image);
    expect(conduct.depends_on).toBe("[build-test]");
    expect(conduct.environment).toBe(buildTest.environment);
    expect(conduct.environment).toBe("\nCOMPACTC: /woodpecker/orynq-midnight-tools/compactc/compactc\nMIDNIGHT_PP: /woodpecker/orynq-midnight-tools/zk-params");
    expect(conduct.commands).toBe([
      "", "- corepack enable", "- |", "  su node -s /bin/bash -c '", "    set -e",
      "    pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover build:conduct",
      `    pnpm exec vitest run --config ${CONDUCT_CONFIG} --maxWorkers=2`,
      "  '",
    ].join("\n"));
    expect(step("midnight-submit").depends_on).toBe("[build-test]");
  });
});
