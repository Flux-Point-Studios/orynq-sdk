import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cborDecode, MandateError } from "@fluxpointstudios/orynq-sdk-conduct";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CLASSES } from "../../scripts/conduct/template.mjs";
import { loadUnit } from "./harness.js";
import { describeDisagreement, disagreements, judge, type GadgetClass, type Judgement } from "./lexical.js";
import { bigEndianBytes } from "./mandates.js";
import { MANDATE_UINT_FIELDS, OPENINGS_UNIT } from "./openings.js";

const { pureCircuits } = await loadUnit(OPENINGS_UNIT);
const WIDTHS = [0, 1, 2, 4, 8] as const;
const HEADS: Readonly<Record<number, number>> = { 1: 0x18, 2: 0x19, 4: 0x1a, 8: 0x1b };
const VECTORS = [0n, 23n, 24n, 255n, 256n, 65535n, 65536n, (1n << 32n) - 1n, 1n << 32n, (1n << 64n) - 1n];

// The strict decoder's reading of the same bytes as a uint: its value, or the refusal the gadget must raise where the
// decoder refuses them or reads another type.
function decoded(width: number, body: readonly number[]): Judgement {
  try {
    const value = cborDecode(Uint8Array.from(width === 0 ? body : [HEADS[width]!, ...body]));
    if (typeof value === "bigint") return { value };
  } catch (error) {
    if (!(error instanceof MandateError)) throw error;
  }
  return { refused: width === 0 ? "cbor head" : "cbor uint not minimal" };
}

// The uint gadget at one width: a field of width 0 is its head byte; otherwise the head names the width and the body follows.
const cborUint = (width: number, inputs: () => Iterable<number[]>): GadgetClass => ({
  probe: `cbor_uint_w${width}`, inputs, expected: body => decoded(width, body), ...(width === 0 ? { args: (body: readonly number[]) => [BigInt(body[0]!)] } : {}),
});
const body = (width: number, value: bigint) => [...bigEndianBytes(value, Math.max(width, 1))];

function* allBodies(width: number): Generator<number[]> {
  for (let n = 0; n < 2 ** (8 * Math.max(width, 1)); n++) yield body(width, BigInt(n));
}

describe("T-B16 the cborUint gadget agrees with the strict decoder (U13)", () => {
  it.each(VECTORS)("%s decodes in its own width and nowhere wider", value => {
    const fits = WIDTHS.filter(w => (w === 0 ? value <= 255n : value < 1n << BigInt(8 * w)));
    const judged = fits.map(w => [w, judge(pureCircuits, cborUint(w, () => []), body(w, value))] as const);
    expect(judged.filter(([, j]) => "value" in j).map(([w]) => w)).toEqual([fits.find(w => (w === 0 ? value <= 23n : w === 1 ? value >= 24n : value >= 1n << BigInt(4 * w)))]);
    for (const [w, j] of judged) expect(j, `width ${w}`).toEqual(decoded(w, body(w, value)));
  });

  it.each([0, 1, 2])("agrees with the decoder on every %i-byte argument", width => {
    const c = cborUint(width, () => allBodies(width));
    expect(disagreements(pureCircuits, c, 20).map(d => describeDisagreement(c, d))).toEqual([]);
  });

  it.each([4, 8])("agrees with the decoder at every minimality edge and on random %i-byte arguments", width => {
    const limit = 1n << BigInt(8 * width);
    const edges = [0n, 1n, 23n, 24n, 255n, 256n, 65535n, 65536n, (1n << 32n) - 1n, 1n << 32n, limit - 1n]
      .flatMap(v => [v, v + 1n, v - 1n]).filter(v => v >= 0n && v < limit);
    const random = fc.sample(fc.uint8Array({ minLength: width, maxLength: width }), { seed: 20261101, numRuns: 2000 }).map(bytes => [...bytes]);
    const c = cborUint(width, () => [...edges.map(v => body(width, v)), ...random]);
    expect(disagreements(pureCircuits, c, 20).map(d => describeDisagreement(c, d))).toEqual([]);
  });

  it("every uint field of every mandate opening circuit decodes through the gadget at its class width", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../../circuits/conduct/openings.generated.compact"), "utf8");
    const misread: string[] = [];
    for (const [id, dimensions] of Object.entries(CLASSES.openings.mandates as Record<string, Record<string, number>>)) {
      const start = source.indexOf(`export circuit ${id}(`);
      const circuit = source.slice(start, source.indexOf("\n}\n", start));
      for (const field of MANDATE_UINT_FIELDS) {
        const expected = dimensions[field] === 0 ? `cborHeadValue(${field}[0])` : `cborUint<${dimensions[field]}>(${field})`;
        const read = new RegExp(`const ${field}Value = (.+);`).exec(circuit)?.[1];
        if (start < 0 || read !== expected) misread.push(`${id}.${field}: ${String(read)}`);
      }
    }
    expect(misread).toEqual([]);
  });
});
