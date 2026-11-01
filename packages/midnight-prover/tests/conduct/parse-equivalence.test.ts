import { canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classify, expandKinds, render, TEMPLATE, valueSpecs } from "../../scripts/conduct/template.mjs";
import type { Segment } from "./openings.js";

const KIND_NAMES = Object.keys(expandKinds());
const DOMAIN: string = TEMPLATE.domain;

// Escape-free scalars: printable ASCII but the quote and backslash, DEL, U+2028, the BOM, and 2-, 3- and 4-byte UTF-8.
const scalar = fc.oneof(
  fc.integer({ min: 0x20, max: 0x7e }).filter(c => c !== 0x22 && c !== 0x5c).map(c => String.fromCodePoint(c)),
  fc.constantFrom("\u007f", "\u2028", "\ufeff", "é", "€", "商", "🚀"),
  fc.integer({ min: 0x80, max: 0x10ffff }).filter(c => c < 0xd800 || c > 0xdfff).map(c => String.fromCodePoint(c)),
);
const text = (max: number) => fc.tuple(fc.boolean(), fc.array(scalar, { minLength: 1, maxLength: max }))
  .map(([bom, chars]) => (bom ? "\ufeff" : "") + chars.join(""))
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

const witness = fc.constantFrom(...KIND_NAMES).chain(kind => {
  const values = Object.fromEntries([...valueSpecs(kind)].map(([name, s]) => [name, VALUE[s.lex!]!(s)]));
  return fc.record(values).map(v => ({ kind, values: v as Record<string, string> }));
});

// The scalars the README names as covered, each tested on the string values of a witness.
const COVERED: Readonly<Record<string, (value: string) => boolean>> = {
  "4-byte UTF-8": value => [...value].some(c => c.codePointAt(0)! > 0xffff),
  "U+2028": value => value.includes(" "),
  DEL: value => value.includes("\u007f"),
  "a leading BOM": value => value.startsWith("﻿"),
};

describe("T-B05 every in-class preimage is canonical JSON whose fields are the classified atoms", () => {
  it("holds for 500 generated witnesses, which include every covered scalar", () => {
    const seen = new Set<string>();
    fc.assert(fc.property(witness, ({ kind, values }) => {
      for (const [label, holds] of Object.entries(COVERED)) if (Object.values(values).some(holds)) seen.add(label);
      const preimage = render({ kind, values });
      expect(preimage.startsWith(DOMAIN)).toBe(true);
      const json = preimage.slice(DOMAIN.length);
      const parsed = JSON.parse(json);
      expect(canonicalize(parsed)).toBe(json);
      const classified = classify(parsed);
      expect(classified.kind).toBe(kind);
      expect(classified.values).toEqual(values);
    }), { seed: 20261101, numRuns: 500 });
    expect([...seen].sort()).toEqual(Object.keys(COVERED).sort());
  });
});
