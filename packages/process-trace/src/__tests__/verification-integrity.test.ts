import { describe, expect, it } from "vitest";
import {
  addEvent, addSpan, buildSpanMerkleTree, closeSpan, createTrace,
  computeEventHash, finalizeTrace, generateMerkleProof, selectiveDisclose, verifyBundle,
  verifyDisclosure, verifyMerkleProof, verifySpanDisclosure, verifySpanInclusion,
} from "../index.js";
import type { TraceSpan } from "../index.js";

async function trace(spanCount = 1) {
  const run = await createTrace({ agentId: "verification-regression" });
  for (let i = 0; i < spanCount; i++) {
    const span = addSpan(run, { name: `span-${i}`, visibility: "public" });
    await addEvent(run, span.id, {
      kind: "output", stream: "stdout", content: `original-${i}`, visibility: "public",
    });
    await closeSpan(run, span.id);
  }
  return finalizeTrace(run);
}

async function disclosure() {
  const bundle = await trace();
  const result = await selectiveDisclose(bundle, [bundle.privateRun.spans[0]!.id], "full");
  const disclosed = result.disclosedSpans[0]!;
  return { bundle, result, disclosed };
}

describe("disclosed event integrity", () => {
  it.each([false, true])("rejects changed public-view event bodies (rehash: %s)", async (rehash) => {
    const bundle = await trace();
    bundle.publicView = structuredClone(bundle.publicView);
    const event = bundle.publicView.publicSpans[0]!.events[0]!;
    Object.assign(event, { content: "altered public view" });
    if (rehash) event.hash = await computeEventHash(event);
    const result = await verifyBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.checks.eventHashesValid).toBe(false);
  });

  it("rejects changed public-view span headers with the original hash", async () => {
    const bundle = await trace();
    bundle.publicView = structuredClone(bundle.publicView);
    bundle.publicView.publicSpans[0]!.name = "altered public span";
    const result = await verifyBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.checks.spanHashesValid).toBe(false);
  });

  it("rejects changed event content with its original hash", async () => {
    const { bundle, result, disclosed } = await disclosure();
    Object.assign(disclosed.events![0]!, { content: "altered" });
    const verified = await verifySpanDisclosure({ ...disclosed, span: disclosed.span!, events: disclosed.events! }, bundle.merkleRoot);
    expect(verified.valid).toBe(false);
    expect(verified.errors.join("\n")).toContain(`Event hash mismatch for ${disclosed.events![0]!.id}`);
    expect((await verifyDisclosure(result, bundle.rootHash, bundle.merkleRoot)).valid).toBe(false);
  });

  it("rejects changed event content in standalone span inclusion", async () => {
    const { disclosed } = await disclosure();
    Object.assign(disclosed.events![0]!, { content: "altered" });
    expect(await verifySpanInclusion(disclosed.proof, disclosed.span!, disclosed.events!)).toBe(false);
  });

  it.each(["span", "events"] as const)("requires %s in full mode", async (field) => {
    const { bundle, result, disclosed } = await disclosure();
    delete disclosed[field];
    const verified = await verifyDisclosure(result, bundle.rootHash, bundle.merkleRoot);
    expect(verified.valid).toBe(false);
    expect(verified.errors.join("\n")).toContain("requires span and events");
  });

  it("binds the disclosed span identifier to the span body", async () => {
    const { bundle, result, disclosed } = await disclosure();
    disclosed.spanId = "another-span";
    expect((await verifyDisclosure(result, bundle.rootHash, bundle.merkleRoot)).valid).toBe(false);
  });

  it("verifies event bodies even when supplied in membership mode", async () => {
    const { bundle, result, disclosed } = await disclosure();
    result.mode = "membership";
    Object.assign(disclosed.events![0]!, { content: "altered" });
    expect((await verifyDisclosure(result, bundle.rootHash, bundle.merkleRoot)).valid).toBe(false);
  });

  it("keeps honest full disclosures and bundles valid", async () => {
    const { bundle, result, disclosed } = await disclosure();
    expect((await verifyBundle(bundle)).valid).toBe(true);
    expect((await verifyDisclosure(result, bundle.rootHash, bundle.merkleRoot)).valid).toBe(true);
    expect(await verifySpanInclusion(disclosed.proof, disclosed.span!, disclosed.events!)).toBe(true);
  });
});

describe("synchronous Merkle proofs", () => {
  it.each([
    [1, "45494d324565b89f4a6aed67a0d3f0c08a8e3e2325f91661d9c4b4a013c52eaa"],
    [2, "1959d199923bbcebec58a3fe65f8c05187fc7e3eee628ae5deffb147a5eb7bae"],
    [3, "bf71165c6c51b249aee80e893247bbd2c487eb3d39cc28dba34addf8442a26cb"],
    [4, "59317633b0a88d85d18b41046cc12783d20f1410767944be102cff53629bc83f"],
    [5, "04332e6323751f49f13077609146fbd56fbe200d100ec4b77e1ea6f933f12e9b"],
    [8, "546a841a530e2b6154643b65a1017972af54237e92f21237ff11c04b90e763f6"],
  ] as const)("preserves the v1 root for %i fixed spans", async (count, expectedRoot) => {
    const spans: TraceSpan[] = Array.from({ length: count }, (_, i) => ({
      id: `span-${i}`, spanSeq: i, name: `span-${i}`, status: "completed",
      visibility: "public", startedAt: "2024-01-15T10:30:00.000Z",
      eventIds: [], childSpanIds: [],
    }));
    const tree = await buildSpanMerkleTree(spans, []);
    expect(tree.rootHash).toBe(expectedRoot);
    for (let i = 0; i < count; i++) {
      expect(await verifyMerkleProof(generateMerkleProof(tree, i))).toBe(true);
    }
  });

  it.each([3, 4, 5, 8])("verifies every leaf in a %i-leaf tree", async (count) => {
    const bundle = await trace(count);
    const tree = await buildSpanMerkleTree(bundle.privateRun.spans, bundle.privateRun.events);
    expect(tree.rootHash).toBe(bundle.merkleRoot);
    for (let index = 0; index < count; index++) {
      const proof = generateMerkleProof(tree, index);
      expect(await verifyMerkleProof(proof)).toBe(true);
      expect(proof.siblings.every(({ hash }) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
    }
  });

  it.each([-1, 0.5, 1, 2, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects inconsistent proof leafIndex %s", async (leafIndex) => {
      const bundle = await trace(2);
      const tree = await buildSpanMerkleTree(bundle.privateRun.spans, bundle.privateRun.events);
      const proof = generateMerkleProof(tree, 0);
      expect(await verifyMerkleProof({ ...proof, leafIndex })).toBe(false);
    },
  );
});
