import { MandateGuard, type MandateV1 } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { MAX_U64 } from "./cases.js";
import { loadUnit } from "./harness.js";
import { rederivedStep, runCase, STEP_FIXTURE, stepOpeningOf, stepOutcome, STEPS_UNIT, stepWorld, withStepWitness, worldOf, type WindowSplit } from "./steps.js";

const { pureCircuits } = await loadUnit(STEPS_UNIT);

// The pure probe of the window gadget: "accepted", or the assert that refused the split.
function split(ts: bigint, clock: bigint, width: bigint, { q, r, rClock }: WindowSplit): string {
  try {
    pureCircuits.window_split!(ts, clock, width, q, r, rClock);
    return "accepted";
  } catch (error) {
    return (error as Error).message;
  }
}

const WIDTHS = [1n, 3600n, MAX_U64];
// Each width with an action at 0, at the last second of the first window, at the first second of the second and at the
// top of uint64, and a clock at the action time and at the last second of the action's window.
const CELLS = WIDTHS.flatMap(width => [...new Set([0n, width - 1n, width, MAX_U64])].flatMap(ts => {
  const q = ts / width;
  const last = q * width + width - 1n > MAX_U64 ? MAX_U64 : q * width + width - 1n;
  return [...new Set([ts, last])].map(clock => ({ width, ts, clock, honest: { q, r: ts % width, rClock: clock % width } }));
}));

describe("T-C02 the window gadget takes exactly the runtime's window of an action and its guard clock", () => {
  it("covers every width at every action time, with the clock at the action time and at its window's last second", () => {
    expect(CELLS.map(c => `${c.width}:${c.ts}:${c.clock}`)).toHaveLength(new Set(CELLS.map(c => `${c.width}:${c.ts}:${c.clock}`)).size);
    expect(CELLS.length).toBeGreaterThanOrEqual(3 * 3);
    for (const width of WIDTHS) expect(CELLS.filter(c => c.width === width).map(c => c.ts)).toEqual(expect.arrayContaining([0n, width - 1n, width, MAX_U64]));
  });

  it.each(CELLS)("W=$width ts=$ts clock=$clock: the honest split is accepted, and its quotient is the runtime's window index", ({ width, ts, clock, honest }) => {
    expect(split(ts, clock, width, honest)).toBe("accepted");
    expect(honest.q).toBe(ts / width);
    expect(clock / width).toBe(honest.q);
  });

  it.each(CELLS)("W=$width ts=$ts clock=$clock: every other quotient or remainder is refused", ({ width, ts, clock, honest }) => {
    const u64 = (v: bigint) => v >= 0n && v <= MAX_U64;
    const variants: [string, WindowSplit][] = [
      ["q+1", { ...honest, q: honest.q + 1n }], ["q-1", { ...honest, q: honest.q - 1n }],
      ["r+1", { ...honest, r: honest.r + 1n }], ["r-1", { ...honest, r: honest.r - 1n }],
      ["rClock+1", { ...honest, rClock: honest.rClock + 1n }], ["rClock-1", { ...honest, rClock: honest.rClock - 1n }],
      // The same action time written one window lower, with a remainder of a whole window more.
      ["q-1 with r+W", { q: honest.q - 1n, r: honest.r + width, rClock: honest.rClock + width }],
      ["r=W", { ...honest, r: width }],
    ];
    const tried = variants.filter(([, s]) => u64(s.q) && u64(s.r) && u64(s.rClock));
    expect(tried.length).toBeGreaterThanOrEqual(3);
    const accepted = tried.filter(([, s]) => split(ts, clock, width, s) === "accepted").map(([label]) => label);
    expect(accepted, "mutation accepted").toEqual([]);
    for (const [label, s] of tried) {
      if (label === "q-1 with r+W" || label === "r=W") expect(split(ts, clock, width, s), label).toBe("failed assert: window remainder");
    }
  });

  it("refuses a width of 0, which has no window", () => {
    expect(split(5n, 5n, 0n, { q: 0n, r: 5n, rClock: 5n })).toBe("failed assert: window remainder");
    expect(split(0n, 0n, 0n, { q: 0n, r: 0n, rClock: 0n })).toBe("failed assert: window remainder");
  });

  // The guard-vectors "window edge" shape: an action in the last second of a window under a clock in the next.
  it.each([[4n, 3n, 4n], [3600n, 3599n, 3600n], [MAX_U64, MAX_U64 - 1n, MAX_U64]])("W=%s: an action at %s under a clock at %s has no split, and the runtime refuses it too", (width, ts, clock) => {
    const spec = { ...STEP_FIXTURE.mandate, windowSeconds: String(width), notBefore: "0", notAfter: String(MAX_U64) };
    const world = stepWorld(spec);
    const mandate: MandateV1 = world.mandate;
    const guard = new MandateGuard({ mandate, counterpartyAllowlist: world.counterparties, egressAllowlist: world.egress!, history: "fresh", now: () => clock });
    expect(() => guard.enforce({ kind: "egress", destination: "api1", timestamp: ts })).toThrow("action timestamp must be in the guard clock's current window");
    const candidates: WindowSplit[] = [
      { q: ts / width, r: ts % width, rClock: clock % width }, { q: ts / width, r: ts % width, rClock: clock - (ts / width) * width },
      { q: clock / width, r: ts % width, rClock: clock % width }, { q: clock / width, r: 0n, rClock: clock % width },
    ];
    expect(candidates.map(s => split(ts, clock, width, s)).filter(result => result === "accepted")).toEqual([]);
  });
});

describe("T-C02 a step holds its event's action time and guard clock to one window", () => {
  const within = STEP_FIXTURE.cases.find(c => c.name === "within cap")!;

  it("an honest step discloses the runtime's window index, and a step whose clock precedes its action is refused as the runtime refuses it", async () => {
    const world = worldOf(within);
    const [step] = await runCase(within);
    const opening = stepOpeningOf(step!, world);
    expect(await stepOutcome(opening), "honest control").toBe("accepted");
    expect(opening.statement.windowIndex).toBe(step!.action.timestamp / world.mandate.spendCap.windowSeconds);
    // The event's two times swapped, with its hash chain, action digest and statement re-derived.
    const { ts, enforcedAt } = opening.segments;
    expect(Buffer.from(ts!).toString() < Buffer.from(enforcedAt!).toString()).toBe(true);
    expect(await stepOutcome(rederivedStep(opening, { segments: { ts: enforcedAt!, enforcedAt: ts! } }))).toBe("failed assert: action after guard clock");
    const guard = new MandateGuard({ mandate: world.mandate, counterpartyAllowlist: world.counterparties, egressAllowlist: world.egress!, history: "fresh", now: () => 2n });
    expect(() => guard.enforce({ ...step!.action, timestamp: 3n })).toThrow("action timestamp must not be later than the guard clock");
  });

  it("refuses every other window witness, and a window index that is not the quotient", async () => {
    const [step] = await runCase(within);
    const opening = stepOpeningOf(step!, worldOf(within));
    const honest = opening.witnesses[`${opening.circuit}_window`] as WindowSplit;
    expect(honest).toEqual({ q: 0n, r: 2n, rClock: 3n });
    const forged: WindowSplit[] = [{ q: 1n, r: 2n, rClock: 3n }, { q: 0n, r: 3n, rClock: 3n }, { q: 0n, r: 2n, rClock: 2n }, { q: 0n, r: 2n, rClock: 4n }, { q: 0n, r: 4n, rClock: 3n }];
    const outcomes = await Promise.all(forged.map(window => stepOutcome(withStepWitness(opening, "window", window))));
    expect(outcomes).toEqual([
      "failed assert: action window", "failed assert: action window", "failed assert: guard clock window", "failed assert: window remainder", "failed assert: window remainder",
    ]);
    for (const windowIndex of [1n, MAX_U64]) expect(await stepOutcome({ ...opening, statement: { ...opening.statement, windowIndex } })).toBe("failed assert: window index");
  });
});
