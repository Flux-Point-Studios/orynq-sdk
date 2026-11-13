import { isDeepStrictEqual } from "node:util";
import { decodeMandate, encodeMandate, hexToBytes, mandateCommitment, mandateCommitmentHex } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { CLASSES, mandateClass, mandateOpening, mandateSegments } from "../../scripts/conduct/template.mjs";
import { classifiedMandate, HONEST_MANDATES, MANDATE_VECTORS, mandateOpeningOf, maxMandate, sibling } from "./mandates.js";
import { openingOutcome as outcome, runOpening, withByte } from "./openings.js";
import { mandateAtoms } from "./statement-checker.js";

describe("T-B12 every mandate class opens the codec's own encoding", () => {
  it("the largest mandate is 998 bytes of CBOR, a 1,023-byte commitment preimage of 17 SHA-256 blocks", () => {
    const cbor = encodeMandate(maxMandate());
    expect(cbor.length).toBe(998);
    const preimage = cbor.length + "orynq:conduct:mandate:v1|".length;
    expect(preimage).toBe(1023);
    expect(Math.ceil((preimage + 9) / 64)).toBe(17);
  });

  it("names a class for every honest mandate, and an honest mandate for every class", () => {
    expect(HONEST_MANDATES.map(([, , id]) => id)).not.toContain(undefined);
    expect(new Set(HONEST_MANDATES.map(([, , id]) => id))).toEqual(new Set(Object.keys(CLASSES.openings.mandates)));
  });

  it.each(HONEST_MANDATES)("%s opens in its class with C, K and the atoms of the codec", async (_name, cbor, id) => {
    const m = decodeMandate(cbor);
    const opening = mandateOpeningOf(cbor);
    expect(opening.circuit).toBe(id);
    expect(await runOpening(opening)).toEqual({ commitment: mandateCommitment(cbor), atoms: mandateAtoms(m) });
    expect(opening.atoms).toEqual({
      notBefore: m.validityWindow.notBefore, notAfter: m.validityWindow.notAfter, asset: new TextEncoder().encode(m.spendCap.asset),
      cap: m.spendCap.amount, window: m.spendCap.windowSeconds, egressMode: m.egressPolicy.mode,
      counterpartyRoot: m.counterpartyAllowlistRoot, egressRoot: m.egressPolicy.allowlistRoot,
    });
  });

  // K hashes every atom of the mandate, so a K that read any atom from elsewhere differs from the codec's here.
  it.each(HONEST_MANDATES)("%s: a mandate of its class with the other egress mode and every other atom of K changed opens with C and K of the codec", async (_name, cbor, id) => {
    const other = sibling(cbor);
    const [opening, original] = [mandateOpeningOf(other), mandateOpeningOf(cbor)];
    expect(opening.circuit).toBe(id);
    expect(Object.keys(original.atoms).filter(atom => isDeepStrictEqual(opening.atoms[atom], original.atoms[atom]))).toEqual([]);
    expect(await runOpening(opening)).toEqual({ commitment: mandateCommitment(other), atoms: mandateAtoms(decodeMandate(other)) });
  });

  it.each(MANDATE_VECTORS.valid)("$name: the vector's own commitment", v => {
    expect(mandateCommitmentHex(hexToBytes(v.cborHex))).toBe(v.commitmentHex);
  });
});

const MANDATE_CLASSES = Object.keys(CLASSES.openings.mandates);

// Every compiled class whose layout the bytes fit, with the witnesses that present them there.
function presentations(cbor: Uint8Array): { circuit: string; witnesses: Record<string, Uint8Array> }[] {
  let parsed: { lengths: Record<string, number>; segments: Record<string, Uint8Array> };
  try {
    parsed = mandateSegments(cbor);
  } catch (error) {
    if (!(error as Error).message.startsWith("MANDATE_LAYOUT:")) throw error;
    return [];
  }
  return MANDATE_CLASSES.filter(id => JSON.stringify(CLASSES.openings.mandates[id]) === JSON.stringify(parsed.lengths))
    .map(circuit => ({ circuit, witnesses: mandateOpening(circuit, parsed.segments).witnesses }));
}

describe("T-B13 no compiled class opens a mandate byte, C or K moved by one", () => {
  it.each(HONEST_MANDATES)("%s: every CBOR byte moved by one, under every class it fits", async (_name, cbor) => {
    const { statement } = mandateOpeningOf(cbor);
    let tried = 0;
    let presented = 0;
    const accepted: string[] = [];
    for (let at = 0; at < cbor.length; at++) {
      for (const delta of [1, -1]) {
        const value = cbor[at]! + delta;
        if (value < 0 || value > 255) continue;
        tried += 1;
        for (const { circuit, witnesses } of presentations(withByte(cbor, at, value))) {
          presented += 1;
          if (await outcome({ circuit, witnesses, statement }) === "accepted") accepted.push(`${circuit}: byte ${at} ${delta > 0 ? "+1" : "-1"}`);
        }
      }
    }
    expect(accepted, "mutation accepted").toEqual([]);
    expect(tried).toBe([...cbor].reduce((sum, b) => sum + (b > 0 ? 1 : 0) + (b < 255 ? 1 : 0), 0));
    expect(presented).toBeGreaterThan(0);
  });

  it.each(HONEST_MANDATES)("%s: every byte of C and K moved by one", async (_name, cbor) => {
    const opening = mandateOpeningOf(cbor);
    const accepted: string[] = [];
    for (const field of ["commitment", "atoms"] as const) {
      const bytes = opening.statement[field];
      for (let at = 0; at < 32; at++) {
        for (const value of [bytes[at]! + 1, bytes[at]! - 1].filter(v => v >= 0 && v <= 255)) {
          if (await outcome({ ...opening, statement: { ...opening.statement, [field]: withByte(bytes, at, value) } }) === "accepted") accepted.push(`${field}[${at}]`);
        }
      }
    }
    expect(accepted, "mutation accepted").toEqual([]);
  });

  it("the bytes of one mandate under another's C or K, both in one class", async () => {
    const [a, b] = ["base allowlist-egress mandate", "deny-all egress with zero root"].map(name => mandateOpeningOf(HONEST_MANDATES.find(([n]) => n === name)![1]));
    expect([a!.circuit, b!.circuit]).toEqual(["m_base", "m_base"]);
    for (const statement of [{ ...a!.statement, atoms: b!.statement.atoms }, { ...a!.statement, commitment: b!.statement.commitment }, b!.statement]) {
      expect(await outcome({ ...a!, statement }), "mutation accepted").not.toBe("accepted");
    }
  });
});

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "accepted";
};
// The compiled class the layout reader and mandateClass place a mandate in, or the code they refuse it with.
function layoutClass(cbor: Uint8Array): string {
  try {
    return mandateClass(mandateSegments(cbor));
  } catch (error) {
    return (error as Error).message.slice(0, (error as Error).message.indexOf(":"));
  }
}
// The invalid vectors whose bytes still fit a compiled layout, each with the schema rule of the circuit that refuses it.
const SCHEMA_ONLY: Readonly<Record<string, string>> = {
  "validity window empty (notAfter == notBefore)": "failed assert: mandate validity window",
  "disclosure threshold 0": "failed assert: mandate disclosure threshold",
  "threshold exceeds committee size (6-of-5)": "failed assert: mandate disclosure threshold",
  "deny-all egress with nonzero allowlist root": "failed assert: deny-all egress root",
};

describe("T-B14 no compiled class opens an invalid mandate vector", () => {
  it.each(MANDATE_VECTORS.invalid)("$name: decodeMandate refuses it with $code, and the circuit of every class it fits refuses it by the rule it breaks", async v => {
    const cbor = hexToBytes(v.cborHex);
    expect(codeOf(() => classifiedMandate(cbor))).toBe(v.code);
    expect(layoutClass(cbor)).toBe(Object.hasOwn(SCHEMA_ONLY, v.name) ? "m_base" : "MANDATE_LAYOUT");
    const fits = presentations(cbor);
    expect(fits.map(({ circuit }) => circuit)).toEqual(Object.hasOwn(SCHEMA_ONLY, v.name) ? ["m_base"] : []);
    for (const { circuit, witnesses } of fits) {
      const { statement } = mandateOpening(circuit, mandateSegments(cbor).segments);
      expect(await outcome({ circuit, witnesses, statement }), "invalid mandate opened").toBe(SCHEMA_ONLY[v.name]);
    }
  });
});
