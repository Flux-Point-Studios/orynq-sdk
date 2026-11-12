import * as runtime from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";
import { CLASSES } from "../../scripts/conduct/template.mjs";
import { loadUnit, runLedger } from "./harness.js";
import { HONEST_MANDATES, mandateOpeningOf } from "./mandates.js";
import { honestEvents, openingOf, OPENINGS_UNIT, privateInputs } from "./openings.js";
import { maxStep, runCase, STEP_CLASSES, STEP_FIXTURE, stepMutations, stepOpeningOf, STEPS_UNIT, stepWitnessFunctions, worldOf, type StepWitness, type WitnessRecord } from "./steps.js";

interface Covered { readonly unit: string; readonly circuit: string; readonly witnesses: Readonly<Record<string, StepWitness>>; readonly statement: unknown; readonly table: readonly string[] }

// One honest opening of every exported provable circuit, with the witness names its mutation test moves:
//   ev_* (T-B07): every byte of every witness of the opening;
//   m_*  (T-B13): every byte of the CBOR, which the class's witnesses are the field bytes of;
//   st_* (T-C04): the keys of stepMutations.
async function covered(): Promise<Covered[]> {
  const events = [...await honestEvents()].map(([circuit, e]) => {
    const { witnesses, statement } = openingOf(e);
    return { unit: OPENINGS_UNIT, circuit, witnesses, statement, table: Object.keys(witnesses) };
  });
  const mandates = Object.keys(CLASSES.openings.mandates).map(circuit => {
    const { witnesses, statement, segments } = mandateOpeningOf(HONEST_MANDATES.find(([, , id]) => id === circuit)![1]);
    return { unit: OPENINGS_UNIT, circuit, witnesses, statement, table: Object.keys(segments).map(name => `${circuit}_${name}`) };
  });
  const openings = new Map<string, ReturnType<typeof stepOpeningOf>>();
  for (const c of STEP_FIXTURE.cases) {
    for (const step of await runCase(c)) {
      if (step.verdict === 5 || step.verdict === 7) continue;
      const opening = stepOpeningOf(step, worldOf(c));
      if (!openings.has(opening.circuit)) openings.set(opening.circuit, opening);
    }
  }
  const max = await maxStep();
  openings.set("st_pa_max_d8", stepOpeningOf(max.step, max.world));
  const steps = [...openings].map(([circuit, o]) => ({ unit: STEPS_UNIT, circuit, witnesses: o.witnesses, statement: o.statement, table: [...stepMutations(o).keys()] }));
  return [...events, ...mandates, ...steps];
}

const all = await covered();
const UNITS = [OPENINGS_UNIT, STEPS_UNIT];

// The witness names a unit's contract asks its witness object for at construction: every witness the unit declares.
async function requested(unit: string): Promise<string[]> {
  const record: WitnessRecord = { requested: new Set(), read: [] };
  const { Contract } = await loadUnit(unit);
  new Contract(stepWitnessFunctions({}, record)).initialState(runtime.createConstructorContext(undefined, "0".repeat(64)));
  return [...record.requested].filter(name => name !== "then");
}

describe("T-C05 every witness an exported conduct circuit requests has a mutation table entry", () => {
  it("covers every compiled class of the openings and steps units", () => {
    const classes = [...Object.keys(CLASSES.openings.events), ...Object.keys(CLASSES.openings.mandates), ...Object.keys(STEP_CLASSES)];
    expect(all.map(c => c.circuit).sort()).toEqual(classes.sort());
  });

  it.each(UNITS)("%s: the witnesses the contract requests are exactly those the classes' mutation tables move", async unit => {
    const tables = all.filter(c => c.unit === unit).flatMap(c => c.table);
    expect(new Set(tables).size).toBe(tables.length);
    expect((await requested(unit)).sort()).toEqual([...tables].sort());
  });

  it.each(all.map(c => [c.circuit, c] as const))("%s: an honest run reads exactly the witnesses of its mutation table, each once", async (_circuit, c) => {
    const record: WitnessRecord = { requested: new Set(), read: [] };
    await runLedger(c.unit, c.circuit, stepWitnessFunctions(c.witnesses, record), [c.statement]);
    expect([...record.read].sort()).toEqual([...c.table].sort());
    expect(Object.keys(c.witnesses).sort()).toEqual([...c.table].sort());
  });

  // A second read of a witness would be a private input of its own. A step's ZKIR takes one private input per segment
  // byte and per fixed-width byte (two digests' hex, the id, the ISO time and the event hash's hex), per CBOR argument
  // byte and commitment byte, 11 for the atoms (five uints, the mode and three digests of two field elements each), 3
  // for the window and 4 per path level (two flags and a sibling of two field elements).
  it.each(Object.entries(STEP_CLASSES))("%s: its ZKIR takes exactly the private inputs of its class's witnesses", (circuit, { lengths, cbor, depth }) => {
    const sum = (values: readonly number[]) => values.reduce((total, n) => total + n, 0);
    const expected = sum(Object.values(lengths)) + 64 + 64 + 36 + 24 + 64 + sum(Object.values(cbor)) + 32 + 11 + 3 + 4 * (depth ?? 0);
    expect(privateInputs(STEPS_UNIT, circuit)).toBe(expected);
  });
});
