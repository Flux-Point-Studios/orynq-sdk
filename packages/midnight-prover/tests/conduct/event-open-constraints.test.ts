import { describe, expect, it } from "vitest";
import { generatedSource, stripAsserts } from "./harness.js";
import {
  checkOpening as check, fieldVariants, hexLinkForgeries, honestEvents, ledgerCell, lexicalForgeries, malformedStrings, OPENINGS_UNIT, openingOf, rederived, settle,
  spliced, withByte, type Forgery, type Opening,
} from "./openings.js";

const events = await honestEvents();
const openings = new Map([...events].map(([id, e]) => [id, openingOf(e)] as const));
const party = (o: Opening): readonly [string, string] => (o.kind.startsWith("payment-") ? ["counterparty", "counterpartyLeaf"] : ["destination", "destinationLeaf"]);

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
    const result = await settle(check(opening));
    if (!REFUSED.test(result)) out.push(`${label}: ${result}`);
  }
  return out;
};

describe("T-B11 the compiled opening constraints refuse forgeries the stripped JS accepts", () => {
  it("the stripped copies have asserts to remove", () => {
    expect(stripAsserts(generatedSource(OPENINGS_UNIT)).removed).toBeGreaterThan(0);
  });

  it.each([...openings])("%s: the honest opening checks and discloses its statement", async (_id, o) => {
    expect((await check(o))[ledgerCell(o.circuit)]).toEqual(o.statement);
  });

  it.each([...openings])("%s: every statement field moved by one", async (_id, o) => {
    const accepted: string[] = [];
    for (const [field, value] of Object.entries(o.statement)) {
      for (const variant of fieldVariants(field, value)) {
        if (!REFUSED.test(await settle(check({ ...o, statement: { ...o.statement, [field]: variant } })))) accepted.push(`${field} = ${String(variant)}`);
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

  // Each lexical forgery in the first class in classes.json that holds it, unless a cast refuses it.
  it("every lexical forgery of a decimal, hex, uuid, ISO or visibility segment that no cast refuses", async () => {
    const firstHeld = new Map<string, Forgery>();
    for (const o of openings.values()) {
      for (const f of lexicalForgeries(o).forgeries) if (f.castRefused === undefined && !firstHeld.has(f.label)) firstHeld.set(f.label, f);
    }
    expect(firstHeld.size).toBe(40);
    expect(await constraintsAccepting([...firstHeld.values()]), "forged opening accepted").toEqual([]);
  });

  it("malformed UTF-8 and every JSON-escaped byte in a counterparty", async () => {
    expect(await constraintsAccepting(malformedStrings(openings.get("ev_pa_ascii_min")!, "counterparty")), "forged opening accepted").toEqual([]);
  });
});
