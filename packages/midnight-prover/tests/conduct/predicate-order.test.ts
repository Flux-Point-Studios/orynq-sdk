import { describe, expect, it } from "vitest";
import { checkVerdictArgs, circuitOutcomes, CLAIMS, slot } from "./cases.js";
import { loadUnit, zkCheck, type Outcome } from "./harness.js";
import {
  agrees, assertsApplying, ATOMS, atomTruths, cellsOf, judgementsOf, ORDER_SCALES, orderCases, orderChunks, weakOrderings, withoutStacks, type Judgement, type OrderCell,
} from "./order-type.js";

const { pureCircuits } = await loadUnit("predicate");
const show = (got: Outcome) => (typeof got === "number" ? String(got) : got.throws);
const chunks = orderChunks();

describe("T-A17 every order type of the validity window, action time and guard clock, judged by the runtime guard", () => {
  it("enumerates all 75 weak orderings of notBefore, notAfter, the action time and the guard clock at three scales", () => {
    expect(weakOrderings()).toHaveLength(75);
    expect(chunks.map(chunk => chunk.label)).toHaveLength(75 * ORDER_SCALES.length);
    expect(new Set(chunks.map(chunk => chunk.label)).size).toBe(chunks.length);
    // Per order type, 17 amount, prior and cap relations times 4 kinds, 4 modes and 8 membership combinations; a prior of
    // 2^64-1 adds 3 relations under the valid modes wherever the runtime can hold it, which is 20 order types per scale.
    expect(chunks.reduce((count, chunk) => count + cellsOf(chunk).length, 0)).toBe(225 * 17 * 4 * 4 * 8 + 3 * 20 * 3 * 2 * 4 * 8);
  });

  // Inside one order type the cells cross the payment, egress and out-of-domain kinds and modes with every relation of
  // prior spend plus amount to the cap, amounts of 0, 1 and a mid value, priors of 0, a mid value and 2^64-1 where the
  // runtime can hold it, and every asset, counterparty and egress membership.
  it.each(chunks.map(chunk => [chunk.label, chunk] as const))("%s", (_label, chunk) => {
    const wrong: string[] = [];
    const cells = cellsOf(chunk);
    const judgements = judgementsOf(chunk, cells);
    withoutStacks(() => {
      for (const [i, cell] of cells.entries()) {
        const judged = judgements[i]!;
        const got = circuitOutcomes(pureCircuits, cell);
        if (!agrees(got.evaluate, judged.evaluate, () => assertsApplying(cell).evaluate) || !agrees(got.guard, judged.guard, () => assertsApplying(cell).guard)) {
          wrong.push(`${cell.name}: evaluate ${show(got.evaluate)} where the runtime gives ${judged.evaluate}, guard_verdict ${show(got.guard)} where it gives ${judged.guard}`);
        }
      }
    });
    expect(wrong.length, `cells that disagree, of which the first three:\n${wrong.slice(0, 3).join("\n")}`).toBe(0);
  });

  // Comparisons that share no input are independent, so the truth assignments an input can produce are the products of
  // those each group of comparisons sharing inputs can produce. Each group's are found by brute force over a domain that
  // reaches all of them: every weak ordering of the four times occurs in {0..3}^4, kind and mode range over all of
  // Uint<8>, and the two spend comparisons reach all four assignments within {0, 1, 2}.
  it("every truth assignment of the audited comparisons and Boolean inputs that an input can produce is met by a cell", () => {
    const DOMAINS: Record<string, readonly (bigint | boolean)[]> = {
      ...Object.fromEntries(["not_before", "not_after", "action_timestamp", "enforced_at"].map(name => [name, [0n, 1n, 2n, 3n]])),
      ...Object.fromEntries(["action_kind", "egress_mode"].map(name => [name, Array.from({ length: 256 }, (_, i) => BigInt(i))])),
      ...Object.fromEntries(["action_amount", "prior_spent", "cap_amount"].map(name => [name, [0n, 1n, 2n]])),
      cap_asset: [0n, 1n], action_asset: [0n, 1n], counterparty_ok: [false, true], egress_ok: [false, true],
    };
    const groups: { names: Set<string>; atoms: number[] }[] = [];
    ATOMS.forEach(({ inputs }, index) => {
      const joined = groups.filter(group => inputs.some(name => group.names.has(name)));
      const merged = { names: new Set([...inputs, ...joined.flatMap(group => [...group.names])]), atoms: [...joined.flatMap(group => group.atoms), index] };
      groups.splice(0, groups.length, ...groups.filter(group => !joined.includes(group)), merged);
    });
    expect(groups.flatMap(group => [...group.names]).sort()).toEqual(Object.keys(DOMAINS).sort());
    const reachable = groups.map(({ names, atoms }) => {
      let envs: Record<string, bigint | boolean>[] = [{}];
      for (const name of names) envs = envs.flatMap(env => DOMAINS[name]!.map(value => ({ ...env, [name]: value })));
      return new Set(envs.map(env => atoms.map(index => (ATOMS[index]!.holds(env) ? 1 : 0)).join("")));
    });
    const met = groups.map(() => new Set<string>());
    const vectors = new Set<string>();
    for (const { cell } of orderCases()) {
      const truths = atomTruths(cell);
      vectors.add(truths.map(t => (t ? 1 : 0)).join(""));
      groups.forEach(({ atoms }, i) => met[i]!.add(atoms.map(index => (truths[index] ? 1 : 0)).join("")));
    }
    expect(met.map(set => [...set].sort())).toEqual(reachable.map(set => [...set].sort()));
    expect(vectors.size).toBe(reachable.reduce((product, set) => product * set.size, 1));
  });

  // A rule or refusal gated on a spend, a band or a lag survives every cell that misses its gate, so the cells meet: a
  // refusal or rule after a spend off-list or under deny-all, an out-of-domain kind strictly past notAfter, every payment
  // verdict with a slot between 2^32 and 2^53, and a lag of 2^32.
  it("meets every crossing of a spend, a band or a lag with a verdict or refusal, at every scale", () => {
    const U32 = 1n << 32n, U53 = 1n << 53n;
    const crossings: [string, (c: OrderCell, judged: Judgement) => boolean][] = [];
    const v = (c: OrderCell, name: string) => c.args[slot(name)]!;
    const spent = (c: OrderCell) => (v(c, "prior_spent") as bigint) > 0n && c.held;
    const offListPayment = (c: OrderCell) => v(c, "action_kind") === 0n && v(c, "counterparty_ok") === false && v(c, "action_asset") === v(c, "cap_asset");
    const clockExpiry = (c: OrderCell) => v(c, "action_timestamp") < v(c, "not_after") && c.enforcedAt >= (v(c, "not_after") as bigint);
    const later = (c: OrderCell) => (v(c, "action_timestamp") as bigint) > c.enforcedAt;
    for (const scale of ORDER_SCALES) {
      const on = (c: OrderCell) => c.scale === scale;
      crossings.push(
        [`${scale}: a zero payment under deny-all after a spend is refused`, (c, j) => on(c) && spent(c) && v(c, "egress_mode") === 0n && v(c, "action_kind") === 0n && v(c, "action_amount") === 0n && j.guard === "refused"],
        [`${scale}: an off-list payment after a spend under a clock-decided expiry`, (c, j) => on(c) && spent(c) && offListPayment(c) && clockExpiry(c) && j.guard === 2],
        [`${scale}: an off-list payment after a spend later than the clock`, (c, j) => on(c) && spent(c) && offListPayment(c) && later(c) && j.guard === "refused"],
        [`${scale}: a deny-all payment after a spend under a clock-decided expiry`, (c, j) => on(c) && spent(c) && v(c, "egress_mode") === 0n && v(c, "action_kind") === 0n && clockExpiry(c) && j.guard === 2],
        [`${scale}: an out-of-domain kind strictly past notAfter`, (c, j) => on(c) && v(c, "action_kind") === 2n && v(c, "action_timestamp") > v(c, "not_after") && j.guard === "refused"],
      );
    }
    const band = (value: bigint) => value > U32 && value < U53;
    for (const name of ["action_amount", "prior_spent", "cap_amount"]) {
      for (const verdict of [0, 3, 4, 5]) {
        crossings.push([`a payment judged ${verdict} with ${name} strictly between 2^32 and 2^53`, (c, j) => v(c, "action_kind") === 0n && j.guard === verdict && band(v(c, name) as bigint)]);
      }
    }
    crossings.push([`an action at least 2^32 later than the clock`, (c, j) => (v(c, "action_timestamp") as bigint) - c.enforcedAt >= U32 && j.guard === "refused"]);
    const missing = new Set(crossings.map(([name]) => name));
    for (const { cell, judged } of orderCases()) {
      for (const [name, holds] of crossings) if (missing.has(name) && holds(cell, judged)) missing.delete(name);
    }
    expect([...missing]).toEqual([]);
  });
});

// One case per decision path and scale, and for each also its first case after a spend: check accepts exactly the
// runtime verdict, and no claim for an input the runtime refuses. A refused case is one that only its own refusal
// applies to, so the sample meets each refusal alone.
const strata = new Map<string, { readonly cell: OrderCell; readonly judged: Judgement }[]>();
for (const sample of orderCases()) {
  if (assertsApplying(sample.cell).guard.length > 1) continue;
  const key = `${sample.cell.scale}: ${sample.judged.path}`;
  const chosen = strata.get(key);
  if (chosen === undefined) strata.set(key, [sample]);
  else if (chosen.length === 1 && sample.cell.held) chosen.push(sample);
}

describe("T-A17 ZKIR leg: a stratified sample checks exactly the runtime verdict", () => {
  it("meets every decision path, refusals included, at every scale", () => {
    const paths = [
      "refused: empty validity window", "refused: egress mode", "refused: action kind", "refused: zero payment", "refused: later than the clock",
      "0 ALLOW payment", "0 ALLOW egress", "1 MANDATE_NOT_YET_VALID", "2 MANDATE_EXPIRED by the action time", "2 MANDATE_EXPIRED by the clock",
      "3 ASSET_MISMATCH", "4 SPEND_CAP_EXCEEDED", "5 COUNTERPARTY_NOT_ALLOWED", "6 EGRESS_DENIED", "7 EGRESS_NOT_ALLOWED",
    ];
    expect([...strata.keys()].sort()).toEqual(ORDER_SCALES.flatMap(scale => paths.map(path => `${scale}: ${path}`)).sort());
    // No cell after a spend exists for an empty validity window, an out-of-domain mode or an action before notBefore.
    expect([...strata.values()].flat()).toHaveLength(45 + 45 - 3 * 3);
  });

  it.each([...strata].flatMap(([key, samples]) => samples.map(({ cell, judged }) => [`${key}: ${cell.name}`, cell, judged.guard] as const)))("%s", async (_name, cell, expected) => {
    for (const claimed of CLAIMS) {
      const disclosed = await zkCheck("predicate", "check_verdict", {}, checkVerdictArgs(cell, claimed)).then(ledger => ledger.verdictOut, (error: Error) => {
        if (!/Failed direct assertion/.test(error.message)) throw error;
        return undefined;
      });
      expect(disclosed, `claim ${claimed}`).toBe(claimed === expected ? BigInt(claimed) : undefined);
    }
  });
});
