import { canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classify, expandKinds, render, TEMPLATE } from "../../scripts/conduct/template.mjs";

interface Segment { readonly c?: string; readonly v?: string; readonly lex?: string; readonly max?: number; readonly nonzero?: boolean }

const kinds: Record<string, Segment[]> = expandKinds();
const DOMAIN: string = TEMPLATE.domain;

// Escape-free scalars: printable ASCII but the quote and backslash, DEL, U+2028, the BOM, and 2-, 3- and 4-byte UTF-8.
const scalar = fc.oneof(
  fc.integer({ min: 0x20, max: 0x7e }).filter(c => c !== 0x22 && c !== 0x5c).map(c => String.fromCodePoint(c)),
  fc.constantFrom("\u007f", " ", "﻿", "é", "€", "商", "🚀"),
  fc.integer({ min: 0x80, max: 0x10ffff }).filter(c => c < 0xd800 || c > 0xdfff).map(c => String.fromCodePoint(c)),
);
const text = (max: number) => fc.tuple(fc.boolean(), fc.array(scalar, { minLength: 1, maxLength: max }))
  .map(([bom, chars]) => (bom ? "﻿" : "") + chars.join(""))
  .filter(s => Buffer.byteLength(s, "utf8") <= max);
const decimal = (nonzero: boolean) => fc.bigInt({ min: nonzero ? 1n : 0n, max: (1n << 64n) - 1n }).map(String);
const hex = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(b => Buffer.from(b).toString("hex"));

const VALUE: Readonly<Record<string, (s: Segment) => fc.Arbitrary<string>>> = {
  dec64: s => decimal(s.nonzero === true),
  dec53: () => fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }).map(String),
  str: s => text(s.max!),
  hex64: () => hex,
  uuid: () => fc.uuid().map(u => u.toLowerCase()),
  iso24: () => fc.date({ min: new Date("0000-01-01T00:00:00.000Z"), max: new Date("9999-12-31T23:59:59.999Z"), noInvalidDate: true }).map(d => d.toISOString()),
  vis: () => fc.constantFrom("public", "private", "secret"),
};

const witness = fc.constantFrom(...Object.keys(kinds)).chain(kind => {
  const values = Object.fromEntries(kinds[kind]!.filter(s => s.v !== undefined).map(s => [s.v!, VALUE[s.lex!]!(s)]));
  return fc.record(values).map(v => ({ kind, values: v as Record<string, string> }));
});

describe("T-B05 every in-class preimage is canonical JSON whose fields are the classified atoms", () => {
  it("holds for 500 generated witnesses", () => {
    fc.assert(fc.property(witness, ({ kind, values }) => {
      const preimage = render({ kind, values });
      expect(preimage.startsWith(DOMAIN)).toBe(true);
      const json = preimage.slice(DOMAIN.length);
      const parsed = JSON.parse(json);
      expect(canonicalize(parsed)).toBe(json);
      const classified = classify(parsed);
      expect(classified.kind).toBe(kind);
      expect(classified.values).toEqual(values);
    }), { seed: 20261101, numRuns: 500 });
  });
});
