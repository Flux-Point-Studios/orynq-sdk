import { describe, expect, it } from "vitest";
import { CAST_FAILED, generatedSource, stripChecks } from "./harness.js";
import {
  checkOpening as check, fieldVariants, hexLinkForgeries, honestEvents, ledgerCell, lexicalForgeries, malformedStrings, OPENINGS_UNIT, openingOf, rederived, settle,
  spliced, withByte, type Forgery, type LexicalForgery, type Opening,
} from "./openings.js";

const events = await honestEvents();
const openings = new Map([...events].map(([id, e]) => [id, openingOf(e)] as const));
const party = (o: Opening): readonly [string, string] => (o.kind.startsWith("payment-") ? ["counterparty", "counterpartyLeaf"] : ["destination", "destinationLeaf"]);

const REFUSED = /Failed direct assertion/;
const CHECK_REFUSED = "'check' returned an error: Error: Failed direct assertion";
// The bytes of a value as `check` names a field element: least significant first.
const littleEndianHex = (value: bigint) => Buffer.from(value.toString(16).padStart(Math.ceil(value.toString(16).length / 2) * 2, "0"), "hex").reverse().toString("hex");

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
  it("the stripped copy runs none of the generated asserts and none of the decimals' narrowing casts", () => {
    const generated = generatedSource(OPENINGS_UNIT);
    const { source, asserts, casts } = stripChecks(generated);
    expect(asserts).toBeGreaterThan(0);
    expect(casts).toBe(generated.split(CAST_FAILED).length - 1);
    expect(casts).toBeGreaterThan(0);
    expect(source).not.toContain("__compactRuntime.assert(");
    expect(source).not.toContain(CAST_FAILED);
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

  // Each lexical forgery in the first class in classes.json that holds it with its value in, or out of, its field's type.
  const firstHeld = (outOfType: boolean) => {
    const held = new Map<string, LexicalForgery>();
    for (const o of openings.values()) {
      for (const f of lexicalForgeries(o).forgeries) if ((f.outOfType === true) === outOfType && !held.has(f.label)) held.set(f.label, f);
    }
    return [...held.values()];
  };

  it("every lexical forgery of a decimal, hex, uuid, ISO or visibility segment whose value stays in its field's type", async () => {
    const inType = firstHeld(false);
    expect(inType).toHaveLength(40);
    expect(await constraintsAccepting(inType), "forged opening accepted").toEqual([]);
  });

  // The statement keeps the field's honest value, and the stripped copy has no narrowing cast to throw first, so the
  // transcript carries the forged bytes. An all-digit decimal of 2^64 is refused by the Uint<64> cast's bit bound,
  // which fires first; a digit edge or an uppercase hex letter is refused by its lexical assert before the fold reaches the cast.
  it("every lexical forgery whose value leaves its field's type, with each all-digit decimal refused by the cast's bit bound", async () => {
    const outcomes: Record<string, string> = {};
    const expected: Record<string, string> = {};
    const forgeries = firstHeld(true);
    for (const { label, opening } of forgeries) {
      const digits = Buffer.from(opening.segments[label.slice(0, label.indexOf(" "))]!).toString("latin1");
      outcomes[label] = await settle(check(opening));
      expected[label] = /^\d+$/.test(digits) ? `'check' returned an error: Error: Bit bound failed: ${littleEndianHex(BigInt(digits))} is not 64-bit` : CHECK_REFUSED;
    }
    for (const circuit of new Set(forgeries.map(f => f.opening.circuit))) {
      const honest = openings.get(circuit)!;
      expect((await check(honest))[ledgerCell(circuit)]).toEqual(honest.statement);
    }
    expect(Object.keys(outcomes)).toEqual([
      "amount with / as its last digit", "ts with / as its last digit", "enforcedAt with / as its last digit", "dataSeq with / as its last digit",
      "traceSeq with / as its last digit", "amount with : as its last digit", "amount of the 20 digits of 2^64", "actionDigest with an uppercase hex letter",
      "ts with : as its last digit", "ts of the 20 digits of 2^64", "enforcedAt with : as its last digit", "enforcedAt of the 20 digits of 2^64",
      "dataSeq of the 20 digits of 2^64",
    ]);
    expect(outcomes, "forged opening accepted").toEqual(expected);
  });

  it("malformed UTF-8 and every JSON-escaped byte in a counterparty", async () => {
    expect(await constraintsAccepting(malformedStrings(openings.get("ev_pa_ascii_min")!, "counterparty")), "forged opening accepted").toEqual([]);
  });
});
