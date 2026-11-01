import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatedSource, prepareCheck, stripAsserts, zkCheck } from "./harness.js";
import { fieldVariants, honestEvents, latin1, ledgerCell, OPENINGS_UNIT, openingOf, rederived, spliced, withByte, withWitness, witnessFunctions, type Opening } from "./openings.js";

const events = await honestEvents();
const openings = new Map([...events].map(([id, e]) => [id, openingOf(e)] as const));
const party = (o: Opening): readonly [string, string] => (o.kind.startsWith("payment-") ? ["counterparty", "counterpartyLeaf"] : ["destination", "destinationLeaf"]);

const check = (o: Opening) => zkCheck(OPENINGS_UNIT, o.circuit, witnessFunctions(o.witnesses), [o.statement]);
const refusal = (o: Opening) => check(o).then(() => "forged opening accepted", (error: Error) => error.message);
const REFUSED = /Failed direct assertion/;
const sha256 = (...parts: Uint8Array[]) => new Uint8Array(createHash("sha256").update(Buffer.concat(parts)).digest());

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
  ["a forged eventHex rolled into the statement", o => {
    const name = `${o.circuit}_eventHex`;
    const hex = o.witnesses[name]!;
    const at = hex.findIndex(c => c >= 0x30 && c <= 0x38);
    const forged = withByte(hex, at, hex[at]! + 1);
    return { ...withWitness(o, name, forged), statement: { ...o.statement, rollAfter: sha256(latin1("poi-trace:roll:v1|"), o.statement.prevRollHex as Uint8Array, latin1("|"), forged) } };
  }],
];

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

  it.each([...openings].flatMap(([id, o]) => FORGERIES.map(([label, forge]) => [`${id}: ${label}`, o, forge] as const)))("%s", async (_name, o, forge) => {
    const forged = forge(o);
    await expect(prepareCheck(OPENINGS_UNIT, forged.circuit, witnessFunctions(forged.witnesses), [forged.statement])).resolves.toBeDefined();
    expect(await refusal(forged)).toMatch(REFUSED);
  });
});
