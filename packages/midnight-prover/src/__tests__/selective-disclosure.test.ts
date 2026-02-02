/**
 * @fileoverview Tests for SelectiveDisclosureProver and Merkle utilities.
 *
 * Location: packages/midnight-prover/src/__tests__/selective-disclosure.test.ts
 *
 * Summary:
 * This file contains unit tests for the SelectiveDisclosureProver class and
 * associated Merkle tree utilities. Tests cover proof generation, verification,
 * Merkle tree construction, and inclusion proof validation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SelectiveDisclosureProver,
  createSelectiveDisclosureProver,
  computeSpanHash,
  computeLeafHash,
  computeNodeHash,
  computeMerkleRoot,
  generateMerkleInclusionProof,
  verifyMerkleProof,
  verifySpanInclusion,
} from "../proofs/selective-disclosure.js";
import type {
  DisclosureInput,
} from "../types.js";
import type {
  TraceBundle,
  TraceRun,
  TraceSpan,
  TraceEvent,
  TraceBundlePublicView,
  CommandEvent,
  OutputEvent,
  MerkleProof,
} from "@fluxpointstudios/poi-sdk-process-trace";

// =============================================================================
// TEST FIXTURES
// =============================================================================

/**
 * Generate a mock 64-character hex hash.
 */
function mockHash(seed: string): string {
  let hash = "";
  for (let i = 0; i < 64; i++) {
    const charCode = seed.charCodeAt(i % seed.length) || 0;
    hash += ((charCode + i) % 16).toString(16);
  }
  return hash;
}

/**
 * Create a command event.
 */
function createCommandEvent(overrides: Partial<CommandEvent> = {}): CommandEvent {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    kind: "command",
    id,
    seq: 0,
    timestamp: "2024-01-15T10:30:00.000Z",
    visibility: "public",
    command: "npm install",
    hash: mockHash(`event-${id}`),
    ...overrides,
  };
}

/**
 * Create an output event.
 */
function createOutputEvent(overrides: Partial<OutputEvent> = {}): OutputEvent {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    kind: "output",
    id,
    seq: 1,
    timestamp: "2024-01-15T10:30:01.000Z",
    visibility: "private",
    stream: "stdout",
    content: "done",
    hash: mockHash(`event-${id}`),
    ...overrides,
  };
}

/**
 * Create a trace span.
 */
function createSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    id: crypto.randomUUID(),
    spanSeq: 0,
    name: "test-span",
    status: "completed",
    visibility: "public",
    startedAt: "2024-01-15T10:30:00.000Z",
    endedAt: "2024-01-15T10:31:00.000Z",
    durationMs: 60000,
    eventIds: [],
    childSpanIds: [],
    ...overrides,
  };
}

/**
 * Create a trace run.
 */
function createTraceRun(
  spans: TraceSpan[],
  events: TraceEvent[],
  overrides: Partial<TraceRun> = {}
): TraceRun {
  return {
    id: crypto.randomUUID(),
    schemaVersion: "1.0",
    agentId: "test-agent",
    status: "completed",
    startedAt: "2024-01-15T10:30:00.000Z",
    endedAt: "2024-01-15T10:31:00.000Z",
    durationMs: 60000,
    events,
    spans,
    rollingHash: mockHash("rolling-hash"),
    rootHash: mockHash("root-hash"),
    nextSeq: events.length,
    nextSpanSeq: spans.length,
    ...overrides,
  };
}

/**
 * Create a public view for a bundle.
 */
function createPublicView(run: TraceRun, merkleRoot: string): TraceBundlePublicView {
  return {
    runId: run.id,
    agentId: run.agentId,
    schemaVersion: run.schemaVersion,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? run.startedAt,
    durationMs: run.durationMs ?? 0,
    status: run.status,
    totalEvents: run.events.length,
    totalSpans: run.spans.length,
    rootHash: run.rootHash ?? "",
    merkleRoot,
    publicSpans: [],
    redactedSpanHashes: [],
  };
}

/**
 * Create a complete trace bundle for testing.
 */
async function createTestBundle(spanCount: number = 1): Promise<{
  bundle: TraceBundle;
  merkleRoot: string;
}> {
  const events: TraceEvent[] = [];
  const spans: TraceSpan[] = [];

  for (let i = 0; i < spanCount; i++) {
    const eventId = `event-${i}`;
    const event = createCommandEvent({ id: eventId, seq: i });
    events.push(event);

    const span = createSpan({
      id: `span-${i}`,
      spanSeq: i,
      name: `span-${i}`,
      eventIds: [eventId],
    });
    spans.push(span);
  }

  // Compute leaf hashes for Merkle root
  const leafHashes: string[] = [];
  for (const span of spans) {
    const spanEvents = span.eventIds
      .map((id) => events.find((e) => e.id === id))
      .filter((e): e is TraceEvent => e !== undefined);
    const eventHashes = spanEvents.map((e) => e.hash ?? "");
    const spanHash = await computeSpanHash(span, eventHashes);
    const leafHash = await computeLeafHash(spanHash);
    leafHashes.push(leafHash);
  }

  const merkleRoot = await computeMerkleRoot(leafHashes);
  const run = createTraceRun(spans, events);
  const publicView = createPublicView(run, merkleRoot);

  const bundle: TraceBundle = {
    formatVersion: "1.0",
    publicView,
    privateRun: run,
    merkleRoot,
    rootHash: run.rootHash ?? "",
  };

  return { bundle, merkleRoot };
}

// =============================================================================
// MERKLE UTILITY TESTS
// =============================================================================

describe("computeSpanHash", () => {
  it("produces consistent output for same input", async () => {
    const span = createSpan({ id: "fixed-span-id", spanSeq: 0, name: "build" });
    const eventHashes = ["hash1", "hash2"];

    const hash1 = await computeSpanHash(span, eventHashes);
    const hash2 = await computeSpanHash(span, eventHashes);

    expect(hash1).toBe(hash2);
  });

  it("produces 64-character hex output", async () => {
    const span = createSpan();
    const hash = await computeSpanHash(span, []);

    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it("produces different output for different span names", async () => {
    const span1 = createSpan({ id: "same-id", name: "build" });
    const span2 = createSpan({ id: "same-id", name: "test" });

    const hash1 = await computeSpanHash(span1, []);
    const hash2 = await computeSpanHash(span2, []);

    expect(hash1).not.toBe(hash2);
  });

  it("produces different output for different event hashes", async () => {
    const span = createSpan({ id: "fixed-id" });

    const hash1 = await computeSpanHash(span, ["event-hash-1"]);
    const hash2 = await computeSpanHash(span, ["event-hash-2"]);

    expect(hash1).not.toBe(hash2);
  });
});

describe("computeLeafHash", () => {
  it("produces consistent output for same input", async () => {
    const spanHash = mockHash("test-span");

    const hash1 = await computeLeafHash(spanHash);
    const hash2 = await computeLeafHash(spanHash);

    expect(hash1).toBe(hash2);
  });

  it("produces 64-character hex output", async () => {
    const hash = await computeLeafHash(mockHash("test"));
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it("produces different output for different span hashes", async () => {
    const hash1 = await computeLeafHash(mockHash("span1"));
    const hash2 = await computeLeafHash(mockHash("span2"));
    expect(hash1).not.toBe(hash2);
  });
});

describe("computeNodeHash", () => {
  it("produces consistent output for same inputs", async () => {
    const left = mockHash("left");
    const right = mockHash("right");

    const hash1 = await computeNodeHash(left, right);
    const hash2 = await computeNodeHash(left, right);

    expect(hash1).toBe(hash2);
  });

  it("produces different output for swapped inputs", async () => {
    const left = mockHash("left");
    const right = mockHash("right");

    const hash1 = await computeNodeHash(left, right);
    const hash2 = await computeNodeHash(right, left);

    expect(hash1).not.toBe(hash2);
  });
});

describe("computeMerkleRoot", () => {
  it("returns empty string for empty leaves", async () => {
    const root = await computeMerkleRoot([]);
    expect(root).toBe("");
  });

  it("returns leaf hash for single leaf", async () => {
    const leafHash = mockHash("single-leaf");
    const root = await computeMerkleRoot([leafHash]);
    expect(root).toBe(leafHash);
  });

  it("computes root for two leaves", async () => {
    const leaf1 = mockHash("leaf1");
    const leaf2 = mockHash("leaf2");

    const root = await computeMerkleRoot([leaf1, leaf2]);
    const expected = await computeNodeHash(leaf1, leaf2);

    expect(root).toBe(expected);
  });

  it("computes consistent root for same leaves", async () => {
    const leaves = [mockHash("a"), mockHash("b"), mockHash("c")];

    const root1 = await computeMerkleRoot(leaves);
    const root2 = await computeMerkleRoot(leaves);

    expect(root1).toBe(root2);
  });

  it("handles odd number of leaves (duplication)", async () => {
    const leaves = [mockHash("a"), mockHash("b"), mockHash("c")];
    const root = await computeMerkleRoot(leaves);

    expect(root).toHaveLength(64);
    expect(root).toMatch(/^[a-f0-9]+$/);
  });
});

describe("verifyMerkleProof", () => {
  it("verifies single leaf (no siblings)", async () => {
    const leafHash = mockHash("single-leaf");
    const proof: MerkleProof = {
      leafHash,
      leafIndex: 0,
      siblings: [],
      rootHash: leafHash,
    };

    const isValid = await verifyMerkleProof(proof);
    expect(isValid).toBe(true);
  });

  it("verifies two-leaf tree proof", async () => {
    const leaf1 = mockHash("leaf1");
    const leaf2 = mockHash("leaf2");
    const root = await computeNodeHash(leaf1, leaf2);

    const proof: MerkleProof = {
      leafHash: leaf1,
      leafIndex: 0,
      siblings: [{ hash: leaf2, position: "right" }],
      rootHash: root,
    };

    const isValid = await verifyMerkleProof(proof);
    expect(isValid).toBe(true);
  });

  it("rejects tampered leaf hash", async () => {
    const leaf1 = mockHash("leaf1");
    const leaf2 = mockHash("leaf2");
    const root = await computeNodeHash(leaf1, leaf2);

    const proof: MerkleProof = {
      leafHash: mockHash("tampered"),
      leafIndex: 0,
      siblings: [{ hash: leaf2, position: "right" }],
      rootHash: root,
    };

    const isValid = await verifyMerkleProof(proof);
    expect(isValid).toBe(false);
  });

  it("rejects wrong sibling position", async () => {
    const leaf1 = mockHash("leaf1");
    const leaf2 = mockHash("leaf2");
    const root = await computeNodeHash(leaf1, leaf2);

    const proof: MerkleProof = {
      leafHash: leaf1,
      leafIndex: 0,
      siblings: [{ hash: leaf2, position: "left" }], // Wrong position
      rootHash: root,
    };

    const isValid = await verifyMerkleProof(proof);
    expect(isValid).toBe(false);
  });
});

describe("generateMerkleInclusionProof", () => {
  it("generates proof for single span", async () => {
    const { bundle } = await createTestBundle(1);

    const result = await generateMerkleInclusionProof(bundle, "span-0");

    expect(result.spanHash).toHaveLength(64);
    expect(result.leafHash).toHaveLength(64);
    expect(result.merkleProof.siblings).toHaveLength(0);
    expect(result.span.id).toBe("span-0");
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("generates proof for multi-span bundle", async () => {
    const { bundle, merkleRoot } = await createTestBundle(4);

    const result = await generateMerkleInclusionProof(bundle, "span-2");

    expect(result.merkleProof.rootHash).toBe(merkleRoot);
    expect(result.merkleProof.siblings.length).toBeGreaterThan(0);
    expect(result.span.id).toBe("span-2");
  });

  it("throws for non-existent span", async () => {
    const { bundle } = await createTestBundle(1);

    await expect(
      generateMerkleInclusionProof(bundle, "non-existent-span")
    ).rejects.toThrow(/Span not found/);
  });
});

describe("verifySpanInclusion", () => {
  it("verifies span inclusion in single-span bundle", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);
    const span = bundle.privateRun.spans[0]!;
    const events = bundle.privateRun.events.filter((e) =>
      span.eventIds.includes(e.id)
    );

    const inclusion = await generateMerkleInclusionProof(bundle, span.id);
    const isValid = await verifySpanInclusion(inclusion.merkleProof, span, events);

    expect(isValid).toBe(true);
  });

  it("rejects tampered span data", async () => {
    const { bundle } = await createTestBundle(1);
    const span = bundle.privateRun.spans[0]!;
    const events = bundle.privateRun.events.filter((e) =>
      span.eventIds.includes(e.id)
    );

    const inclusion = await generateMerkleInclusionProof(bundle, span.id);

    // Tamper with span name
    const tamperedSpan = { ...span, name: "tampered" };
    const isValid = await verifySpanInclusion(inclusion.merkleProof, tamperedSpan, events);

    expect(isValid).toBe(false);
  });
});

// =============================================================================
// PROVER INSTANTIATION TESTS
// =============================================================================

describe("SelectiveDisclosureProver instantiation", () => {
  it("creates prover with default options", () => {
    const prover = new SelectiveDisclosureProver();
    expect(prover).toBeInstanceOf(SelectiveDisclosureProver);
  });

  it("creates prover with debug option", () => {
    const prover = new SelectiveDisclosureProver({ debug: true });
    expect(prover).toBeInstanceOf(SelectiveDisclosureProver);
  });

  it("creates prover with disclosure options", () => {
    const prover = new SelectiveDisclosureProver({
      includeSpanData: false,
      includeEventData: false,
    });
    expect(prover).toBeInstanceOf(SelectiveDisclosureProver);
  });

  it("creates prover using factory function", () => {
    const prover = createSelectiveDisclosureProver();
    expect(prover).toBeInstanceOf(SelectiveDisclosureProver);
  });
});

// =============================================================================
// PROOF GENERATION TESTS
// =============================================================================

describe("SelectiveDisclosureProver.generateProof", () => {
  let prover: SelectiveDisclosureProver;

  beforeEach(() => {
    prover = new SelectiveDisclosureProver();
  });

  it("generates proof for single-span bundle", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateProof(input);

    expect(proof.proofType).toBe("selective-disclosure");
    expect(proof.proofId).toMatch(/^disclosure-proof-/);
    expect(proof.proof).toBeInstanceOf(Uint8Array);
    expect(proof.proof.length).toBeGreaterThan(67);
    expect(proof.publicInputs.spanHash).toHaveLength(64);
    expect(proof.publicInputs.merkleRoot).toBe(merkleRoot);
    expect(proof.publicInputs.cardanoAnchorTxHash).toBe(input.cardanoAnchorTxHash);
    expect(proof.provingTimeMs).toBeGreaterThanOrEqual(0);
    expect(proof.createdAt).toBeDefined();
  });

  it("generates proof with disclosed span data", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateProof(input);

    expect(proof.disclosedSpan).toBeDefined();
    expect(proof.disclosedSpan?.id).toBe("span-0");
    expect(proof.disclosedEvents).toBeDefined();
    expect(proof.disclosedEvents?.length).toBeGreaterThan(0);
  });

  it("generates proof without disclosed data when configured", async () => {
    const prover = new SelectiveDisclosureProver({
      includeSpanData: false,
      includeEventData: false,
    });

    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateProof(input);

    expect(proof.disclosedSpan).toBeUndefined();
    expect(proof.disclosedEvents).toBeUndefined();
  });

  it("generates proof for multi-span bundle", async () => {
    const { bundle, merkleRoot } = await createTestBundle(4);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-2",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateProof(input);

    expect(proof.proofType).toBe("selective-disclosure");
    expect(proof.publicInputs.merkleRoot).toBe(merkleRoot);
    expect(proof.disclosedSpan?.id).toBe("span-2");
  });

  it("throws for mismatched Merkle root", async () => {
    const { bundle } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot: mockHash("wrong-root"),
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    await expect(prover.generateProof(input)).rejects.toThrow(/does not match expected/);
  });
});

// =============================================================================
// INPUT VALIDATION TESTS
// =============================================================================

describe("SelectiveDisclosureProver input validation", () => {
  let prover: SelectiveDisclosureProver;

  beforeEach(() => {
    prover = new SelectiveDisclosureProver();
  });

  it("rejects missing span ID", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    await expect(prover.generateProof(input)).rejects.toThrow(/Span ID is required/);
  });

  it("rejects invalid Merkle root (too short)", async () => {
    const { bundle } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot: "abc123",
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    await expect(prover.generateProof(input)).rejects.toThrow(/Invalid Merkle root/);
  });

  it("rejects missing Cardano anchor hash", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "",
    };

    await expect(prover.generateProof(input)).rejects.toThrow(/Cardano anchor transaction hash is required/);
  });

  it("rejects non-existent span", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "non-existent",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    await expect(prover.generateProof(input)).rejects.toThrow(/Span not found/);
  });
});

// =============================================================================
// PROOF VERIFICATION TESTS
// =============================================================================

describe("SelectiveDisclosureProver.verifyProof", () => {
  let prover: SelectiveDisclosureProver;

  beforeEach(() => {
    prover = new SelectiveDisclosureProver();
  });

  it("verifies a valid proof", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateProof(input);
    const isValid = await prover.verifyProof(proof);

    expect(isValid).toBe(true);
  });

  it("verifies proof with disclosed span data", async () => {
    const { bundle, merkleRoot } = await createTestBundle(2);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-1",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateProof(input);
    expect(proof.disclosedSpan).toBeDefined();
    expect(await prover.verifyProof(proof)).toBe(true);
  });

  it("rejects proof with wrong type", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateProof(input);
    (proof as { proofType: string }).proofType = "hash-chain";

    expect(await prover.verifyProof(proof)).toBe(false);
  });

  it("rejects proof with empty proof bytes", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateProof(input);
    proof.proof = new Uint8Array(0);

    expect(await prover.verifyProof(proof)).toBe(false);
  });

  it("rejects proof with tampered proof ID", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateProof(input);
    proof.proofId = "tampered-proof-id";

    expect(await prover.verifyProof(proof)).toBe(false);
  });

  it("rejects proof with invalid span hash length", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateProof(input);
    proof.publicInputs.spanHash = "short";

    expect(await prover.verifyProof(proof)).toBe(false);
  });
});

// =============================================================================
// MEMBERSHIP PROOF TESTS
// =============================================================================

describe("SelectiveDisclosureProver.generateMembershipProof", () => {
  let prover: SelectiveDisclosureProver;

  beforeEach(() => {
    prover = new SelectiveDisclosureProver();
  });

  it("generates membership-only proof (no disclosed data)", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateMembershipProof(input);

    expect(proof.proofType).toBe("selective-disclosure");
    expect(proof.disclosedSpan).toBeUndefined();
    expect(proof.disclosedEvents).toBeUndefined();
    expect(proof.publicInputs.spanHash).toHaveLength(64);
  });

  it("membership proof is verifiable", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateMembershipProof(input);
    const isValid = await prover.verifyProof(proof);

    expect(isValid).toBe(true);
  });
});

// =============================================================================
// PROOF METRICS TESTS
// =============================================================================

describe("SelectiveDisclosureProver proof metrics", () => {
  let prover: SelectiveDisclosureProver;

  beforeEach(() => {
    prover = new SelectiveDisclosureProver();
  });

  it("includes proving time in proof", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateProof(input);

    expect(proof.provingTimeMs).toBeGreaterThanOrEqual(0);
    expect(proof.provingTimeMs).toBeLessThan(10000);
  });

  it("includes proof size in proof", async () => {
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateProof(input);

    expect(proof.proofSizeBytes).toBe(proof.proof.length);
    expect(proof.proofSizeBytes).toBeGreaterThan(67);
  });

  it("includes creation timestamp in proof", async () => {
    const beforeTime = new Date().toISOString();
    const { bundle, merkleRoot } = await createTestBundle(1);

    const input: DisclosureInput = {
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    };

    const proof = await prover.generateProof(input);
    const afterTime = new Date().toISOString();

    expect(proof.createdAt).toBeDefined();
    expect(proof.createdAt >= beforeTime).toBe(true);
    expect(proof.createdAt <= afterTime).toBe(true);
  });
});

// =============================================================================
// MULTI-SPAN TESTS
// =============================================================================

describe("SelectiveDisclosureProver multi-span scenarios", () => {
  let prover: SelectiveDisclosureProver;

  beforeEach(() => {
    prover = new SelectiveDisclosureProver();
  });

  it("generates different proofs for different spans in same bundle", async () => {
    const { bundle, merkleRoot } = await createTestBundle(3);

    const proof1 = await prover.generateProof({
      bundle,
      spanId: "span-0",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    });

    const proof2 = await prover.generateProof({
      bundle,
      spanId: "span-1",
      merkleRoot,
      cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    });

    expect(proof1.publicInputs.spanHash).not.toBe(proof2.publicInputs.spanHash);
    expect(proof1.publicInputs.merkleRoot).toBe(proof2.publicInputs.merkleRoot);
    expect(proof1.proofId).not.toBe(proof2.proofId);
  });

  it("all spans in bundle can be proven", async () => {
    const { bundle, merkleRoot } = await createTestBundle(5);

    for (let i = 0; i < 5; i++) {
      const proof = await prover.generateProof({
        bundle,
        spanId: `span-${i}`,
        merkleRoot,
        cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
      });

      expect(await prover.verifyProof(proof)).toBe(true);
      expect(proof.disclosedSpan?.id).toBe(`span-${i}`);
    }
  });
});
