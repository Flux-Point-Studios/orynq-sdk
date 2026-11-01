import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cborDecode } from "@fluxpointstudios/orynq-sdk-conduct";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CLASSES } from "../../scripts/conduct/template.mjs";
import { loadUnit } from "./harness.js";
import { OPENINGS_UNIT } from "./openings.js";

const { pureCircuits } = await loadUnit(OPENINGS_UNIT);
const WIDTHS = [0, 1, 2, 4, 8] as const;
const HEADS: Readonly<Record<number, number>> = { 1: 0x18, 2: 0x19, 4: 0x1a, 8: 0x1b };
const VECTORS = [0n, 23n, 24n, 255n, 256n, 65535n, 65536n, (1n << 32n) - 1n, 1n << 32n, (1n << 64n) - 1n];

const bigEndian = (value: bigint, width: number) => Array.from({ length: width }, (_, i) => Number((value >> BigInt(8 * (width - 1 - i))) & 0xffn));

// A uint field of width 0 is its head byte; otherwise the head names the width and the body follows.
function gadget(width: number, body: readonly number[]): number | { throws: string } | bigint {
  const run = width === 0 ? () => pureCircuits.cbor_uint_w0!(BigInt(body[0]!)) : () => pureCircuits[`cbor_uint_w${width}`]!(body.map(BigInt));
  try {
    return run();
  } catch (error) {
    return { throws: (error as Error).message };
  }
}

// The strict decoder's reading of the same bytes as a uint: its value, or undefined where it refuses or reads another type.
function decoded(width: number, body: readonly number[]): bigint | undefined {
  try {
    const value = cborDecode(Uint8Array.from(width === 0 ? body : [HEADS[width]!, ...body]));
    return typeof value === "bigint" ? value : undefined;
  } catch {
    return undefined;
  }
}

function disagreements(width: number, bodies: Iterable<readonly number[]>): string[] {
  const out: string[] = [];
  for (const body of bodies) {
    const [circuit, decoder] = [gadget(width, body), decoded(width, body)];
    if (decoder === undefined ? typeof circuit !== "object" : circuit !== decoder) out.push(`w${width} [${body.join(" ")}]: circuit ${JSON.stringify(circuit, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}, decoder ${String(decoder)}`);
  }
  return out;
}

function* allBodies(width: number): Generator<number[]> {
  for (let n = 0; n < 2 ** (8 * Math.max(width, 1)); n++) yield bigEndian(BigInt(n), Math.max(width, 1));
}

describe("T-B16 the cborUint gadget reads exactly what the strict decoder reads (U13)", () => {
  it.each(VECTORS)("%s decodes in its own width and nowhere wider", value => {
    const fits = WIDTHS.filter(w => (w === 0 ? value <= 255n : value < 1n << BigInt(8 * w)));
    const accepted = fits.filter(w => typeof gadget(w, w === 0 ? [Number(value)] : bigEndian(value, w)) === "bigint");
    expect(accepted).toEqual([fits.find(w => (w === 0 ? value <= 23n : w === 1 ? value >= 24n : value >= 1n << BigInt(4 * w)))]);
    for (const w of fits) expect(disagreements(w, [w === 0 ? [Number(value)] : bigEndian(value, w)])).toEqual([]);
  });

  it.each([0, 1, 2])("agrees with the decoder on every %i-byte argument", width => {
    expect(disagreements(width, allBodies(width))).toEqual([]);
  });

  it.each([4, 8])("agrees with the decoder at every minimality edge and on random %i-byte arguments", width => {
    const edges = [0n, 1n, 23n, 24n, 255n, 256n, 65535n, 65536n, (1n << 32n) - 1n, 1n << 32n, (1n << BigInt(8 * width)) - 1n]
      .filter(v => v < 1n << BigInt(8 * width)).flatMap(v => [v, v + 1n, v - 1n]).filter(v => v >= 0n && v < 1n << BigInt(8 * width));
    expect(disagreements(width, edges.map(v => bigEndian(v, width)))).toEqual([]);
    fc.assert(fc.property(fc.uint8Array({ minLength: width, maxLength: width }), body => {
      expect(disagreements(width, [[...body]])).toEqual([]);
    }), { seed: 20261101, numRuns: 2000 });
  });

  it("every uint field of every mandate opening circuit decodes through the gadget at its class width", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../../circuits/conduct/openings.generated.compact"), "utf8");
    const misread: string[] = [];
    for (const [id, dimensions] of Object.entries(CLASSES.openings.mandates as Record<string, Record<string, number>>)) {
      const start = source.indexOf(`export circuit ${id}(`);
      const body = source.slice(start, source.indexOf("\n}\n", start));
      for (const field of ["capAmount", "windowSeconds", "notBefore", "notAfter", "threshold", "committeeSize"]) {
        const expected = dimensions[field] === 0 ? `cborHeadValue(${field}[0])` : `cborUint<${dimensions[field]}>(${field})`;
        const read = new RegExp(`const ${field}Value = (.+);`).exec(body)?.[1];
        if (start < 0 || read !== expected) misread.push(`${id}.${field}: ${String(read)}`);
      }
    }
    expect(misread).toEqual([]);
  });
});
