import { describe, expect, it } from "vitest";
import { generatedSource, prepareCheck, stripAsserts, zkCheck } from "./harness.js";
import {
  fieldVariants, hexLinkForgeries, honestEvents, LEXICAL_FORGERIES, ledgerCell, malformedStrings, OPENINGS_UNIT, openingOf, rederived, spliced, withByte,
  witnessFunctions, type Forgery, type Opening,
} from "./openings.js";

const events = await honestEvents();
const openings = new Map([...events].map(([id, e]) => [id, openingOf(e)] as const));
const party = (o: Opening): readonly [string, string] => (o.kind.startsWith("payment-") ? ["counterparty", "counterpartyLeaf"] : ["destination", "destinationLeaf"]);

const check = (o: Opening) => zkCheck(OPENINGS_UNIT, o.circuit, witnessFunctions(o.witnesses), [o.statement]);
const refusal = (o: Opening) => check(o).then(() => "forged opening accepted", (error: Error) => error.message);
const REFUSED = /Failed direct assertion/;

// Each forgery would pass the stripped JS, which runs no assert, so only the compiled constraints can refuse it.
const FORGERIES: readonly (readonly [string, (o: Opening) => Opening])[] = [
  ["a forged amount or time", o => {
    const field = o.kind.startsWith("payment-") ? "amount" : "timestamp";
    return { ...o, statement: { ...o.statement, [field]: (o.statement[field] as bigint) ^ 1n } };
  }],
  ["a forged counterparty or destination byte under the true leaf", o => {
    const [name, leaf] = party(o);
    return rederived(o, name, withByte(o.segments[name]!, 0, o.segments[name]![0]! + 1), { [leaf]: o.statement[leaf]! });
  }],
  ["a quote in the asset or destination", o => {
    const name = o.kind.startsWith("payment-") ? "asset" : "destination";
    return rederived(o, name, spliced(o.segments[name]!, [0x22]));
  }],
  ["the last eventHex digit forged and rolled into the statement", o => hexLinkForgeries(o).findLast(f => f.refusal === "failed assert: hex opening")!.opening],
];

// The label and outcome of each forgery the compiled constraints take. The stripped JS runs no assert, so it must take
// every forgery and leave the refusal to the constraints.
const constraintsAccepting = async (forgeries: readonly Pick<Forgery, "label" | "opening">[]) => {
  const out: string[] = [];
  for (const { label, opening } of forgeries) {
    const prepared = await prepareCheck(OPENINGS_UNIT, opening.circuit, witnessFunctions(opening.witnesses), [opening.statement]);
    const result = await prepared.check().then(() => "accepted", (error: Error) => error.message);
    if (!REFUSED.test(result)) out.push(`${label}: ${result}`);
  }
  return out;
};

describe("T-B11 the compiled opening constraints refuse forgeries the stripped JS accepts", () => {
  it("the stripped copies have asserts to remove", () => {
    expect(stripAsserts(generatedSource(OPENINGS_UNIT)).removed).toBeGreaterThan(0);
  });

  it.each([...openings])("%s: the honest opening checks and discloses its statement", async (_id, o) => {
    expect((await check(o))[ledgerCell(o.kind)]).toEqual(o.statement);
  });

  it.each([...openings])("%s: every statement field moved by one", async (_id, o) => {
    const accepted: string[] = [];
    for (const [field, value] of Object.entries(o.statement)) {
      for (const variant of fieldVariants(field, value)) {
        if (!REFUSED.test(await refusal({ ...o, statement: { ...o.statement, [field]: variant } }))) accepted.push(`${field} = ${String(variant)}`);
      }
    }
    expect(accepted, "forged opening accepted").toEqual([]);
  });

  it.each([...openings].flatMap(([id, o]) => FORGERIES.map(([label, forge]) => [`${id}: ${label}`, o, forge] as const)))("%s", async (label, o, forge) => {
    expect(await constraintsAccepting([{ label, opening: forge(o) }])).toEqual([]);
  });

  it.each(["ev_pa_ascii_min", "ev_ea_ascii_min"])("%s: every eventHex byte forged with rollAfter re-derived", async id => {
    expect(await constraintsAccepting(hexLinkForgeries(openings.get(id)!)), "forged opening accepted").toEqual([]);
  });

  it("every lexical forgery of a decimal, hex, uuid, ISO or visibility segment that no cast refuses", async () => {
    const forgeries = LEXICAL_FORGERIES.filter(f => f.castRefused === undefined).map(f => f.forge(openings.get(f.circuit)!));
    expect(forgeries.length).toBe(LEXICAL_FORGERIES.length - 1);
    expect(await constraintsAccepting(forgeries), "forged opening accepted").toEqual([]);
  });

  it("malformed UTF-8 and every JSON-escaped byte in a counterparty", async () => {
    expect(await constraintsAccepting(malformedStrings(openings.get("ev_pa_ascii_min")!, "counterparty")), "forged opening accepted").toEqual([]);
  });
});
