import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  addEvent, addSpan, buildSpanMerkleTree, closeSpan, createBundle, createTrace,
  computeEventHash, computeRollingHash, computeRootHash, computeSpanHash, finalizeTrace,
  generateMerkleProof, getBundleSpanEvents, selectiveDisclose, verifyBundle,
  verifyDisclosure, verifyMerkleProof, verifySpanDisclosure, verifySpanInclusion,
} from "../index.js";
import type { DisclosureResult, MerkleProof, TraceBundle, TraceRun, TraceSpan } from "../index.js";

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

/** Odd spans private; every span mixes public and private events. */
async function mixedTrace(spanCount: number) {
  const run = await createTrace({ agentId: "verification-regression" });
  for (let i = 0; i < spanCount; i++) {
    const span = addSpan(run, {
      name: `span-${i}`, visibility: i % 2 === 1 ? "private" : "public", metadata: { step: i },
    });
    await addEvent(run, span.id, { kind: "command", command: `deploy-${i}`, visibility: "public" });
    await addEvent(run, span.id, { kind: "decision", decision: "approve", visibility: "private" });
    await addEvent(run, span.id, {
      kind: "observation", observation: "state", data: { nested: { k: [1, { z: "y" }] } }, visibility: "public",
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

const orderedSpans = (bundle: TraceBundle) =>
  [...bundle.privateRun.spans].sort((a, b) => a.spanSeq - b.spanSeq);

/** What a verifier holding the verified bundle knows: each span's leaf hash and the leaf count. */
async function authenticatedLeaves(bundle: TraceBundle) {
  const tree = await buildSpanMerkleTree(bundle.privateRun.spans, bundle.privateRun.events);
  return {
    leafHashes: Object.fromEntries(orderedSpans(bundle).map((span, i) => [span.id, tree.leafHashes[i]!])),
    leafCount: tree.leafCount,
  };
}

const nodeHash = (left: string, right: string) =>
  createHash("sha256").update(`poi-trace:node:v1|${left}|${right}`, "utf8").digest("hex");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("disclosed event integrity", () => {
  it.each([false, true])("rejects changed public-view event bodies (rehash: %s)", async (rehash) => {
    const bundle = await trace();
    bundle.publicView = structuredClone(bundle.publicView);
    const event = bundle.publicView.publicSpans[0]!.events[0]!;
    Object.assign(event, { content: "altered public view" });
    if (rehash) event.hash = await computeEventHash(event);
    const result = await verifyBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.checks.publicViewValid).toBe(false);
  });

  it("rejects changed public-view span headers with the original hash", async () => {
    const bundle = await trace();
    bundle.publicView = structuredClone(bundle.publicView);
    bundle.publicView.publicSpans[0]!.name = "altered public span";
    const result = await verifyBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.checks.publicViewValid).toBe(false);
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

  it.each([1.5, 1.25])("rejects the fractional odd leafIndex %s", async (leafIndex) => {
    const bundle = await trace(2);
    const tree = await buildSpanMerkleTree(bundle.privateRun.spans, bundle.privateRun.events);
    const proof = generateMerkleProof(tree, 1);
    expect(await verifyMerkleProof(proof)).toBe(true);
    expect(await verifyMerkleProof({ ...proof, leafIndex })).toBe(false);
  });

  it.each([-1, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "refuses to generate a proof for span index %s", async (index) => {
      const bundle = await trace(3);
      const tree = await buildSpanMerkleTree(bundle.privateRun.spans, bundle.privateRun.events);
      expect(() => generateMerkleProof(tree, index)).toThrow(/out of bounds/);
    },
  );

  it("binds leafIndex and path length to an authenticated leaf count", async () => {
    const bundle = await trace(5);
    const tree = await buildSpanMerkleTree(bundle.privateRun.spans, bundle.privateRun.events);
    const honest = generateMerkleProof(tree, 4);
    // v1 duplicates the odd last node, so leaf 4 also has a consistent path at padded index 5.
    const padded: MerkleProof = {
      ...honest,
      leafIndex: 5,
      siblings: honest.siblings.map((sibling, level) => ({ ...sibling, position: (5 >> level) & 1 ? "left" : "right" })),
    };
    const first = generateMerkleProof(tree, 0);
    const internalAsLeaf: MerkleProof = {
      ...first,
      leafHash: nodeHash(first.leafHash, first.siblings[0]!.hash),
      siblings: first.siblings.slice(1),
    };
    expect(await verifyMerkleProof(honest, 5)).toBe(true);
    expect(await verifyMerkleProof(padded)).toBe(true);
    expect(await verifyMerkleProof(padded, 5)).toBe(false);
    expect(await verifyMerkleProof(internalAsLeaf)).toBe(true);
    expect(await verifyMerkleProof(internalAsLeaf, 5)).toBe(false);
    for (const leafCount of [0, -1, 4, 6.5, Number.NaN, 9]) {
      expect(await verifyMerkleProof(honest, leafCount)).toBe(false);
    }
  });

  it("recomputes the levels of a tree whose leaves and root are replaced", async () => {
    const tree = await buildSpanMerkleTree((await trace(3)).privateRun.spans, []);
    expect(await verifyMerkleProof(generateMerkleProof(tree, 1))).toBe(true);
    const other = await buildSpanMerkleTree((await trace(3)).privateRun.spans, []);
    Object.assign(tree, { leafHashes: other.leafHashes, rootHash: other.rootHash });
    const proof = generateMerkleProof(tree, 1);
    expect(proof.rootHash).toBe(other.rootHash);
    expect(await verifyMerkleProof(proof)).toBe(true);
  });

  it("proves every span of a 1024-span trace in under a second", async () => {
    const run = await createTrace({ agentId: "disclosure-cost" });
    for (let i = 0; i < 1024; i++) {
      const span = addSpan(run, { name: `s${i}`, visibility: "public" });
      await closeSpan(run, span.id);
    }
    const bundle = await finalizeTrace(run);
    // Time only the proofs: hashing the spans costs the same with or without cached levels.
    const tree = await buildSpanMerkleTree(bundle.privateRun.spans, bundle.privateRun.events);
    const started = performance.now();
    for (let index = 0; index < tree.leafCount; index++) {
      generateMerkleProof(tree, index);
    }
    expect(performance.now() - started).toBeLessThan(1000);
    const disclosed = await selectiveDisclose(bundle, orderedSpans(bundle).map((span) => span.id), "full");
    expect((await verifyDisclosure(disclosed, bundle.rootHash, bundle.merkleRoot)).valid).toBe(true);
  });
});

describe("membership disclosures", () => {
  it("reports membership entries as unbound without authenticated leaf hashes", async () => {
    const bundle = await trace(5);
    const membership = await selectiveDisclose(bundle, [orderedSpans(bundle)[1]!.id], "membership");
    const result = await verifyDisclosure(membership, bundle.rootHash, bundle.merkleRoot);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("unbound: span id not authenticated");
    expect(result.spans).toEqual([]);
  });

  it("verifies membership entries against authenticated leaf hashes and leaf count", async () => {
    const bundle = await trace(5);
    const id = orderedSpans(bundle)[1]!.id;
    const membership = await selectiveDisclose(bundle, [id], "membership");
    const result = await verifyDisclosure(
      membership, bundle.rootHash, bundle.merkleRoot, await authenticatedLeaves(bundle),
    );
    expect(result).toEqual({ valid: true, errors: [], spans: [{ spanId: id }] });
  });

  // Each forgery needs only the public Merkle root and, at most, one honest proof.
  const forgeries: Record<string, (bundle: TraceBundle, honest: DisclosureResult) => DisclosureResult> = {
    relabelled: (_bundle, honest) => {
      const forged = clone(honest);
      forged.disclosedSpans[0]!.spanId = "kyc-check-passed";
      return forged;
    },
    "root as leaf": (bundle) => ({
      mode: "membership", rootHash: bundle.rootHash, merkleRoot: bundle.merkleRoot,
      disclosedSpans: [{
        spanId: "kyc-check-passed",
        proof: { leafHash: bundle.merkleRoot, leafIndex: 0, siblings: [], rootHash: bundle.merkleRoot },
      }],
    }),
    "internal node as leaf": (bundle, honest) => {
      const { leafHash, leafIndex, siblings } = honest.disclosedSpans[0]!.proof;
      const [first, ...rest] = siblings;
      const internal = first!.position === "left" ? nodeHash(first!.hash, leafHash) : nodeHash(leafHash, first!.hash);
      return {
        mode: "membership", rootHash: bundle.rootHash, merkleRoot: bundle.merkleRoot,
        disclosedSpans: [{
          spanId: "sanctions-screening",
          proof: { leafHash: internal, leafIndex: Math.floor(leafIndex / 2), siblings: rest, rootHash: bundle.merkleRoot },
        }],
      };
    },
  };

  it.each(Object.entries(forgeries))("rejects a %s membership proof", async (_name, forge) => {
    const bundle = await trace(5);
    const honest = await selectiveDisclose(bundle, [orderedSpans(bundle)[1]!.id], "membership");
    const forged = forge(bundle, honest);
    expect(await verifyMerkleProof(forged.disclosedSpans[0]!.proof)).toBe(true);
    for (const options of [undefined, await authenticatedLeaves(bundle)]) {
      expect((await verifyDisclosure(clone(forged), bundle.rootHash, bundle.merkleRoot, options)).valid).toBe(false);
    }
  });

  it("rejects a valid proof relabelled with another authenticated span id", async () => {
    const bundle = await trace(5);
    const [, second, , fourth] = orderedSpans(bundle);
    const relabelled = await selectiveDisclose(bundle, [second!.id], "membership");
    relabelled.disclosedSpans[0]!.spanId = fourth!.id;
    const options = await authenticatedLeaves(bundle);
    expect(await verifyMerkleProof(relabelled.disclosedSpans[0]!.proof, options.leafCount)).toBe(true);
    expect((await verifyDisclosure(relabelled, bundle.rootHash, bundle.merkleRoot, options)).valid).toBe(false);
  });

  it("rejects a proof shorter than the authenticated tree depth even for a leaf hash the caller lists", async () => {
    const bundle = await trace(5);
    const honest = await selectiveDisclose(bundle, [orderedSpans(bundle)[1]!.id], "membership");
    for (const forge of [forgeries["root as leaf"]!, forgeries["internal node as leaf"]!]) {
      const forged = forge(bundle, honest);
      const { spanId, proof } = forged.disclosedSpans[0]!;
      const options = { leafHashes: { [spanId]: proof.leafHash }, leafCount: 5 };
      expect((await verifyDisclosure(forged, bundle.rootHash, bundle.merkleRoot, options)).valid).toBe(false);
    }
  });

  it("accepts a leaf equal to the root only when the authenticated leaf count is 1", async () => {
    const bundle = await trace(1);
    const id = bundle.privateRun.spans[0]!.id;
    const membership = await selectiveDisclose(bundle, [id], "membership");
    expect(membership.disclosedSpans[0]!.proof.leafHash).toBe(bundle.merkleRoot);
    const leafHashes = { [id]: bundle.merkleRoot };
    const verify = (leafCount: number) =>
      verifyDisclosure(clone(membership), bundle.rootHash, bundle.merkleRoot, { leafHashes, leafCount });
    expect((await verify(1)).valid).toBe(true);
    expect((await verify(2)).valid).toBe(false);
  });

  it("requires the authenticated leaf count for membership entries", async () => {
    const bundle = await trace(5);
    const membership = await selectiveDisclose(bundle, [orderedSpans(bundle)[1]!.id], "membership");
    const { leafHashes } = await authenticatedLeaves(bundle);
    expect((await verifyDisclosure(membership, bundle.rootHash, bundle.merkleRoot, { leafHashes })).valid).toBe(false);
  });

  it("rejects forged membership entries appended to a full disclosure", async () => {
    const bundle = await trace(4);
    const disclosed = await selectiveDisclose(bundle, [orderedSpans(bundle)[0]!.id], "full");
    for (const spanId of ["kyc-passed", "human-approved"]) {
      disclosed.disclosedSpans.push({
        spanId, proof: { leafHash: bundle.merkleRoot, leafIndex: 0, siblings: [], rootHash: bundle.merkleRoot },
      });
    }
    const result = await verifyDisclosure(disclosed, bundle.rootHash, bundle.merkleRoot, await authenticatedLeaves(bundle));
    expect(result.valid).toBe(false);
  });
});

describe("disclosed span fields", () => {
  const forgeries: Record<string, (span: Record<string, unknown>, other: TraceSpan) => void> = {
    "another span's hash": (span, other) => { span.hash = other.hash; },
    "uncommitted keys": (span) => { Object.assign(span, { approvedBy: "CEO", verified: true }); },
    "injected events": (span) => {
      span.events = [{ kind: "output", content: "FORGED", id: "z", seq: 0, timestamp: "t", visibility: "public" }];
    },
  };

  it.each(Object.entries(forgeries))("rejects a disclosed span carrying %s", async (_name, forge) => {
    const bundle = await trace(3);
    const [first, , third] = orderedSpans(bundle);
    const disclosed = await selectiveDisclose(bundle, [first!.id], "full");
    const entry = disclosed.disclosedSpans[0]!;
    forge(entry.span as unknown as Record<string, unknown>, third!);
    expect((await verifyDisclosure(disclosed, bundle.rootHash, bundle.merkleRoot)).valid).toBe(false);
    expect((await verifySpanDisclosure({ ...entry, span: entry.span!, events: entry.events! }, bundle.merkleRoot)).valid)
      .toBe(false);
    expect(await verifySpanInclusion(entry.proof, entry.span!, entry.events!)).toBe(false);
  });

  it("returns only the committed span and event fields", async () => {
    const bundle = await mixedTrace(3);
    const span = orderedSpans(bundle)[0]!;
    const disclosed = await selectiveDisclose(bundle, [span.id], "full");
    const entry = disclosed.disclosedSpans[0]!;
    const committed = clone({ span: entry.span, events: entry.events });
    // Hashing drops null-valued keys, so these still verify; the result must not repeat them.
    Object.assign(entry.span!, { parentSpanId: null, metadata: { ...entry.span!.metadata, injected: null } });
    Object.assign(entry.events![0]!, { approvedBy: null });
    entry.events!.reverse();
    const result = await verifyDisclosure(disclosed, bundle.rootHash, bundle.merkleRoot);
    expect(result.valid).toBe(true);
    expect(result.spans).toEqual([{ spanId: span.id, ...committed }]);
    const returned = result.spans[0]!;
    expect(Object.keys(returned.span!)).not.toContain("parentSpanId");
    expect(Object.keys(returned.span!.metadata!)).not.toContain("injected");
    expect(Object.keys(returned.events![0]!)).not.toContain("approvedBy");
  });
});

describe("disclosure entries", () => {
  it("rejects duplicate span entries", async () => {
    const { bundle, result } = await disclosure();
    result.disclosedSpans.push(clone(result.disclosedSpans[0]!));
    const verified = await verifyDisclosure(result, bundle.rootHash, bundle.merkleRoot);
    expect(verified.valid).toBe(false);
    expect(verified.errors.join("\n")).toContain("Duplicate disclosure");
  });

  it("rejects a disclosure without spans", async () => {
    const { bundle, result } = await disclosure();
    result.disclosedSpans = [];
    expect((await verifyDisclosure(result, bundle.rootHash, bundle.merkleRoot)).valid).toBe(false);
  });

  it("refuses to produce empty or duplicate disclosures", async () => {
    const bundle = await trace(1);
    const id = bundle.privateRun.spans[0]!.id;
    await expect(selectiveDisclose(bundle, [], "full")).rejects.toThrow(/at least one span/);
    await expect(selectiveDisclose(bundle, [id, id], "full")).rejects.toThrow(/more than once/);
  });
});

describe("malformed verifier inputs", () => {
  const deep = () => {
    const root: Record<string, unknown> = {};
    let node = root;
    for (let i = 0; i < 120; i++) {
      node.x = {};
      node = node.x as Record<string, unknown>;
    }
    return root;
  };
  type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cases: Record<string, (d: Mutable) => void> = {
    "no disclosedSpans": (d) => { delete d.disclosedSpans; },
    "a null entry": (d) => { d.disclosedSpans[0] = null; },
    "a numeric spanId": (d) => { d.disclosedSpans[0].spanId = 7; },
    "no proof": (d) => { delete d.disclosedSpans[0].proof; },
    "a null proof": (d) => { d.disclosedSpans[0].proof = null; },
    "no siblings": (d) => { delete d.disclosedSpans[0].proof.siblings; },
    "string siblings": (d) => { d.disclosedSpans[0].proof.siblings = "abc"; },
    "a null sibling": (d) => { d.disclosedSpans[0].proof.siblings = [null]; },
    "a null event": (d) => { d.disclosedSpans[0].events[0] = null; },
    "an events object": (d) => { d.disclosedSpans[0].events = { length: 0 }; },
    "a null span": (d) => { d.disclosedSpans[0].span = null; },
    "over-deep span metadata": (d) => { d.disclosedSpans[0].span.metadata = deep(); },
    "over-deep event data": (d) => { d.disclosedSpans[0].events[0].data = deep(); },
    "an unknown mode": (d) => { d.mode = "Full"; },
    "an unknown mode and no span data": (d) => {
      d.mode = "Full";
      delete d.disclosedSpans[0].span;
      delete d.disclosedSpans[0].events;
    },
  };

  it.each(Object.entries(cases))("returns invalid for a disclosure with %s", async (_name, mutate) => {
    const bundle = await trace(3);
    const disclosed = clone(await selectiveDisclose(bundle, [orderedSpans(bundle)[0]!.id], "full")) as Mutable;
    mutate(disclosed);
    const result = await verifyDisclosure(disclosed as DisclosureResult, bundle.rootHash, bundle.merkleRoot);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it.each([null, undefined, 42, {}, { leafHash: "a", leafIndex: 0, rootHash: "a" },
    { leafHash: "a", leafIndex: 0, siblings: [null], rootHash: "a" }])(
    "verifyMerkleProof returns false for %j", async (proof) => {
      expect(await verifyMerkleProof(proof as unknown as MerkleProof)).toBe(false);
    },
  );

  it("verifySpanInclusion returns false for malformed span data", async () => {
    const { disclosed } = await disclosure();
    const events = disclosed.events!;
    expect(await verifySpanInclusion(disclosed.proof, null as unknown as TraceSpan, events)).toBe(false);
    expect(await verifySpanInclusion(disclosed.proof, disclosed.span!, [null] as unknown as typeof events)).toBe(false);
  });
});

describe("bundle public view", () => {
  type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const publicSpan = (bundle: Mutable, index = 0) => bundle.publicView.publicSpans[index];
  const mutations: Record<string, (bundle: Mutable, other: TraceBundle) => void> = {
    "a dropped public event": (b) => { publicSpan(b).events.splice(0, 1); },
    "a duplicated public event": (b) => { publicSpan(b).events.push(clone(publicSpan(b).events[0])); },
    "reordered public events": (b) => { publicSpan(b).events.reverse(); },
    "a dropped public span": (b) => { b.publicView.publicSpans.splice(0, 1); },
    "a duplicated public span": (b) => { b.publicView.publicSpans.push(clone(publicSpan(b))); },
    "a forged status": (b) => { b.publicView.status = "failed"; },
    "a forged agentId": (b) => { b.publicView.agentId = "trusted-agent"; },
    "a forged runId": (b) => { b.publicView.runId = "other-run"; },
    "forged totals": (b) => { b.publicView.totalEvents = 1; b.publicView.totalSpans = 1; },
    "a forged rootHash": (b) => { b.publicView.rootHash = "33".repeat(32); },
    "a forged merkleRoot": (b) => { b.publicView.merkleRoot = "44".repeat(32); },
    "the roots of another trace": (b, other) => {
      b.publicView.rootHash = other.rootHash;
      b.publicView.merkleRoot = other.merkleRoot;
    },
    "a forged redacted hash": (b) => { b.publicView.redactedSpanHashes[0].hash = "55".repeat(32); },
    "a dropped redacted entry": (b) => { b.publicView.redactedSpanHashes.splice(0, 1); },
    "a private span made public": (b) => {
      const hidden = b.privateRun.spans.find((span: TraceSpan) => span.visibility !== "public");
      b.publicView.publicSpans.push({ ...clone(hidden), events: [] });
    },
    "a null-valued span key": (b) => { publicSpan(b).parentSpanId = null; },
    "a null-valued event key": (b) => { publicSpan(b).events[0].approvedBy = null; },
    "forged timestamps": (b) => {
      b.publicView.startedAt = "2000-01-01T00:00:00.000Z";
      b.publicView.durationMs = 1;
    },
    "an uncommitted field": (b) => { b.publicView.redactionPolicyId = "approved-by-compliance"; },
  };

  it.each(Object.entries(mutations))("rejects a public view with %s", async (_name, mutate) => {
    const bundle = clone(await mixedTrace(4)) as Mutable;
    expect((await verifyBundle(clone(bundle) as TraceBundle)).valid).toBe(true);
    mutate(bundle, await trace(1));
    const result = await verifyBundle(bundle as TraceBundle);
    expect(result.valid).toBe(false);
    expect(result.checks.publicViewValid).toBe(false);
  });

  it("rejects span keys the span hash does not commit to", async () => {
    const bundle = clone(await mixedTrace(2));
    const id = bundle.publicView.publicSpans[0]!.id;
    for (const span of [bundle.privateRun.spans.find((s) => s.id === id)!, bundle.publicView.publicSpans[0]!]) {
      Object.assign(span, { approvedBy: "CEO" });
    }
    const result = await verifyBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.checks.spanHashesValid).toBe(false);
  });

  it("rejects a privateRun rootHash that differs from the bundle rootHash", async () => {
    const bundle = clone(await mixedTrace(2));
    bundle.privateRun.rootHash = "66".repeat(32);
    bundle.publicView.rootHash = "66".repeat(32);
    expect((await verifyBundle(bundle)).valid).toBe(false);
  });

  it("verifies the views createBundle and finalizeTrace produce, with and without a pinned manifest", async () => {
    const manifest = { modelHash: "sha256:" + "1".repeat(64) };
    for (const options of [{ agentId: "a" }, { agentId: "a", manifest }]) {
      const run = await createTrace(options);
      const span = addSpan(run, { name: "infer", visibility: "public" });
      await addEvent(run, span.id, { kind: "command", command: "go", visibility: "public" });
      await closeSpan(run, span.id);
      const finalized = await finalizeTrace(run);
      expect((await verifyBundle(clone(finalized))).valid).toBe(true);
      expect((await verifyBundle(clone(await createBundle(finalized.privateRun)))).valid).toBe(true);
    }
  });

  it("derives the public end time of a run without one from its start", async () => {
    const run = clone((await mixedTrace(2)).privateRun);
    delete run.endedAt;
    delete run.durationMs;
    const bundle = await createBundle(run);
    expect(bundle.publicView.endedAt).toBe(run.startedAt);
    expect((await verifyBundle(clone(bundle))).valid).toBe(true);
  });

  const deep = () => {
    const root: Record<string, unknown> = {};
    let node = root;
    for (let i = 0; i < 120; i++) {
      node.x = {};
      node = node.x as Record<string, unknown>;
    }
    return root;
  };
  const malformed: Record<string, (bundle: Mutable) => void> = {
    "null public events": (b) => { publicSpan(b).events = null; },
    "missing public events": (b) => { delete publicSpan(b).events; },
    "a null public event": (b) => { publicSpan(b).events.push(null); },
    "a null public span": (b) => { b.publicView.publicSpans.push(null); },
    "over-deep public metadata": (b) => { publicSpan(b).metadata = deep(); },
    "non-finite public metadata": (b) => { publicSpan(b).metadata = { n: Number.POSITIVE_INFINITY }; },
    "a null public view": (b) => { b.publicView = null; },
    "a null private span": (b) => { b.privateRun.spans[0] = null; },
    "a null private event": (b) => { b.privateRun.events[0] = null; },
    "string eventIds": (b) => { b.privateRun.spans[0].eventIds = "x"; },
    "a null privateRun": (b) => { b.privateRun = null; },
    "a null modelManifestHash": (b) => { b.privateRun.modelManifestHash = null; },
  };

  it.each(Object.entries(malformed))("returns errors instead of throwing for %s", async (_name, mutate) => {
    const bundle = clone(await mixedTrace(3)) as Mutable;
    mutate(bundle);
    const result = await verifyBundle(bundle as TraceBundle);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it.each([null, undefined, 42, "bundle"])("returns errors for the non-bundle %j", async (value) => {
    const result = await verifyBundle(value as unknown as TraceBundle);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("settles a batch that includes a malformed bundle", async () => {
    const good = await trace(2);
    const bad = clone(good) as Mutable;
    publicSpan(bad).events = null;
    const results = await Promise.all([verifyBundle(clone(good)), verifyBundle(bad as TraceBundle), verifyBundle(clone(good))]);
    expect(results.map((r) => r.valid)).toEqual([true, false, true]);
  });
});

/** A finalized trace with a private span for each of `spanIds`, created in that order, then one public span. */
async function privateSpansTrace(spanIds: readonly string[]) {
  const generated = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const queue = [generated(0), ...spanIds.flatMap((id, i) => [id, generated(i + 1)])];
  let next = 1000;
  const randomUUID = vi.spyOn(crypto, "randomUUID").mockImplementation(
    () => (queue.shift() ?? generated(next++)) as ReturnType<typeof crypto.randomUUID>,
  );
  try {
    const run = await createTrace({ agentId: "host-collation" });
    for (const visibility of [...spanIds.map(() => "private" as const), "public" as const]) {
      const span = addSpan(run, { name: visibility, visibility });
      await addEvent<"command">(run, span.id, { kind: "command", command: "go", visibility: "public" });
      await closeSpan(run, span.id);
    }
    return await finalizeTrace(run);
  } finally {
    randomUUID.mockRestore();
  }
}

/** Runs `body` while `String.prototype.localeCompare` collates as `locale` does. */
async function underCollation<T>(locale: string, body: () => Promise<T>): Promise<T> {
  const collator = new Intl.Collator(locale);
  const collation = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (this: string, other: string) {
    return collator.compare(String(this), other);
  });
  try {
    return await body();
  } finally {
    collation.mockRestore();
  }
}

describe("redacted span hashes and the host collation", () => {
  // Danish and Norwegian collation sorts "aa" after "z"; UTF-16 code units sort it before "b".
  const spanIds = ["aa5f0c1e-3b1d-4c55-9e0a-1f2b3c4d5e6f", "b03e2d11-7a9c-4f10-8b2d-6e5f4a3b2c1d"];
  const locales = ["en-US", "da-DK", "nb-NO"];

  it("orders them by UTF-16 code units without consulting the host collation", async () => {
    const collation = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("Protocol ordering must not use host collation");
    });
    try {
      const bundle = await privateSpansTrace([...spanIds].reverse());
      expect(bundle.publicView.redactedSpanHashes.map((entry) => entry.spanId)).toEqual(spanIds);
      const rebuilt = await createBundle(bundle.privateRun);
      expect(rebuilt.publicView.redactedSpanHashes.map((entry) => entry.spanId)).toEqual(spanIds);
      expect((await verifyBundle(clone(bundle))).valid).toBe(true);
    } finally {
      collation.mockRestore();
    }
  });

  it.each(locales)("verifies a view a producer ordered under %s collation under every host collation", async (producer) => {
    const bundle = clone(await privateSpansTrace(spanIds));
    const collator = new Intl.Collator(producer);
    bundle.publicView.redactedSpanHashes.sort((a, b) => collator.compare(a.spanId, b.spanId));
    for (const verifier of locales) {
      const result = await underCollation(verifier, () => verifyBundle(clone(bundle)));
      expect([verifier, result.valid, result.errors]).toEqual([verifier, true, []]);
    }
  });

  it("still rejects a repeated, missing or relabelled redacted entry", async () => {
    const bundle = clone(await privateSpansTrace(spanIds));
    const [first, second] = bundle.publicView.redactedSpanHashes as [{ spanId: string; hash: string }, { spanId: string; hash: string }];
    for (const redactedSpanHashes of [
      [second, first, first],
      [first, first],
      [second],
      [first, { spanId: second.spanId, hash: first.hash }],
    ]) {
      const forged = clone(bundle);
      forged.publicView.redactedSpanHashes = clone(redactedSpanHashes);
      expect((await verifyBundle(forged)).checks.publicViewValid).toBe(false);
    }
  });
});

describe("uncommitted run timestamps", () => {
  type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const shifted = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

  /** A run without an end time, bundled, with the public end time `endedAt` gives for its start. */
  async function bundleWithoutEnd(endedAt: (startedAt: string) => unknown): Promise<TraceBundle> {
    const run = clone((await mixedTrace(2)).privateRun) as Mutable;
    delete run.endedAt;
    delete run.durationMs;
    const bundle = clone(await createBundle(run as TraceRun)) as Mutable;
    const publicEnd = endedAt(run.startedAt);
    if (publicEnd === undefined) delete bundle.publicView.endedAt;
    else bundle.publicView.endedAt = publicEnd;
    return bundle as TraceBundle;
  }

  it.each([
    ["the creation time published createBundle reported", (startedAt: string) => shifted(startedAt, 1)],
    ["a creation time a day after the start", (startedAt: string) => shifted(startedAt, 86_400_000)],
    ["the start time", (startedAt: string) => startedAt],
    ["no end time", () => undefined],
  ])("accepts %s as the public end of a run without one", async (_name, endedAt) => {
    const result = await verifyBundle(await bundleWithoutEnd(endedAt));
    expect([result.valid, result.errors]).toEqual([true, []]);
  });

  it.each([
    ["an end before the start", (startedAt: string) => shifted(startedAt, -1)],
    ["an end that is not a timestamp", () => "after the audit"],
    ["a numeric end", (startedAt: string) => Date.parse(startedAt) + 1],
    ["a null end", () => null],
  ])("rejects %s as the public end of a run without one", async (_name, endedAt) => {
    const result = await verifyBundle(await bundleWithoutEnd(endedAt));
    expect(result.checks.publicViewValid).toBe(false);
  });

  it("requires the run's own end time when the run has one", async () => {
    const bundle = clone(await mixedTrace(2)) as Mutable;
    bundle.publicView.endedAt = shifted(bundle.privateRun.endedAt, 1);
    expect((await verifyBundle(clone(bundle) as TraceBundle)).checks.publicViewValid).toBe(false);
    delete bundle.publicView.endedAt;
    expect((await verifyBundle(clone(bundle) as TraceBundle)).checks.publicViewValid).toBe(false);
  });
});

describe("top-level model manifest fields", () => {
  type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  async function pinnedTrace() {
    const run = await createTrace({
      agentId: "pinned", manifest: { modelHash: "sha256:" + "4d".repeat(32), framework: "anthropic", modelId: "m" },
    });
    const span = addSpan(run, { name: "infer", visibility: "public" });
    await addEvent<"command">(run, span.id, { kind: "command", command: "go", visibility: "public" });
    await closeSpan(run, span.id);
    return clone(await finalizeTrace(run)) as Mutable;
  }

  const swaps: Record<string, (bundle: Mutable) => void> = {
    "a swapped modelManifestHash": (b) => { b.modelManifestHash = "ff".repeat(32); },
    "a swapped modelManifest": (b) => { b.modelManifest = { modelHash: "sha256:" + "ee".repeat(32) }; },
    "both swapped": (b) => {
      b.modelManifestHash = "ff".repeat(32);
      b.modelManifest = { modelHash: "sha256:evil" };
    },
  };

  it.each(Object.entries(swaps))("rejects %s at the top level", async (_name, swap) => {
    const bundle = await pinnedTrace();
    expect((await verifyBundle(clone(bundle) as TraceBundle)).valid).toBe(true);
    swap(bundle);
    const result = await verifyBundle(bundle as TraceBundle);
    expect(result.valid).toBe(false);
    expect(result.checks.modelManifestValid).toBe(false);
  });

  it("rejects top-level manifest fields on a bundle whose run pins no manifest", async () => {
    const pinned = await pinnedTrace();
    for (const field of ["modelManifestHash", "modelManifest"]) {
      const bundle = clone(await trace(1)) as Mutable;
      bundle[field] = pinned[field];
      expect((await verifyBundle(bundle as TraceBundle)).valid).toBe(false);
    }
  });

  it("accepts a pinned bundle with or without its top-level copies", async () => {
    const bundle = await pinnedTrace();
    bundle.modelManifest = Object.fromEntries(Object.entries(bundle.modelManifest).reverse());
    expect((await verifyBundle(clone(bundle) as TraceBundle)).valid).toBe(true);
    delete bundle.modelManifest;
    delete bundle.modelManifestHash;
    expect((await verifyBundle(bundle as TraceBundle)).valid).toBe(true);
  });
});

describe("verifiers read their input once", () => {
  async function publicDisclosure() {
    const bundle = await trace(2);
    const span = orderedSpans(bundle)[0]!;
    return { bundle, span, disclosure: clone(await selectiveDisclose(bundle, [span.id], "full")) };
  }

  it("verifies and returns an event body as it was when verification began", async () => {
    const { bundle, disclosure } = await publicDisclosure();
    const honest = clone(disclosure.disclosedSpans[0]!.events![0]!);
    const pending = verifyDisclosure(disclosure, bundle.rootHash, bundle.merkleRoot);
    Object.assign(disclosure.disclosedSpans[0]!.events![0]!, { content: "changed after the call" });
    const result = await pending;
    expect(result.valid).toBe(true);
    expect(result.spans[0]!.events).toEqual([honest]);
  });

  it("verifies and returns a span header as it was when verification began", async () => {
    const { bundle, span, disclosure } = await publicDisclosure();
    const pending = verifyDisclosure(disclosure, bundle.rootHash, bundle.merkleRoot);
    disclosure.disclosedSpans[0]!.span!.name = "changed after the call";
    const result = await pending;
    expect(result.valid).toBe(true);
    expect(result.spans[0]!.span!.name).toBe(span.name);
  });

  /** Makes `key` of `target` answer `first` once and something else on every later read. */
  function changesAfterFirstRead(target: object, key: string, first: unknown) {
    let reads = 0;
    Object.defineProperty(target, key, { enumerable: true, get: () => (reads++ === 0 ? first : "changed on a later read") });
    return () => reads;
  }

  it("reads a getter in a disclosure once", async () => {
    const { bundle, disclosure } = await publicDisclosure();
    const event = disclosure.disclosedSpans[0]!.events![0]! as unknown as Record<string, unknown>;
    const honest = event.content;
    const reads = changesAfterFirstRead(event, "content", honest);
    const result = await verifyDisclosure(disclosure, bundle.rootHash, bundle.merkleRoot);
    expect(result.valid).toBe(true);
    expect((result.spans[0]!.events![0] as unknown as Record<string, unknown>).content).toBe(honest);
    expect(reads()).toBe(1);
  });

  it("reads a getter in a span disclosure once", async () => {
    const { bundle, disclosure } = await publicDisclosure();
    const entry = disclosure.disclosedSpans[0]!;
    const honest = entry.span!.name;
    const reads = changesAfterFirstRead(entry.span!, "name", honest);
    const result = await verifySpanDisclosure({ ...entry, span: entry.span!, events: entry.events! }, bundle.merkleRoot);
    expect(result.valid).toBe(true);
    expect(result.span!.name).toBe(honest);
    expect(reads()).toBe(1);
  });

  it("reads a getter in span inclusion data once", async () => {
    const { disclosure } = await publicDisclosure();
    const entry = disclosure.disclosedSpans[0]!;
    const reads = changesAfterFirstRead(entry.span!, "name", entry.span!.name);
    expect(await verifySpanInclusion(entry.proof, entry.span!, entry.events!)).toBe(true);
    expect(reads()).toBe(1);
  });

  type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  it.each([
    ["a bigint", (event: Mutable) => { event.data = { amount: 10n }; }],
    ["a cycle", (event: Mutable) => { event.data = { self: event }; }],
  ])("returns invalid for a disclosure holding %s", async (_name, mutate) => {
    const { bundle, disclosure } = await publicDisclosure();
    const entry = disclosure.disclosedSpans[0]!;
    mutate(entry.events![0]! as unknown as Mutable);
    expect((await verifyDisclosure(disclosure, bundle.rootHash, bundle.merkleRoot)).valid).toBe(false);
    expect((await verifySpanDisclosure({ ...entry, span: entry.span!, events: entry.events! }, bundle.merkleRoot)).valid).toBe(false);
    expect(await verifySpanInclusion(entry.proof, entry.span!, entry.events!)).toBe(false);
  });
});

describe("repeated span and event IDs", () => {
  /** Two committed spans, REJECTED then APPROVED, with one decision event each; not yet committed. */
  async function twoDecisions(): Promise<TraceRun> {
    const run = await createTrace({ agentId: "repeated-ids" });
    for (const [decision, status] of [["REJECTED", "failed"], ["APPROVED", "completed"]] as const) {
      const span = addSpan(run, { name: "approval", visibility: "public" });
      await addEvent<"decision">(run, span.id, { kind: "decision", decision, visibility: "public" });
      await closeSpan(run, span.id, status);
    }
    run.status = "completed";
    return run;
  }

  /** Commits a run as its producer chose to, after it edited IDs. */
  async function commit(run: TraceRun): Promise<TraceBundle> {
    for (const event of run.events) event.hash = await computeEventHash(event);
    run.rollingHash = await computeRollingHash(run.events);
    for (const span of run.spans) {
      span.hash = await computeSpanHash(span, getBundleSpanEvents(span, run.events).map((event) => event.hash!));
    }
    run.rootHash = await computeRootHash(run.rollingHash, run.spans);
    return clone(await createBundle(run));
  }

  const edits: Record<string, (run: TraceRun) => void> = {
    "two spans share an ID": (run) => {
      for (const span of run.spans) span.id = "approval";
    },
    "two events share an ID": (run) => {
      const [first, second] = run.events;
      second!.id = first!.id;
      run.spans[1]!.eventIds = [first!.id];
    },
    "two events share an ID and no span lists the second": (run) => {
      const [first, second] = run.events;
      second!.id = first!.id;
      run.spans[1]!.eventIds = [];
    },
    "two spans list the same event": (run) => {
      run.spans[1]!.eventIds = [...run.spans[0]!.eventIds];
    },
    "a span lists an event twice": (run) => {
      run.spans[0]!.eventIds = [run.spans[0]!.eventIds[0]!, run.spans[0]!.eventIds[0]!];
    },
  };

  it.each(Object.entries(edits))("verifyBundle rejects a bundle in which %s", async (_name, edit) => {
    const honest = await commit(await twoDecisions());
    expect((await verifyBundle(clone(honest))).valid).toBe(true);
    const run = await twoDecisions();
    edit(run);
    const result = await verifyBundle(await commit(run));
    expect(result.valid).toBe(false);
    expect(result.checks.sequenceValid).toBe(false);
  });

  // A disclosure shows only the events its spans list, so these are the repeats it can carry.
  const disclosedRepeats = ["two events share an ID", "two spans list the same event", "a span lists an event twice"];
  it.each(Object.entries(edits).filter(([name]) => disclosedRepeats.includes(name)))(
    "verifyDisclosure rejects a disclosure in which %s", async (_name, edit) => {
      const run = await twoDecisions();
      edit(run);
      const bundle = await commit(run);
      const disclosure = await selectiveDisclose(bundle, orderedSpans(bundle).map((span) => span.id), "full");
      const result = await verifyDisclosure(clone(disclosure), bundle.rootHash, bundle.merkleRoot);
      expect(result.valid).toBe(false);
      expect(result.errors.join("\n")).toMatch(/event ID/i);
    },
  );

  it("verifySpanDisclosure and verifySpanInclusion reject a span whose events repeat an ID", async () => {
    const run = await twoDecisions();
    edits["a span lists an event twice"]!(run);
    const bundle = await commit(run);
    const disclosure = await selectiveDisclose(bundle, [orderedSpans(bundle)[0]!.id], "full");
    const entry = disclosure.disclosedSpans[0]!;
    expect(entry.events!.map((event) => event.id)).toEqual([entry.events![0]!.id, entry.events![0]!.id]);
    const result = await verifySpanDisclosure({ ...entry, span: entry.span!, events: entry.events! }, bundle.merkleRoot);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/event ID/i);
    expect(await verifySpanInclusion(entry.proof, entry.span!, entry.events!)).toBe(false);
  });

  it("checks a full entry against the leaf hash the caller authenticated for its span ID", async () => {
    const bundle = await trace(3);
    const [first, second] = orderedSpans(bundle);
    const disclosure = await selectiveDisclose(bundle, [first!.id], "full");
    const { leafHashes, leafCount } = await authenticatedLeaves(bundle);
    expect((await verifyDisclosure(clone(disclosure), bundle.rootHash, bundle.merkleRoot, { leafHashes, leafCount })).valid)
      .toBe(true);
    const pinnedElsewhere = { leafHashes: { ...leafHashes, [first!.id]: leafHashes[second!.id]! }, leafCount };
    const result = await verifyDisclosure(clone(disclosure), bundle.rootHash, bundle.merkleRoot, pinnedElsewhere);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("authenticated leaf hash");
  });

  it("verifies only the span the caller authenticated when two committed spans share its ID", async () => {
    const run = await twoDecisions();
    for (const span of run.spans) span.id = "approval";
    const bundle = await commit(run);
    const tree = await buildSpanMerkleTree(bundle.privateRun.spans, bundle.privateRun.events);
    const disclose = (index: number): DisclosureResult => {
      const span = orderedSpans(bundle)[index]!;
      return clone({
        mode: "full", rootHash: bundle.rootHash, merkleRoot: bundle.merkleRoot,
        disclosedSpans: [{
          spanId: "approval", proof: generateMerkleProof(tree, index), span,
          events: getBundleSpanEvents(span, bundle.privateRun.events),
        }],
      });
    };
    const options = { leafHashes: { approval: tree.leafHashes[0]! }, leafCount: tree.leafCount };
    expect((await verifyDisclosure(disclose(0), bundle.rootHash, bundle.merkleRoot, options)).valid).toBe(true);
    expect((await verifyDisclosure(disclose(1), bundle.rootHash, bundle.merkleRoot, options)).valid).toBe(false);
  });
});
