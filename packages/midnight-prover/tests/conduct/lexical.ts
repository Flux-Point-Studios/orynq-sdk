import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { UnitModule } from "./harness.js";
import { latin1, sha256 } from "./openings.js";
import { withoutStacks } from "./order-type.js";

/** A gadget's judgement of some bytes: the value it reads, or the message of the assert that refuses them. */
export type Judgement = { readonly value: unknown } | { readonly refused: string };

/** A lexical gadget's whole input class, run through its pure probe in the openings unit and judged by a reference. */
export interface GadgetClass {
  readonly probe: string;
  inputs(): Iterable<number[]>;
  expected(bytes: readonly number[]): Judgement;
  args?(bytes: readonly number[]): unknown[];
}

const accepted = (value: unknown = []): Judgement => ({ value });
const refused = (message: string): Judgement => ({ refused: message });
const ASSERT = "failed assert: ";
// A cast to a narrower Uint is a constraint too: decU64 refuses 2^64 and above with it.
const CAST = /^[^:]+ line \d+ char \d+: cast from Field or Uint value to smaller Uint value failed/;
const asText = (bytes: readonly number[]) => Buffer.from(bytes).toString("latin1");
const ascii = (text: string) => [...latin1(text)];

// Lead bytes first, so a scan for the first disagreement of a gadget mutant ends early.
const BYTES = Array.from({ length: 256 }, (_, i) => 255 - i);

/**
 * Every byte that utf8Next, jsonStep or anyStep compares a byte with, directly or as a range bound the state carries:
 * their audited literals above the state values and sizes 0-8.
 */
export const UTF8_EDGES = [32, 34, 92, 128, 143, 144, 159, 160, 191, 194, 223, 224, 237, 239, 240, 244];
/** The bytes 0-255 in classes: each edge alone, and each run between two edges. Every comparison the automaton makes is constant on a class. */
export const UTF8_CLASSES: readonly (readonly number[])[] = [0, ...UTF8_EDGES.flatMap(edge => [edge, edge + 1])]
  .map((start, i, starts) => Array.from({ length: (starts[i + 1] ?? 256) - start }, (_, k) => start + k)).filter(c => c.length > 0);
const LOWEST = UTF8_CLASSES.map(c => c[0]!);
const ENDS = UTF8_CLASSES.flatMap(c => (c.length === 1 ? [c[0]!] : [c[0]!, c.at(-1)!]));

/** Every tuple with its i-th byte from `sets[i]`. */
function* product(sets: readonly (readonly number[])[]): Generator<number[]> {
  const at = sets.map(() => 0);
  for (;;) {
    yield at.map((i, k) => sets[k]![i]!);
    let k = sets.length - 1;
    while (k >= 0 && ++at[k]! === sets[k]!.length) at[k--] = 0;
    if (k < 0) return;
  }
}

/** Every byte value at every position of `base`. */
function* deviations(base: readonly number[]): Generator<number[]> {
  for (let at = 0; at < base.length; at++) {
    for (let value = 0; value < 256; value++) yield base.map((b, i) => (i === at ? value : b));
  }
}

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decoded(bytes: readonly number[]): string | undefined {
  try {
    return strict.decode(Uint8Array.from(bytes));
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

/**
 * Every sequence of byte classes: one- and two-byte strings in full, three-byte strings of the lowest and highest byte
 * of each class, and four-byte strings of the lowest byte of each class.
 */
export function utf8Inputs(width: number): Iterable<number[]> {
  return product(Array.from({ length: width }, () => (width <= 2 ? BYTES : width === 3 ? ENDS : LOWEST)));
}

const U64_LIMIT = 1n << 64n;
const SAFE_LIMIT = 1n << 53n;

/**
 * The decimal gadget at one width: every byte value at every position of the smallest and the largest value of the
 * width, of a value with a leading zero and of the largest value below the gadget's bound, and every input of up to two
 * bytes. dec53 reads through decU64 and then bounds the value below 2^53.
 */
function decimalClass(width: number, safe: boolean): GadgetClass {
  const largest = String((safe ? SAFE_LIMIT : U64_LIMIT) - 1n);
  const bases = new Set([`1${"0".repeat(width - 1)}`, "9".repeat(width), `0${"9".repeat(width - 1)}`, ...(largest.length === width ? [largest] : [])]);
  return {
    probe: safe ? `dec53_w${width}` : `dec_u64_w${width}`,
    *inputs() {
      if (width <= 2) yield* product(Array.from({ length: width }, () => BYTES));
      else for (const base of bases) yield* deviations(ascii(base));
    },
    expected: bytes => {
      const text = asText(bytes);
      if (!/^[0-9]+$/.test(text)) return refused("decimal digit");
      if (width > 1 && text.startsWith("0")) return refused("decimal leading zero");
      const value = BigInt(text);
      if (value >= U64_LIMIT) return refused("cast to a smaller Uint");
      return safe && value >= SAFE_LIMIT ? refused("trace seq unsafe") : accepted(value);
    },
  };
}

const GENERATED = readFileSync(resolve(import.meta.dirname, "../../circuits/conduct/openings.generated.compact"), "utf8");
const widthsOf = (gadget: string) => [...GENERATED.matchAll(new RegExp(`\\b${gadget}<(\\d+)>\\(`, "g"))].map(([, n]) => Number(n));
const sortedSet = (values: readonly number[]) => [...new Set(values)].sort((a, b) => a - b);
/** The widths each decimal gadget is instantiated at in the generated openings; dec53 reads through decU64 at its own width. */
export const DECIMAL_WIDTHS = { decU64: sortedSet([...widthsOf("decU64"), ...widthsOf("dec53")]), dec53: sortedSet(widthsOf("dec53")) };

const HEX = /^[0-9a-f]*$/;
const HASH = sha256("hex link");
const HASH_HEX = ascii(Buffer.from(HASH).toString("hex"));
export const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const single = (probe: string, member: (c: number) => boolean, message: string): GadgetClass =>
  ({ probe, inputs: () => product([BYTES]), expected: ([c]) => (member(c!) ? accepted() : refused(message)) });
const shape = (probe: string, bases: readonly string[], member: (text: string) => boolean, message: string): GadgetClass => ({
  probe,
  *inputs() {
    for (const base of bases) yield* deviations(ascii(base));
  },
  expected: bytes => (member(asText(bytes)) ? accepted() : refused(message)),
});

export const GADGET_CLASSES: readonly GadgetClass[] = [
  ...[1, 2, 3, 4].map((width): GadgetClass => ({
    probe: `json_str_w${width}`,
    inputs: () => utf8Inputs(width),
    expected: bytes => {
      const text = decoded(bytes);
      return text !== undefined && JSON.stringify(text) === `"${text}"` ? accepted() : refused("string outside escape-free well-formed UTF-8 class");
    },
  })),
  ...[1, 2, 3, 4].map((width): GadgetClass => ({
    probe: `utf8_any_w${width}`,
    inputs: () => utf8Inputs(width),
    expected: bytes => (decoded(bytes) === undefined ? refused("well-formed UTF-8") : accepted()),
  })),
  ...DECIMAL_WIDTHS.decU64.map(width => decimalClass(width, false)),
  ...DECIMAL_WIDTHS.dec53.map(width => decimalClass(width, true)),
  {
    probe: "hex_halves",
    inputs: () => deviations(ascii("0123456789abcdef".repeat(4))),
    expected: bytes => {
      const text = asText(bytes);
      return HEX.test(text) ? accepted([BigInt(`0x${text.slice(0, 32)}`), BigInt(`0x${text.slice(32)}`)]) : refused("noncanonical hex");
    },
  },
  {
    probe: "hex_of_hash",
    inputs: () => deviations(HASH_HEX),
    args: bytes => [bytes.map(BigInt), HASH],
    expected: bytes => (isDeepStrictEqual(bytes, HASH_HEX) ? accepted() : HEX.test(asText(bytes)) ? refused("hex opening") : refused("noncanonical hex")),
  },
  shape("uuid_shape", ["550e8400-e29b-41d4-a716-446655440000"], text => UUID.test(text), "uuid"),
  shape("iso8601_shape", ["2026-10-27T00:00:00.000Z"], text => ISO.test(text), "iso8601"),
  shape("vis6_shape", ["public", "secret"], text => text === "public" || text === "secret", "visibility"),
  shape("vis7_shape", ["private"], text => text === "private", "visibility"),
  single("base58_w1", c => BASE58.includes(String.fromCharCode(c)), "base58"),
  single("ascii_print_w1", c => c >= 0x21 && c <= 0x7e, "printable ASCII"),
];

/** The probe's judgement of `bytes`; an error that is neither an assert's nor a cast's refusal propagates. */
export function judge(pure: UnitModule["pureCircuits"], c: GadgetClass, bytes: readonly number[]): Judgement {
  const probe = pure[c.probe];
  if (typeof probe !== "function") throw new TypeError(`pureCircuits.${c.probe} is not a function`);
  try {
    return accepted(probe(...(c.args?.(bytes) ?? [bytes.map(BigInt)])));
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith(ASSERT)) return refused(message.slice(ASSERT.length));
    if (CAST.test(message)) return refused("cast to a smaller Uint");
    throw error;
  }
}

const same = (a: Judgement, b: Judgement) => ("refused" in a && "refused" in b ? a.refused === b.refused : isDeepStrictEqual(a, b));

export interface Disagreement { readonly bytes: readonly number[]; readonly circuit: Judgement; readonly reference: Judgement }

/** The first `limit` inputs of the class on which the probe and the reference differ. */
export function disagreements(pure: UnitModule["pureCircuits"], c: GadgetClass, limit: number): Disagreement[] {
  return withoutStacks(() => {
    const out: Disagreement[] = [];
    for (const bytes of c.inputs()) {
      const [circuit, reference] = [judge(pure, c, bytes), c.expected(bytes)];
      if (!same(circuit, reference)) out.push({ bytes, circuit, reference });
      if (out.length === limit) break;
    }
    return out;
  });
}

const shown = (j: Judgement) => ("refused" in j ? `refused "${j.refused}"` : `accepted ${JSON.stringify(j.value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`);
export const describeDisagreement = (c: GadgetClass, d: Disagreement) =>
  `${c.probe} [${Buffer.from(d.bytes).toString("hex")}]: circuit ${shown(d.circuit)}, reference ${shown(d.reference)}`;
