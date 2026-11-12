import { updateRollingHash } from "@fluxpointstudios/orynq-sdk-process-trace";
import { describe, expect, it } from "vitest";
import { MAX_U64 } from "./cases.js";
import { fieldVariants, latin1 } from "./openings.js";
import { chain, mandateAtoms, type RollStatement } from "./statement-checker.js";
import {
  acceptedMutations, atomsOf, checkStep, maxStep, rederivedStep, refusedByAssert, runCase, runStep, STEP_CLASSES, STEP_FIELDS, STEP_FIXTURE, stepMutations, stepOpeningOf, stepOutcome,
  stepWorld, withClaim, withStepWitness, worldOf, type FixtureCase, type MandateAtoms, type StepOpening, type StepWitness, type StepWorld, type TracedStep,
} from "./steps.js";

const CASES = STEP_FIXTURE.cases;
const traced = new Map(await Promise.all(CASES.map(async c => [c.name, await runCase(c)] as const)));
const UNPROVABLE = [5, 7];

/** The statement a step of `world` must disclose, computed by the product's own functions and the harness's spend model. */
async function productStatement(step: TracedStep, world: StepWorld): Promise<Record<string, Uint8Array | bigint>> {
  const roll = await updateRollingHash({ currentHash: step.rollBefore, itemCount: 0 }, step.event.hash!);
  expect(roll.currentHash).toBe(step.rollAfter);
  return {
    prevRollHex: latin1(step.rollBefore), rollAfter: new Uint8Array(Buffer.from(roll.currentHash, "hex")), atoms: mandateAtoms(world.mandate),
    windowIndex: step.action.timestamp / world.mandate.spendCap.windowSeconds, priorSpent: step.priorSpent, verdict: BigInt(step.verdict),
    dataSeq: step.guardEvent.seq, traceSeq: BigInt(step.event.seq),
  };
}

describe("T-C03 every step of the class-fit guard sequences proves the decision the guard recorded", () => {
  it("the sequences meet every verdict code, every step class and a second step in a spend window", () => {
    const steps = CASES.flatMap(c => traced.get(c.name)!.map(step => ({ c, step })));
    expect([...new Set(steps.map(({ step }) => step.verdict))].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const classes = steps.filter(({ step }) => !UNPROVABLE.includes(step.verdict)).map(({ c, step }) => stepOpeningOf(step, worldOf(c)).circuit);
    expect([...new Set(classes)].sort()).toEqual(Object.keys(STEP_CLASSES).filter(id => id !== "st_pa_max_d8").sort());
    expect(steps.some(({ step }) => step.priorSpent > 0n)).toBe(true);
  });

  it.each(CASES)("$name: the runtime decides as the fixture expects, with the harness's spend model equal to the guard's", c => {
    const steps = traced.get(c.name)!;
    expect(steps.map(step => step.verdict)).toEqual(c.steps.map(step => step.expect));
    expect(steps.map(step => step.priorSpent)).toEqual(steps.map(step => step.runtimePrior));
    for (const step of steps) expect(step.guardEvent.type).toBe(step.verdict === 0 ? "orynq.conduct.guard.action.v1" : "orynq.conduct.guard.denial.v1");
  });

  it.each(CASES)("$name: each step discloses the recorded decision, the mandate's K, its window and the stated prior spend, and the steps chain", async c => {
    const world = worldOf(c);
    const statements: RollStatement[] = [];
    for (const step of traced.get(c.name)!) {
      if (UNPROVABLE.includes(step.verdict)) {
        expect(() => stepOpeningOf(step, world)).toThrow("NON_MEMBERSHIP_UNPROVABLE: non-membership not provable");
        continue;
      }
      const opening = stepOpeningOf(step, world);
      const disclosed = await runStep(opening) as Record<string, Uint8Array | bigint>;
      expect(disclosed).toEqual(await productStatement(step, world));
      expect(Object.keys(disclosed)).toEqual([...STEP_FIELDS]);
      statements.push(disclosed as unknown as RollStatement);
    }
    if (statements.length === c.steps.length) await expect(chain(statements)).resolves.toBeUndefined();
  });

  it("a junk path for an on-list party is refused as non-membership, never proven as a denial", async () => {
    for (const name of ["cap-exact", "cumulative", "egress allowed"]) {
      const c = CASES.find(x => x.name === name)!;
      const opening = stepOpeningOf(traced.get(name)!.at(-1)!, worldOf(c));
      expect(await stepOutcome(opening), "honest control").toBe("accepted");
      const junk = stepMutations(opening).get(`${opening.circuit}_path`)!;
      expect(junk.length).toBe(8);
      for (const { label, value } of junk) {
        expect(await stepOutcome({ ...opening, witnesses: { ...opening.witnesses, [`${opening.circuit}_path`]: value } }), label)
          .toMatch(/^failed assert: (non-membership not provable|allowlist path not canonical)$/);
      }
    }
  });

  it("st_pa_max_d8 proves an allowed payment at the top of every length, which the runtime allows under the same mandate and clock", async () => {
    const { step, world, runtime } = await maxStep();
    expect(runtime).toEqual({ allowed: true });
    const opening = stepOpeningOf(step, world);
    expect(opening.circuit).toBe("st_pa_max_d8");
    expect(await runStep(opening)).toEqual(await productStatement(step, world));
  });
});

/** One honest step of each step class: a payment at the cap exactly, and a denial 4 one unit over it. */
const REPRESENTATIVES: readonly (readonly [string, string, number])[] = [
  ["st_pa", "cap-exact", 0], ["st_pd1", "before notBefore", 0], ["st_pd2", "notAfter exclusive", 0], ["st_pd3", "asset mismatch", 0], ["st_pd4", "cumulative", 2],
  ["st_ea", "egress allowed", 0], ["st_ed1", "egress early", 0], ["st_ed2", "egress expiry", 0], ["st_ed6", "deny-all", 0],
];
const caseOf = (name: string): FixtureCase => CASES.find(c => c.name === name)!;
const representative = (id: string): { opening: StepOpening; step: TracedStep; world: StepWorld } => {
  const [, name, at] = REPRESENTATIVES.find(([circuit]) => circuit === id)!;
  const world = worldOf(caseOf(name));
  const step = traced.get(name)![at]!;
  return { opening: stepOpeningOf(step, world), step, world };
};
const CLASS_IDS = REPRESENTATIVES.map(([id]) => id);
/** The classes whose verdict reads the prior spend. */
const SPEND_CLASSES = ["st_pa", "st_pd4"];
const BINDING = /^failed assert: (hex opening|rolling root mismatch)$/;
const SEGMENT = /^st_\w+?_(amount|asset|counterparty|destination|ts|actionDigest|enforcedAt|mandateCommitment|dataSeq|id|traceSeq|iso|vis|eventHex)$/;

// The mutations of a witness the table must hold, counted from the witness alone.
function expectedMutations(value: StepWitness): number {
  if (value instanceof Uint8Array) return value.reduce((n, b) => n + (b > 0 ? 1 : 0) + (b < 255 ? 1 : 0), 0);
  if (Array.isArray(value)) return 4 * value.length;
  return Object.values(value as MandateAtoms).reduce<number>((n, part) => n + (part instanceof Uint8Array ? 2 : part === 0n || part === MAX_U64 ? 1 : 2), 0);
}

describe("T-C04 every disclosed field and every witness of a step is bound", () => {
  it("has an honest representative of every step class", () => {
    expect(CLASS_IDS.map(id => representative(id).opening.circuit)).toEqual(CLASS_IDS);
    expect([...CLASS_IDS, "st_pa_max_d8"].sort()).toEqual(Object.keys(STEP_CLASSES).sort());
  });

  it.each(CLASS_IDS)("%s: every statement field moved is refused", async id => {
    const { opening, world } = representative(id);
    expect(await stepOutcome(opening), "honest control").toBe("accepted");
    const accepted: string[] = [];
    let tried = 0;
    const attempt = async (label: string, claim: Record<string, Uint8Array | bigint>) => {
      tried += 1;
      const result = await stepOutcome(withClaim(opening, claim));
      if (!refusedByAssert(result)) accepted.push(`${label}: ${result}`);
    };
    for (const field of ["prevRollHex", "rollAfter", "atoms", "windowIndex", "dataSeq", "traceSeq"]) {
      for (const variant of fieldVariants(field, opening.statement[field]!)) await attempt(`${field} = ${String(variant)}`, { [field]: variant });
    }
    // The K of another mandate: the same one with a cap one unit apart.
    const { spendCap } = world.mandate;
    await attempt("atoms of another mandate", { atoms: mandateAtoms({ ...world.mandate, spendCap: { ...spendCap, amount: spendCap.amount ^ 1n } }) });
    for (let verdict = 0n; verdict < 256n; verdict++) if (verdict !== opening.statement.verdict) await attempt(`verdict = ${verdict}`, { verdict });
    expect(accepted, "mutation accepted").toEqual([]);
    expect(tried).toBeGreaterThanOrEqual(3 * 6 + 1 + 255);
  });

  it.each(SPEND_CLASSES)("%s: a prior spend moved across the cap is refused as a verdict mismatch", async id => {
    const { opening, step, world } = representative(id);
    const { amount: cap } = world.mandate.spendCap;
    const amount = step.action.kind === "payment" ? step.action.amount : 0n;
    // The largest prior the cap still admits the amount after, and the first it does not.
    const [under, over] = [cap - amount, cap - amount + 1n];
    expect(step.priorSpent).toBe(id === "st_pa" ? under : over);
    const crossed = id === "st_pa" ? over : under;
    expect(await stepOutcome(withClaim(opening, { priorSpent: crossed }))).toBe("failed assert: verdict mismatch");
    expect(await stepOutcome(withClaim(opening, { priorSpent: crossed, verdict: id === "st_pa" ? 4n : 0n })), "mutation accepted").toBe("failed assert: recorded decision");
  });

  // Assumption A1: the prior spend is a stated input. A step proves its verdict for the prior it states, and any prior
  // with the same verdict proves as well; only slice 3's committed spend state can tell them apart.
  it.each(CLASS_IDS)("%s: pinned gap, not fixed here: a stated prior spend that leaves the verdict unchanged still proves", async id => {
    const { opening, step, world } = representative(id);
    const { amount: cap } = world.mandate.spendCap;
    const amount = step.action.kind === "payment" ? step.action.amount : 0n;
    const same = id === "st_pa" ? [0n].filter(p => p + amount <= cap && p !== step.priorSpent) : id === "st_pd4" ? [MAX_U64] : [step.priorSpent + 1n, MAX_U64];
    for (const priorSpent of same) expect(await stepOutcome(withClaim(opening, { priorSpent })), `prior ${priorSpent}`).toBe("accepted");
  });

  it.each([...CLASS_IDS, "st_pa_max_d8"])("%s: every witness mutation is refused, and every event segment is bound to the event hash", async id => {
    const opening = id === "st_pa_max_d8" ? await maxStep().then(({ step, world }) => stepOpeningOf(step, world)) : representative(id).opening;
    expect(await stepOutcome(opening), "honest control").toBe("accepted");
    const table = stepMutations(opening);
    expect([...table.keys()]).toEqual(Object.keys(opening.witnesses));
    for (const [name, mutations] of table) expect(mutations.length, name).toBe(expectedMutations(opening.witnesses[name]!));
    expect(await acceptedMutations(opening, table), "mutation accepted").toEqual([]);
    const unbound: string[] = [];
    for (const [name, mutations] of table) {
      if (!SEGMENT.test(name)) continue;
      // A moved hex character can leave the hex class, which its own check refuses first; one of the first moves stays in it.
      const results = await Promise.all(mutations.slice(0, 4).map(({ value }) => stepOutcome({ ...opening, witnesses: { ...opening.witnesses, [name]: value } })));
      if (!results.some(result => BINDING.test(result))) unbound.push(name);
    }
    expect(unbound, "segments with no rejection by the hash link").toEqual([]);
  }, 600_000);
});

// Each lie a prover can tell beside the event bytes, with K, the window and the statement re-derived from it.
const lies = (o: StepOpening): [string, Partial<StepOpening["context"]>][] => {
  const { atoms } = o.context;
  const lie = (change: Partial<MandateAtoms>) => ({ atoms: { ...atoms, ...change } });
  return [
    ["a prior spend of 0", { priorSpent: 0n }], ["a prior spend of 2^64-1", { priorSpent: MAX_U64 }], ["a prior spend one more", { priorSpent: o.context.priorSpent + 1n }],
    ["a validity window from 0", lie({ notBefore: 0n })], ["a validity window to 2^64-1", lie({ notAfter: MAX_U64 })],
    ["a validity window that has not begun", lie({ notBefore: atoms.notAfter - 1n })], ["a validity window that ended at 1", lie({ notBefore: 0n, notAfter: 1n })],
    ["a cap of 0", lie({ capAmount: 0n })], ["a cap of 2^64-1", lie({ capAmount: MAX_U64 })],
    ["the other egress mode", lie({ egressMode: atoms.egressMode ^ 1n })], ["another mandated asset", lie({ assetDigest: Uint8Array.from(atoms.assetDigest, b => b ^ 1) })],
    ["another counterparty root", lie({ counterpartyRoot: Uint8Array.from(atoms.counterpartyRoot, b => b ^ 1) })],
    ["another egress root", lie({ egressRoot: Uint8Array.from(atoms.egressRoot, b => b ^ 1) })],
    // An expired step reaches another provable verdict only past its expiry and one more rule.
    ["a validity window to 2^64-1 and another mandated asset", lie({ notAfter: MAX_U64, assetDigest: Uint8Array.from(atoms.assetDigest, b => b ^ 1) })],
    ["a validity window to 2^64-1 and the other egress mode", lie({ notAfter: MAX_U64, egressMode: atoms.egressMode ^ 1n })],
  ];
};

describe("T-C04 a step never proves a verdict other than the decision its event records", () => {
  it.each(CLASS_IDS)("%s: under every lie about the prior spend or the mandate atoms, with K and the statement re-derived, only the recorded decision proves", async id => {
    const { opening } = representative(id);
    const recorded = opening.statement.verdict as bigint;
    const accepted: string[] = [];
    const reasons = new Set<string>();
    for (const [label, context] of lies(opening)) {
      for (let verdict = 0n; verdict < 8n; verdict++) {
        const result = await stepOutcome(rederivedStep(opening, { context }, { verdict }));
        if (result === "accepted" ? verdict !== recorded : !refusedByAssert(result)) accepted.push(`${label}, claiming verdict ${verdict}: ${result}`);
        reasons.add(result);
      }
    }
    expect(accepted, "mutation accepted").toEqual([]);
    // At least one lie computed another verdict, which its own claim then stated: only the recorded decision refused it.
    expect([...reasons]).toContain("failed assert: recorded decision");
  });

  it("st_pd4: a lower prior spend makes the cap rule allow the payment the guard denied, and the recorded denial refuses it", async () => {
    const { opening } = representative("st_pd4");
    expect(await stepOutcome(rederivedStep(opening, { context: { priorSpent: 0n } }, { verdict: 0n })), "mutation accepted").toBe("failed assert: recorded decision");
  });

  it.each(CLASS_IDS)("%s: an event crafted to contradict its record, with its hashes and statement re-derived, is refused", async id => {
    const { opening } = representative(id);
    const text = (s: string) => new TextEncoder().encode(s);
    const payment = opening.kind.startsWith("payment");
    const party = payment ? "counterparty" : "destination";
    const forgeries: [string, StepOpening, RegExp][] = [
      ["another action digest", rederivedStep(opening, { segments: { actionDigest: text("ab".repeat(32)) } }), /^failed assert: hex opening$/],
      ["a party with a quote", rederivedStep(opening, { segments: { [party]: text('ac"e') } }), /^failed assert: string outside escape-free well-formed UTF-8 class$/],
      ["an uppercase mandate commitment", rederivedStep(opening, { segments: { mandateCommitment: text("AB".repeat(32)) } }), /^failed assert: noncanonical hex$/],
      ["an uppercase id", rederivedStep(opening, { segments: { id: text(Buffer.from(opening.segments.id!).toString().toUpperCase()) } }), /^failed assert: uuid$/],
      ["a trace time without its Z", rederivedStep(opening, { segments: { iso: text(Buffer.from(opening.segments.iso!).toString().replace("Z", "z")) } }), /^failed assert: iso8601$/],
      ["another visibility", rederivedStep(opening, { segments: { vis: text("Private") } }), /^failed assert: visibility$/],
      ["a guard log position of /", rederivedStep(opening, { segments: { dataSeq: text("/") } }), /^failed assert: decimal digit$/],
      ["a trace sequence of :", rederivedStep(opening, { segments: { traceSeq: text(":") } }), /^failed assert: decimal digit$/],
      ["an action time of /", rederivedStep(opening, { segments: { ts: text("/") } }), /^failed assert: decimal digit$/],
      ["a guard clock of :", rederivedStep(opening, { segments: { enforcedAt: text(":") } }), /^failed assert: decimal digit$/],
      ["an uppercase action digest", rederivedStep(opening, { segments: { actionDigest: text(Buffer.from(opening.segments.actionDigest!).toString().toUpperCase()) } }), /^failed assert: noncanonical hex$/],
      ...(payment ? [
        ["an amount of 0", rederivedStep(opening, { segments: { amount: text("0") } }), /^failed assert: (decimal nonzero|payment amount out of domain)$/],
        ["an amount of :", rederivedStep(opening, { segments: { amount: text(":") } }), /^failed assert: decimal digit$/],
        ["an asset with a backslash", rederivedStep(opening, { segments: { asset: text("U\\D") } }), /^failed assert: string outside escape-free well-formed UTF-8 class$/],
      ] as [string, StepOpening, RegExp][] : []),
    ];
    for (const [label, forged, refusal] of forgeries) expect(await stepOutcome(forged), label).toMatch(refusal);
    // Another mandate's commitment and K, wholly consistent with each other: the event's own commitment hex refuses it.
    const other = Uint8Array.from(opening.witnesses[`${id}_commitment`] as Uint8Array, b => b ^ 1);
    expect(await stepOutcome(rederivedStep(opening, { context: { commitment: other } })), "another mandate's commitment").toBe("failed assert: hex opening");
  });

  it("st_pa: another asset, an off-list counterparty or a larger amount than the cap admits never proves the allowed decision", async () => {
    const { opening } = representative("st_pa");
    const text = (s: string) => new TextEncoder().encode(s);
    const crafted: [string, Record<string, Uint8Array>, string[]][] = [
      ["the asset EUR", { asset: text("EUR") }, ["failed assert: verdict mismatch", "failed assert: recorded decision"]],
      ["the counterparty zzzz", { counterparty: text("zzzz") }, ["failed assert: non-membership not provable", "failed assert: non-membership not provable"]],
    ];
    for (const [label, segments, [claimingAllowed, claimingComputed]] of crafted) {
      expect(await stepOutcome(rederivedStep(opening, { segments })), label).toBe(claimingAllowed);
      for (let verdict = 1n; verdict < 8n; verdict++) expect(await stepOutcome(rederivedStep(opening, { segments }, { verdict })), `${label} claiming ${verdict}`).not.toBe("accepted");
      expect(await stepOutcome(rederivedStep(opening, { segments }, { verdict: label.includes("EUR") ? 3n : 5n })), label).toBe(claimingComputed);
    }
  });

  it.each(CLASS_IDS)("%s: the witnesses of one step under the statement of another step of its class are refused", async id => {
    const [, name, at] = REPRESENTATIVES.find(([circuit]) => circuit === id)!;
    const world = worldOf(caseOf(name));
    const a = stepOpeningOf(traced.get(name)![at]!, world);
    // The same sequence run again: another trace, so another event id, rolling chain and action digest in the same class.
    const b = stepOpeningOf((await runCase(caseOf(name)))[at]!, world);
    expect([a.circuit, b.circuit]).toEqual([id, id]);
    expect(await stepOutcome(b), "honest control").toBe("accepted");
    expect(Buffer.from(a.segments.id!).equals(Buffer.from(b.segments.id!))).toBe(false);
    for (const statement of [b.statement, { ...a.statement, rollAfter: b.statement.rollAfter! }]) {
      expect(await stepOutcome({ ...a, statement }), "mutation accepted").toBe("failed assert: rolling root mismatch");
    }
    expect(await stepOutcome({ ...a, witnesses: { ...a.witnesses, [`${id}_eventHex`]: b.witnesses[`${id}_eventHex`]! } }), "mutation accepted").toBe("failed assert: hex opening");
  });

  it("st_pa: the action fields under an action digest that is not theirs are refused by the digest link", async () => {
    const { opening } = representative("st_pa");
    const kept = opening.segments.actionDigest!;
    for (const [name, bytes] of [["amount", "8"], ["asset", "EUR"], ["counterparty", "beta"], ["ts", "2"]] as const) {
      const forged = rederivedStep(opening, { segments: { [name]: new TextEncoder().encode(bytes), actionDigest: kept } });
      expect(await stepOutcome(forged), name).toBe("failed assert: hex opening");
    }
  });
});

describe("T-C03/T-C04 at the ZKIR layer, on copies whose generated JS checks nothing", () => {
  it.each(CLASS_IDS)("%s: check accepts the honest step and discloses its statement", async id => {
    const { opening, step, world } = representative(id);
    expect(await checkStep(opening)).toEqual(await productStatement(step, world));
  });

  it("st_pa_max_d8: check accepts the honest step at the top of every length, and refuses its verdict moved", async () => {
    const { step, world } = await maxStep();
    const opening = stepOpeningOf(step, world);
    expect(await checkStep(opening)).toEqual(await productStatement(step, world));
    await expect(checkStep(withClaim(opening, { verdict: 4n }))).rejects.toThrow(/Failed direct assertion/);
  }, 600_000);

  it.each(["st_pa", "st_pd4", "st_ea"])("%s: check refuses a moved statement field, a lie about the prior spend, a moved atom, a junk path and a moved window", async id => {
    const { opening } = representative(id);
    const refused = async (label: string, forged: StepOpening) => expect(checkStep(forged), label).rejects.toThrow(/Failed direct assertion/);
    for (const field of ["rollAfter", "atoms", "windowIndex", "verdict", "dataSeq", "traceSeq"]) {
      await refused(`${field} moved`, withClaim(opening, { [field]: fieldVariants(field, opening.statement[field]!).at(-1)! }));
    }
    if (id !== "st_ea") {
      const crossed = id === "st_pa" ? { priorSpent: opening.context.atoms.capAmount, verdict: 4n } : { priorSpent: 0n, verdict: 0n };
      await refused("a prior spend that changes the verdict, claimed with it", rederivedStep(opening, { context: { priorSpent: crossed.priorSpent } }, { verdict: crossed.verdict }));
    }
    const table = stepMutations(opening);
    for (const witness of ["atoms", "window", "path", "commitment", "actionDigest"]) {
      const { label, value } = table.get(`${id}_${witness}`)![0]!;
      await refused(label, withStepWitness(opening, witness, value));
    }
  }, 600_000);

  it("the world of the fixture commits its lists in the atoms every step reads", () => {
    const world = stepWorld(STEP_FIXTURE.mandate);
    expect(atomsOf(world.mandate).counterpartyRoot).toEqual(world.mandate.counterpartyAllowlistRoot);
  });
});
