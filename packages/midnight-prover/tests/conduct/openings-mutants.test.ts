import { describe, expect, it } from "vitest";
import { loadUnit } from "./harness.js";
import { describeDisagreement, disagreements, GADGET_CLASSES, judge } from "./lexical.js";
import { fieldForgeries, HONEST_MANDATES, mandateOpeningOf, mandateOutcome, schemaBreaches } from "./mandates.js";
import {
  hexLinkForgeries, honestEvents, malformedStrings, misjudged, OPENINGS_MUTANTS, OPENINGS_UNIT, openingOf, openingOutcome, privateInputs, witnessWidth,
} from "./openings.js";

const events = await honestEvents();
const event = (id: string) => openingOf(events.get(id)!);
const mandate = (id: string) => mandateOpeningOf(HONEST_MANDATES.find(([, , c]) => c === id)![1]);

// The forgeries an opening test must see refused that `unit` judges otherwise.
const hexLink = (id: string) => (unit: string) => misjudged(hexLinkForgeries(event(id)), o => openingOutcome(o, unit));
const strings = (id: string, name: string) => (unit: string) => misjudged(malformedStrings(event(id), name), o => openingOutcome(o, unit));
const mandateFields = (id: string) => (unit: string) => misjudged(fieldForgeries(mandate(id)), o => mandateOutcome(o, unit));
const mandateSchema = (id: string) => (unit: string) => misjudged(schemaBreaches(mandate(id)).forgeries, o => mandateOutcome(o, unit));

// Mutants that drop or narrow a binding of the opening circuits, each with the opening test that must kill it.
const OPENING_KILLS: Readonly<Record<string, (unit: string) => Promise<string[]>>> = {
  open_no_hash_link: hexLink("ev_pa_ascii_min"),
  hex_link_skips_last_byte: hexLink("ev_ea_ascii_min"),
  pd4_counterparty_unchecked: strings("ev_pd4_ascii_min", "counterparty"),
  unicode_counterparty_unchecked: strings("ev_pa_unicode_max", "counterparty"),
  pa_max_counterparty_unchecked: strings("ev_pa_max", "counterparty"),
  m_max_principal_unchecked: mandateFields("m_max"),
  m_step_deny_all_skips_last_byte: mandateSchema("m_step"),
};
// Mutants of a lexical gadget, each with the probe whose T-B18 class must kill it.
const GADGET_KILLS: Readonly<Record<string, string>> = {
  hex_digit_g: "hex_halves",
  decimal_digit_slash: "dec_u64_w2",
  iso_digit_slash: "iso8601_shape",
  utf8_tail_continuation_low: "json_str_w3",
  utf8_lead4_to_f7: "utf8_any_w4",
  utf8_lead2_to_e0: "utf8_any_w2",
  json_continuation_standalone: "json_str_w1",
  json_truncated_end: "json_str_w1",
};
// Mutants that read a witness a second time for a disclosed value or a hash input, each with its circuit and witness.
const REREAD_KILLS: Readonly<Record<string, readonly [string, string]>> = {
  amount_reread: ["ev_pa_ascii_min", "amount"],
  event_hex_reread: ["ev_pa_ascii_min", "eventHex"],
  cap_reread: ["m_field_maxima", "capAmount"],
};
const honestOutcome = (circuit: string, unit: string) => (circuit.startsWith("ev_") ? openingOutcome(event(circuit), unit) : mandateOutcome(mandate(circuit), unit));

describe("the openings discrimination mutants are killed, with the compiled unit as the control in the same test", () => {
  it("names a kill for exactly the openings mutants in mutants.json", () => {
    expect([...Object.keys(OPENING_KILLS), ...Object.keys(GADGET_KILLS), ...Object.keys(REREAD_KILLS)].sort()).toEqual([...OPENINGS_MUTANTS].sort());
  });

  it.each(Object.entries(REREAD_KILLS))("%s: the mutant's honest opening reads a witness twice, and its ZKIR takes more private inputs than its class has witness bytes", async (id, [circuit, name]) => {
    expect(await honestOutcome(circuit, OPENINGS_UNIT), "control").toBe("accepted");
    expect(privateInputs(OPENINGS_UNIT, circuit), "control").toBe(witnessWidth(circuit));
    expect(await honestOutcome(circuit, `mutants/${id}`), `mutant ${id} survived`).toBe(`witness ${circuit}_${name} read twice`);
    expect(privateInputs(`mutants/${id}`, circuit), `mutant ${id} survived T-B19`).toBeGreaterThan(witnessWidth(circuit));
  });

  it.each(Object.entries(OPENING_KILLS))("%s: the mutant opens a forgery its test refuses", async (id, kill) => {
    expect(await kill(OPENINGS_UNIT), "control").toEqual([]);
    expect((await kill(`mutants/${id}`)).filter(found => found.endsWith(": accepted")), `mutant ${id} survived`).not.toEqual([]);
  });

  it.each(Object.entries(GADGET_KILLS))("%s: the mutant's %s probe disagrees with the reference where the unit's agrees", async (id, probe) => {
    const c = GADGET_CLASSES.find(g => g.probe === probe)!;
    const [found] = disagreements((await loadUnit(`mutants/${id}`)).pureCircuits, c, 1);
    expect(found, `mutant ${id} survived ${probe}`).toBeDefined();
    expect(judge((await loadUnit(OPENINGS_UNIT)).pureCircuits, c, found!.bytes), describeDisagreement(c, found!)).toEqual(c.expected(found!.bytes));
  });
});
