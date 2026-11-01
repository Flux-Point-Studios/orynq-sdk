import { decodeMandate, encodeMandate, hexToBytes, mandateCommitment, mandateCommitmentHex } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { classifyMandate, CLASSES, mandateOpening, mandateSegments } from "../../scripts/conduct/template.mjs";
import { MANDATE_VECTORS, mandateOpeningOf, maxMandate, runMandateOpening, stepMandate, type MandateOpening } from "./mandates.js";
import { mandateAtoms } from "./statement-checker.js";

const VECTOR_CLASSES: Readonly<Record<string, string>> = {
  "base allowlist-egress mandate": "m_base",
  "deny-all egress with zero root": "m_base",
  "zero spend cap (deny all spending)": "m_zero_cap",
  "field maxima + unicode committee id + cardano unit asset": "m_field_maxima",
  "one-second validity window, unanimous 2-of-2": "m_one_second",
};
const HONEST_MANDATES: readonly (readonly [string, Uint8Array, string])[] = [
  ...MANDATE_VECTORS.valid.map(v => [v.name, hexToBytes(v.cborHex), VECTOR_CLASSES[v.name]!] as const),
  ["the largest mandate", encodeMandate(maxMandate()), "m_max"],
  ["the step mandate", encodeMandate(stepMandate()), "m_step"],
];

describe("T-B12 every mandate class opens the codec's own encoding", () => {
  it("the largest mandate is 998 bytes of CBOR, a 1,023-byte commitment preimage of 17 SHA-256 blocks", () => {
    const cbor = encodeMandate(maxMandate());
    expect(cbor.length).toBe(998);
    const preimage = cbor.length + "orynq:conduct:mandate:v1|".length;
    expect(preimage).toBe(1023);
    expect(Math.ceil((preimage + 9) / 64)).toBe(17);
  });

  it("names a class for every valid vector", () => {
    expect(MANDATE_VECTORS.valid.map(v => VECTOR_CLASSES[v.name])).not.toContain(undefined);
  });

  it.each(HONEST_MANDATES)("%s opens in its class with C, K and the atoms of the codec", async (_name, cbor, id) => {
    const m = decodeMandate(cbor);
    const opening = mandateOpeningOf(cbor);
    expect(opening.circuit).toBe(id);
    expect(await runMandateOpening(opening)).toEqual({ commitment: mandateCommitment(cbor), atoms: mandateAtoms(m) });
    expect(opening.atoms).toEqual({
      notBefore: m.validityWindow.notBefore, notAfter: m.validityWindow.notAfter, asset: new TextEncoder().encode(m.spendCap.asset),
      cap: m.spendCap.amount, window: m.spendCap.windowSeconds, egressMode: m.egressPolicy.mode,
      counterpartyRoot: m.counterpartyAllowlistRoot, egressRoot: m.egressPolicy.allowlistRoot,
    });
  });

  it.each(MANDATE_VECTORS.valid)("$name: the vector's own commitment", v => {
    expect(mandateCommitmentHex(hexToBytes(v.cborHex))).toBe(v.commitmentHex);
  });
});

const outcome = (opening: Pick<MandateOpening, "circuit" | "witnesses" | "statement">) =>
  runMandateOpening(opening).then(() => "accepted", (error: Error) => error.message);
const withByte = (bytes: Uint8Array, at: number, value: number) => Uint8Array.from(bytes, (b, i) => (i === at ? value : b));
const MANDATE_CLASSES = Object.keys(CLASSES.openings.mandates);

// Every compiled class whose layout the bytes fit, with the witnesses that present them there.
function presentations(cbor: Uint8Array): { circuit: string; witnesses: Record<string, Uint8Array> }[] {
  let parsed: { lengths: Record<string, number>; segments: Record<string, Uint8Array> };
  try {
    parsed = mandateSegments(cbor);
  } catch {
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
// The invalid vectors whose bytes still fit a compiled layout: only the circuit's own schema rules can refuse them.
const SCHEMA_ONLY = [
  "validity window empty (notAfter == notBefore)", "disclosure threshold 0", "threshold exceeds committee size (6-of-5)", "deny-all egress with nonzero allowlist root",
];

describe("T-B14 no compiled class opens an invalid mandate vector", () => {
  it.each(MANDATE_VECTORS.invalid)("$name: the classifier reports $code, and no class it fits opens it", async v => {
    const cbor = hexToBytes(v.cborHex);
    expect(codeOf(() => classifyMandate(cbor, decodeMandate))).toBe(v.code);
    const fits = presentations(cbor);
    expect(fits.length > 0).toBe(SCHEMA_ONLY.includes(v.name));
    for (const { circuit, witnesses } of fits) {
      const { statement } = mandateOpening(circuit, mandateSegments(cbor).segments);
      expect(await outcome({ circuit, witnesses, statement }), "invalid mandate opened").not.toBe("accepted");
    }
  });
});
