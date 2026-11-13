import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { configDefaults } from "vitest/config";
import { describe, expect, it } from "vitest";

// build-test's root run collects this file and no conduct test, so removing or disabling the conduct-circuits step fails CI here.
const repo = resolve(import.meta.dirname, "../../..");
const CONDUCT_TESTS = "packages/midnight-prover/tests/conduct";
const CONDUCT_CONFIG = "packages/midnight-prover/vitest.conduct.config.mts";
const { scripts } = JSON.parse(readFileSync(resolve(repo, "packages/midnight-prover/package.json"), "utf8"));

const CI = readFileSync(resolve(repo, ".woodpecker/ci.yaml"), "utf8");

/**
 * A step of a Woodpecker pipeline file as its keys, each with its value and the lines indented under it.
 * Only an entry of the top-level `steps:` list is a step: the same block under any other key runs nothing.
 */
function step(name: string, ci = CI): Readonly<Record<string, string>> {
  const steps = ci.indexOf("\nsteps:\n");
  if (steps < 0) throw new Error(".woodpecker/ci.yaml has no steps list");
  // The list ends at the next line that starts a top-level key.
  const after = /\n[^\s#]/.exec(ci.slice(steps + 1));
  const list = ci.slice(steps, after === null ? undefined : steps + 1 + after.index);
  const start = list.indexOf(`\n  - name: ${name}\n`);
  if (start < 0) throw new Error(`.woodpecker/ci.yaml has no ${name} step`);
  const end = list.indexOf("\n  - name: ", start + 1);
  const keys: Record<string, string> = {};
  let key: string | undefined;
  for (const line of list.slice(start, end < 0 ? undefined : end).split("\n").slice(2)) {
    const top = /^ {4}([\w-]+):(.*)$/.exec(line);
    if (top !== null) keys[key = top[1]!] = top[2]!.trim();
    else if (key !== undefined && line.startsWith("      ")) keys[key] += `\n${line.slice(6)}`;
    else if (line.trim() !== "" && !line.startsWith("  #")) throw new Error(`unexpected line in the ${name} step: ${JSON.stringify(line)}`);
  }
  return keys;
}

/** Every file under a directory, recursively. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)]);
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

  it("conduct-circuits runs once the submitter and the real proofs have passed, never beside them, with build-test's image and Compact install, build:conduct then the conduct suite", () => {
    const buildTest = step("build-test");
    expect(Object.values(buildTest).join("\n")).not.toMatch(/conduct/);
    const conduct = step("conduct-circuits");
    expect(Object.keys(conduct)).toEqual(["image", "depends_on", "environment", "commands"]);
    expect(conduct.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(conduct.image).toBe(buildTest.image);
    expect(conduct.depends_on).toBe("[midnight-submit, midnight-real-proofs]");
    expect(conduct.environment).toBe(buildTest.environment);
    expect(conduct.environment).toBe("\nCOMPACTC: /woodpecker/orynq-midnight-tools/compactc/compactc\nMIDNIGHT_PP: /woodpecker/orynq-midnight-tools/zk-params");
    expect(conduct.commands).toBe([
      "", "- corepack enable", "- |", "  su node -s /bin/bash -c '", "    set -e",
      "    pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover build:conduct",
      `    pnpm exec vitest run --config ${CONDUCT_CONFIG} --maxWorkers=2`,
      "  '",
    ].join("\n"));
    expect(step("midnight-submit").depends_on).toBe("[build-test]");
    expect(step("midnight-real-proofs").depends_on).toBe("[midnight-native]");
    expect(step("midnight-native").depends_on).toBe("[build-test]");
  });

  it("a conduct-circuits block outside the steps list is not a step", () => {
    const from = CI.indexOf("\n  - name: conduct-circuits\n");
    const to = CI.indexOf("\n  - name: ", from + 1);
    const block = CI.slice(from, to);
    expect(block).toContain("vitest.conduct.config.mts");
    const moved = `${CI.slice(0, from)}${CI.slice(to)}\nvariables:${block}\n`;
    expect(() => step("conduct-circuits", moved)).toThrow(".woodpecker/ci.yaml has no conduct-circuits step");
    expect(step("build-test", moved)).toEqual(step("build-test"));
    // The pipeline itself runs on every pull request and on pushes to main.
    expect(CI.slice(0, CI.indexOf("\nsteps:\n"))).toMatch(/^when:\n  - event: pull_request\n  - event: push\n    branch: main\n/);
  });

  it("no conduct test is skipped, pending, focused or expected to fail, so a green conduct step ran every test", () => {
    const marked = files(resolve(repo, CONDUCT_TESTS))
      .filter(file => /\.(ts|mts|mjs)$/.test(file))
      .flatMap(file => readFileSync(file, "utf8").split("\n")
        .map((line, i) => ({ at: `${relative(repo, file)}:${i + 1}`, line }))
        .filter(({ line }) => /\b(?:describe|it|test|suite|bench)\s*\.\s*(?:skip|todo|only|fails|skipIf|runIf)\b|\bx(?:it|describe|test)\s*\(|\.skip\s*\(\s*\)/.test(line))
        .map(({ at }) => at));
    expect(marked).toEqual([]);
  });
});
