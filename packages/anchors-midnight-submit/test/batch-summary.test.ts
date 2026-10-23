import { describe, expect, it } from "vitest";
import { intentEntries } from "../runner/confirm.js";
import { anchorSummary } from "../src/preflight.js";
import type { PreparedAnchor } from "../src/operator.js";
import { batch, h } from "./batch-fixture.js";

const prepared: PreparedAnchor = { network: "preprod", registry: h(10), author: h(11), kind: 3, commitment: batch.label, attribute: h(0), txHash: h(12), bytes: new Uint8Array([1]), ttl: new Date("2026-10-24T00:00:00Z"), declaredFee: 2n };
const facts = { prepared, label: batch.label, batch, chain: { chain: "Midnight Preprod", genesis: h(13), specVersion: 1000300, ledgerVersion: "8.1.3" }, wallet: { dust: "preprod-dust-test-address" }, dust: 100n };

describe("batch anchor confirmation summaries", () => {
  it("names the exact commitment, member count, genesis and author", () => {
    const text = anchorSummary(facts);
    for (const field of ["3: anchor()", `commitment       ${batch.label}`, `members          ${batch.batches.length}`, `materios genesis ${batch.materiosGenesis}`, `author key       ${prepared.author}`]) expect(text).toContain(field);
  });
  it("keeps legacy per-intent approvals closed to standing batch plans", () => {
    expect(() => intentEntries({ registry: h(10), entries: [batch] })).toThrow(/standing/);
  });
  it("refuses a mismatching commitment, label, attribute or member derivation", () => {
    for (const override of [
      { prepared: { ...prepared, commitment: h(99) } },
      { label: h(99) },
      { prepared: { ...prepared, attribute: h(99) } },
      { batch: { ...batch, materiosGenesis: h(99) } },
      { batch: { ...batch, batches: [...batch.batches].reverse() } },
    ]) expect(() => anchorSummary({ ...facts, ...override })).toThrow();
    const { batch: _, ...missing } = facts;
    expect(() => anchorSummary(missing)).toThrow();
  });
});
