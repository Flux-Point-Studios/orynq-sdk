import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { readAnchorPlan } from "../src/anchor-plan.js";
import { fresh } from "./fakes.js";

const REGISTRY = "a1".repeat(32);
const H = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const kind1 = { label: "git-head", kind: 1, rootHash: H(1), manifestHash: H(2), merkleRoot: H(3) };
const kind2 = { label: "hidden-suite", kind: 2, rootHash: H(4), manifestHash: H(5), merkleRoot: H(6), attribute: H(7) };
const plan = (value: unknown) => {
  const path = fresh("plan.json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
};

describe("readAnchorPlan", () => {
  it("reads the registry and each entry in order, kind 2 with its attribute", () => {
    const { merkleRoot: _, ...noMerkle } = kind1;
    expect(readAnchorPlan(plan({ registry: REGISTRY, entries: [kind1, kind2, { ...noMerkle, label: "no-merkle" }] }))).toEqual({
      registry: REGISTRY,
      entries: [
        { label: "git-head", kind: 1, entry: { rootHash: H(1), manifestHash: H(2), merkleRoot: H(3) } },
        { label: "hidden-suite", kind: 2, entry: { rootHash: H(4), manifestHash: H(5), merkleRoot: H(6) }, attribute: H(7) },
        { label: "no-merkle", kind: 1, entry: { rootHash: H(1), manifestHash: H(2) } },
      ],
    });
  });

  it("takes hashes in the forms process-trace and anchors-cardano write them", () => {
    const entries = [{ ...kind1, rootHash: `sha256:${H(1)}`, manifestHash: `0x${H(2)}` }];
    expect(readAnchorPlan(plan({ registry: REGISTRY, entries })).entries[0]!.entry).toEqual({ rootHash: `sha256:${H(1)}`, manifestHash: `0x${H(2)}`, merkleRoot: H(3) });
  });

  it.each([
    ["JSON it cannot parse", "{", /plan\.json is not JSON/],
    ["something other than an object", [], /plan\.json: the plan must be an object/],
    ["an unknown top-level field", { registry: REGISTRY, entries: [kind1], network: "mainnet" }, /plan\.json: unknown field "network"/],
    ["an unknown entry field", { registry: REGISTRY, entries: [{ ...kind1, salt: H(9) }] }, /plan\.json: entries\[0\]: unknown field "salt"/],
    ["a missing registry", { entries: [kind1] }, /plan\.json: registry must be 64 lowercase hex characters/],
    ["a registry that is not 64 lowercase hex", { registry: REGISTRY.toUpperCase(), entries: [kind1] }, /plan\.json: registry must be 64 lowercase hex characters/],
    ["no entries", { registry: REGISTRY, entries: [] }, /plan\.json: entries must be a non-empty array/],
    ["an entry that is not an object", { registry: REGISTRY, entries: ["git-head"] }, /plan\.json: entries\[0\] must be an object/],
    ["a kind the registry does not write", { registry: REGISTRY, entries: [{ ...kind1, kind: 3 }] }, /plan\.json: entries\[0\]: kind must be 1 or 2/],
    ["a kind-2 entry without its attribute", { registry: REGISTRY, entries: [{ ...kind2, attribute: undefined }] }, /plan\.json: entries\[0\]: a kind-2 entry needs an attribute/],
    ["a kind-1 entry with an attribute", { registry: REGISTRY, entries: [{ ...kind1, attribute: H(7) }] }, /plan\.json: entries\[0\]: a kind-1 entry takes no attribute/],
    ["a hash that is not 32 bytes", { registry: REGISTRY, entries: [{ ...kind1, manifestHash: "ab" }] }, /plan\.json: entries\[0\]: manifestHash must be 32 bytes/],
    ["a hash that is not a string", { registry: REGISTRY, entries: [{ ...kind1, rootHash: 7 }] }, /plan\.json: entries\[0\]: rootHash must be a string/],
    ["a missing root hash", { registry: REGISTRY, entries: [{ ...kind1, rootHash: undefined }] }, /plan\.json: entries\[0\]: rootHash must be a string/],
    ["a label a terminal could misprint", { registry: REGISTRY, entries: [{ ...kind1, label: "git\u001b[2Jhead" }] }, /plan\.json: entries\[0\]: label must be 1 to 64 letters, digits, "\.", "_" or "-", starting with a letter or digit/],
    ["a repeated label", { registry: REGISTRY, entries: [kind1, { ...kind1, rootHash: H(8) }] }, /plan\.json: entries\[1\]: label "git-head" repeats entries\[0\]/],
    ["the same anchor twice under two labels", { registry: REGISTRY, entries: [kind1, { ...kind1, label: "again", rootHash: `sha256:${H(1)}` }] }, /plan\.json: entries\[1\]: the same anchor as entries\[0\]/],
  ])("refuses %s", (_, value, error) => {
    expect(() => readAnchorPlan(plan(value))).toThrow(error);
  });
});
