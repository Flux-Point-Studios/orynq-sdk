import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { MandateGuard, MemoryGuardLog, processTraceSink } from "@fluxpointstudios/orynq-sdk-conduct";
import { canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";
import {
  addSpan, buildSpanMerkleTree, closeSpan, committedSpan, computeSpanHash, createTrace, finalizeTrace, generateMerkleProof, HASH_DOMAIN_PREFIXES, verifyMerkleProof,
  type MerkleProof, type TraceEvent, type TraceMerkleTree, type TraceRun, type TraceSpan,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { spanCircuit, spanOpening } from "../../scripts/conduct/bench.mjs";
import { classify, eventSegments } from "../../scripts/conduct/template.mjs";
import { prepareCheck, runLedger } from "./harness.js";
import { settle } from "./openings.js";
import { STEP_FIXTURE, stepWitnessFunctions, stepWorld, type StepWitness, type WitnessRecord } from "./steps.js";

const pkg = resolve(import.meta.dirname, "../..");
const UNIT = "bench/span";

// The bench circuits are generated, not committed: this group is compiled, mock-compiled and held to its pins here.
beforeAll(() => {
  const built = spawnSync(process.execPath, [join(pkg, "scripts/compile-conduct.mjs"), "--check", "--units", "bench:span"], { encoding: "utf8" });
  expect(built.stderr.split("\n").filter(line => line.includes("Error")).join("\n")).toBe("");
  expect(built.stdout).toContain("Conduct circuits reproduce their pins");
}, 900_000);

interface Trace { readonly run: TraceRun; readonly tree: TraceMerkleTree }
interface SpanOpening {
  readonly circuit: string; readonly witnesses: Record<string, StepWitness>; readonly statement: { root: Uint8Array };
  readonly spanPreimage: Uint8Array; readonly leaf: Uint8Array;
}

const world = stepWorld(STEP_FIXTURE.mandate);
const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

// A trace of n spans, each closed over exactly one guard event that its own guard enforced. The trace clock is frozen,
// so every span lasts 0 ms and its duration is one digit: the only length the bench span classes compile.
async function trace(n: number): Promise<Trace> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T00:00:00.000Z") });
  try {
    const run = await createTrace({ agentId: "conduct-span-bench" });
    for (let i = 0; i < n; i++) {
      const span = addSpan(run, { name: "guard" });
      const log = new MemoryGuardLog();
      const guard = new MandateGuard({
        mandate: world.mandate, counterpartyAllowlist: world.counterparties, egressAllowlist: world.egress!, history: "fresh", now: () => 3n,
        onEvent: async (event, previous) => {
          const head = log.append(event, previous);
          await processTraceSink(run, span.id)(event);
          return head;
        },
      });
      expect(await guard.enforceAsync({ kind: "payment", asset: "USD", amount: 5n, counterparty: "acme", timestamp: 3n })).toEqual({ allowed: true });
      await closeSpan(run, span.id);
    }
    return { run, tree: await buildSpanMerkleTree(run.spans, run.events) };
  } finally {
    vi.useRealTimers();
  }
}

const eventOf = (run: TraceRun, span: TraceSpan): TraceEvent => run.events.find(e => e.id === span.eventIds[0])!;
const siblingsOf = (proof: MerkleProof) => proof.siblings.map(s => ({ hex: s.hash, sibRight: s.position === "right" }));

/** The bench opening of span `index`: the class of the tree's depth and the span's digits, the real span and event bytes, and the given path. */
function opened({ run, tree }: Trace, index: number, siblings = siblingsOf(generateMerkleProof(tree, index)), depth = siblings.length): SpanOpening {
  const span = run.spans[index]!;
  const event = eventOf(run, span);
  const digits = String(span.spanSeq).length;
  expect(String(event.seq)).toHaveLength(digits);
  return spanOpening(spanCircuit(depth, digits), eventSegments(classify(event)), {
    id: span.id, spanSeq: String(span.spanSeq), startedAt: span.startedAt, endedAt: span.endedAt!, durationMs: String(span.durationMs),
  }, siblings);
}

const run = async (o: SpanOpening) => (await runLedger(UNIT, o.circuit, stepWitnessFunctions(o.witnesses), [o.statement])).spanOpening as { root: Uint8Array };
const outcome = (o: SpanOpening) => settle(run(o));
const withRoot = (o: SpanOpening, root: string): SpanOpening => ({ ...o, statement: { root: new Uint8Array(Buffer.from(root, "hex")) } });
const withWitness = (o: SpanOpening, name: string, value: StepWitness): SpanOpening => ({ ...o, witnesses: { ...o.witnesses, [`${o.circuit}_${name}`]: value } });
const SIZES = Array.from({ length: 17 }, (_, i) => i + 1);
const traces = new Map<number, Trace>();
const traceOf = async (n: number) => traces.get(n) ?? traces.set(n, await trace(n)).get(n)!;

describe("T-C07 option B: a guard event opened against process-trace's existing span tree", () => {
  it.each(SIZES)("a trace of %i spans: every span's rendered preimage, leaf and walk are process-trace's own", async n => {
    const t = await traceOf(n);
    const bundle = await finalizeTrace(structuredClone(t.run));
    expect(bundle.merkleRoot).toBe(t.tree.rootHash);
    for (const [index, span] of t.run.spans.entries()) {
      const event = eventOf(t.run, span);
      const proof = generateMerkleProof(t.tree, index);
      expect(await verifyMerkleProof(proof, t.tree.leafCount)).toBe(true);
      const o = opened(t, index);
      const { hash: _hash, ...header } = committedSpan(span, span.hash!);
      expect(text(o.spanPreimage)).toBe(`${HASH_DOMAIN_PREFIXES.span}${canonicalize(header, { removeNulls: true })}|${event.hash}`);
      expect(sha256Hex(o.spanPreimage)).toBe(await computeSpanHash(span, [event.hash!]));
      expect(Buffer.from(o.leaf).toString("hex")).toBe(t.tree.leafHashes[index]);
      expect(Buffer.from((await run(o)).root).toString("hex"), `span ${index} of ${n}`).toBe(t.tree.rootHash);
    }
  }, 300_000);

  it.each([2, 3, 5, 8, 9, 17])("a trace of %i spans: every direction flip, a changed sibling at every level, wrong span bytes and a span without the event are refused", async n => {
    const t = await traceOf(n);
    const accepted: string[] = [];
    for (const index of t.run.spans.keys()) {
      const o = opened(t, index);
      expect(await outcome(o), "honest control").toBe("accepted");
      const siblings = siblingsOf(generateMerkleProof(t.tree, index));
      const forged: [string, SpanOpening][] = [];
      siblings.forEach((s, level) => {
        const at = (change: Partial<typeof s>) => siblings.map((x, i) => (i === level ? { ...x, ...change } : x));
        // A self-paired odd last node reads the same either way round: its direction carries nothing (see the pinned gaps).
        if (!selfPaired(t, index, level)) forged.push([`level ${level} direction flipped`, opened(t, index, at({ sibRight: !s.sibRight }))]);
        forged.push([`level ${level} sibling changed`, opened(t, index, at({ hex: s.hex.replace(/^./, c => (c === "0" ? "1" : "0")) }))]);
      });
      // The span's own bytes changed with its hash chain re-derived, and the span of another event under this event's bytes.
      const other = t.run.spans[(index + 1) % n]!;
      forged.push(["another span id", withRoot(spanOpening(o.circuit, eventSegments(classify(eventOf(t.run, t.run.spans[index]!))), {
        id: other.id, spanSeq: String(t.run.spans[index]!.spanSeq), startedAt: other.startedAt, endedAt: other.endedAt!, durationMs: "0",
      }, siblings), t.tree.rootHash)]);
      if (String(other.spanSeq).length === String(t.run.spans[index]!.spanSeq).length) {
        forged.push(["the event of another span", withRoot(spanOpening(o.circuit, eventSegments(classify(eventOf(t.run, other))), {
          id: t.run.spans[index]!.id, spanSeq: String(t.run.spans[index]!.spanSeq), startedAt: other.startedAt, endedAt: other.endedAt!, durationMs: "0",
        }, siblings), t.tree.rootHash)]);
      }
      for (const [label, f] of forged) if (await outcome(withRoot(f, t.tree.rootHash)) === "accepted") accepted.push(`span ${index}: ${label}`);
    }
    expect(accepted, "mutation accepted").toEqual([]);
  }, 300_000);

  it("an internal node presented as a leaf has no span preimage: the walk one level short never reaches the root", async () => {
    const t = await traceOf(4);
    const siblings = siblingsOf(generateMerkleProof(t.tree, 0));
    expect(siblings).toHaveLength(2);
    const short = opened(t, 0, siblings.slice(1), 1);
    expect(await outcome(withRoot(short, t.tree.rootHash))).toBe("failed assert: span root mismatch");
    // process-trace's own verifier takes the same internal node as a leaf when it is given no leaf count.
    const first = generateMerkleProof(t.tree, 0);
    const node = sha256Hex(`${HASH_DOMAIN_PREFIXES.node}${first.leafHash}|${first.siblings[0]!.hash}`);
    const internalAsLeaf: MerkleProof = { ...first, leafHash: node, siblings: first.siblings.slice(1) };
    expect(await verifyMerkleProof(internalAsLeaf)).toBe(true);
    expect(await verifyMerkleProof(internalAsLeaf, 4)).toBe(false);
  });

  it("the compiled constraints refuse a direction that is not a Boolean, and accept the honest opening", async () => {
    const t = await traceOf(2);
    const o = opened(t, 0);
    const honest = await prepareCheck(UNIT, o.circuit, stepWitnessFunctions(o.witnesses), [o.statement]);
    expect(Buffer.from(((await honest.check()).spanOpening as { root: Uint8Array }).root).toString("hex")).toBe(t.tree.rootHash);
    const record: WitnessRecord = { requested: new Set(), read: [] };
    const prepared = await prepareCheck(UNIT, o.circuit, stepWitnessFunctions(o.witnesses, record), [o.statement]);
    const output = prepared.data.privateTranscriptOutputs[record.read.indexOf(`${o.circuit}_dirs`)] as { value: Uint8Array[] };
    expect(output.value).toHaveLength(1);
    output.value[0] = Uint8Array.of(2);
    await expect(prepared.check()).rejects.toThrow(/Failed direct assertion|boolean|bit/i);
    expect(await outcome(withWitness(o, "dirs", [2 as unknown as boolean] as unknown as StepWitness)), "binding check, not circuit evidence").toMatch(/type error/);
  });
});

// Whether span `index` is, at `level`, the odd last node that process-trace pairs with itself.
function selfPaired({ tree }: Trace, index: number, level: number): boolean {
  let width = tree.leafCount;
  let at = index;
  for (let i = 0; i < level; i++) {
    width = Math.ceil(width / 2);
    at = Math.floor(at / 2);
  }
  return width % 2 === 1 && at === width - 1 && width > 1;
}

// Gaps of the existing tree, pinned and documented, not fixed in this slice: its root commits no leaf count and no
// index, so an in-circuit walk cannot tell a real position from a padded one.
describe("T-C07 pinned gaps of the existing span tree, accepted in-circuit and refused only with a leaf count", () => {
  it.each([3, 5, 7])("a trace of %i spans: the odd last span also verifies at the padded index one past the end", async n => {
    const t = await traceOf(n);
    const last = n - 1;
    const honest = generateMerkleProof(t.tree, last);
    expect(honest.siblings[0]).toEqual({ hash: t.tree.leafHashes[last], position: "right" });
    const padded: MerkleProof = { ...honest, leafIndex: n, siblings: honest.siblings.map((s, level) => ({ ...s, position: (n >> level) & 1 ? "left" : "right" })) };
    expect(padded.siblings[0]!.position).toBe("left");
    // In-circuit: the same span and event under the padded path reach the root.
    expect(Buffer.from((await run(opened(t, last, siblingsOf(padded)))).root).toString("hex")).toBe(t.tree.rootHash);
    // process-trace: accepted without a leaf count, refused with the authenticated one.
    expect(await verifyMerkleProof(padded)).toBe(true);
    expect(await verifyMerkleProof(padded, n)).toBe(false);
    expect(await verifyMerkleProof(honest, n)).toBe(true);
  });

  it("three leaves and four leaves with the last duplicated have one root, so a path at index 3 of 4 opens under the 3-leaf root", async () => {
    const t = await traceOf(3);
    const [a, b, c] = t.tree.leafHashes as [string, string, string];
    const four: TraceMerkleTree = { rootHash: t.tree.rootHash, leafCount: 4, depth: 2, leafHashes: [a, b, c, c] };
    const fourth = generateMerkleProof(four, 3);
    expect(fourth.rootHash).toBe(t.tree.rootHash);
    expect(await verifyMerkleProof(fourth)).toBe(true);
    expect(await verifyMerkleProof(fourth, 4)).toBe(true);
    expect(await verifyMerkleProof(fourth, 3)).toBe(false);
    expect(Buffer.from((await run(opened(t, 2, siblingsOf(fourth)))).root).toString("hex")).toBe(t.tree.rootHash);
  });
});
