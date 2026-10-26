import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readAnchorPlan } from "../src/anchor-plan.js";
import { fresh } from "./fakes.js";

import { h, batches, batch } from "./batch-fixture.js";
const parse = (entry: unknown) => {
  const file = fresh("batch-plan.json");
  writeFileSync(file, JSON.stringify({ registry: h(10), entries: [entry] }));
  return readAnchorPlan(file);
};

describe("canonical batch anchor plans", () => {
  it("accepts derived, ordered batch members bound by the commitment label", () => {
    expect(parse(batch).entries).toEqual([batch]);
  });
  it.each([
    ["wrong label", { ...batch, label: h(0) }],
    ["wrong genesis", { ...batch, materiosGenesis: h(8) }],
    ["noncanonical genesis", { ...batch, materiosGenesis: `0x${batch.materiosGenesis}` }],
    ["missing members", { ...batch, batches: [] }],
    ["too many members", { ...batch, batches: Array(1025).fill(batches[0]) }],
    ["duplicate members", { ...batch, batches: [batches[0], batches[0]] }],
    ["wrong order", { ...batch, batches: [...batches].reverse() }],
    ["wrong anchor derivation", { ...batch, batches: [{ ...batches[0], rootHash: h(99) }, ...batches.slice(1)] }],
    ["unknown member field", { ...batch, batches: [{ ...batches[0], extra: true }, ...batches.slice(1)] }],
    ["unknown entry field", { ...batch, attribute: h(1) }],
  ])("rejects %s", (_, entry) => { expect(() => parse(entry)).toThrow(); });
});
