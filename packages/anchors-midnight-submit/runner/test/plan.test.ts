import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readAnchorPlan } from "../../src/anchor-plan.js";
import { fresh } from "../../test/fakes.js";
import { fillPlan, landedDeploy } from "../plan.js";
import { ENTRIES, PLACEHOLDER, deployJournal, deployKey } from "./helpers.js";

const template = (registry = PLACEHOLDER, entries: unknown[] = ENTRIES) => {
  const path = fresh("plan.template.json");
  writeFileSync(path, `${JSON.stringify({ registry, entries }, null, 2)}\n`);
  return path;
};
const journal = (change: Parameters<typeof deployJournal>[1] = {}) => deployJournal(undefined, change);

describe("landedDeploy", () => {
  it("names the registry of FPS's mainnet deploy the journal holds landed and read back in its block", async () => {
    const { path, address, txHash } = await journal();
    expect(landedDeploy(path)).toEqual({ address, txHash, height: 2_048_321, blockHash: "ab".repeat(32) });
  });

  it("is null where no deploy journal is, and creates none", () => {
    const missing = fresh("mainnet-deploy.sqlite");
    expect(landedDeploy(missing)).toBeNull();
    expect(existsSync(missing)).toBe(false);
  });

  it.each([
    ["a mainnet deploy that has not landed", { state: "pending", block: null }],
    ["a landed deploy whose block was never read back", { block: null }],
    ["a landed preprod deploy", { network: "preprod" }],
    ["a landed deploy journalled under another registry state's key", { key: deployKey("mainnet", "ee".repeat(32)) }],
  ])("is null for %s", async (_, change) => {
    expect(landedDeploy((await journal(change)).path)).toBeNull();
  });
});

describe("fillPlan", () => {
  const REGISTRY = "cd".repeat(32);

  it("writes the template's entries for the registry, owner-only, as anchor-mainnet reads it", () => {
    const out = fresh("plan.json");
    expect(fillPlan(template(), REGISTRY, out)).toBe(true);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readAnchorPlan(out).registry).toBe(REGISTRY);
    expect(readFileSync(out, "utf8")).toBe(`${JSON.stringify({ registry: REGISTRY, entries: ENTRIES }, null, 2)}\n`);
  });

  it("leaves an identical plan in place and refuses to replace a different one", () => {
    const tpl = template();
    const out = fresh("plan.json");
    fillPlan(tpl, REGISTRY, out);
    expect(fillPlan(tpl, REGISTRY, out)).toBe(false);
    writeFileSync(out, "{}");
    expect(() => fillPlan(tpl, REGISTRY, out)).toThrow(`${out} already exists and differs from the plan for registry ${REGISTRY}; nothing was written`);
    expect(readFileSync(out, "utf8")).toBe("{}");
  });

  it("refuses a template that is not JSON without quoting it", () => {
    const bad = fresh("plan.template.json");
    writeFileSync(bad, `{"registry": "${PLACEHOLDER}", "entries": [ "44${"44".repeat(31)}`);
    const out = fresh("plan.json");
    expect(() => fillPlan(bad, REGISTRY, out)).toThrow(`${bad} is not JSON`);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a template whose registry is not the placeholder", () => {
    const tpl = template("ef".repeat(32));
    expect(() => fillPlan(tpl, REGISTRY, fresh("plan.json"))).toThrow(`${tpl} names registry ${"ef".repeat(32)}, not the placeholder ${PLACEHOLDER}; nothing was written`);
  });

  it("refuses a template the anchor tool's parser refuses, and writes nothing", () => {
    const tpl = template(PLACEHOLDER, [{ ...ENTRIES[0], attribute: "44".repeat(32) }]);
    const out = fresh("plan.json");
    expect(() => fillPlan(tpl, REGISTRY, out)).toThrow(/a kind-1 entry takes no attribute/);
    expect(existsSync(out)).toBe(false);
  });
});
