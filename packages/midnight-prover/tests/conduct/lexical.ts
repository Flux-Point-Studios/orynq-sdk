import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { UnitModule } from "./harness.js";
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
const latin1 = (bytes: readonly number[]) => Buffer.from(bytes).toString("latin1");
const ascii = (text: string) => Array.from(Buffer.from(text, "latin1"));

// Lead bytes first, so a scan for the first disagreement of a gadget mutant ends early.
const BYTES = Array.from({ length: 256 }, (_, i) => 255 - i);
// The edges of the UTF-8 and JSON byte classes: control, quote, backslash, DEL, the continuation range, and leads.
const EDGES = [0xff, 0xc0, 0xbf, 0x80, 0x7f, 0x5c, 0x22, 0x00];
// With the edges of the second-byte ranges after E0, ED, F0 and F4.
const SECOND_EDGES = [...EDGES, 0xa0, 0x9f, 0x90, 0x8f];
const CONTINUATION_EDGES = [0xbf, 0x80];

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
 * One- and two-byte strings in full, and three-byte strings with every first and second byte and an edge byte after.
 * Four-byte strings take every first and second byte completed by continuation edges, and every first byte with a
 * second-byte edge followed by edge bytes.
 */
function* utf8Inputs(width: number): Generator<number[]> {
  if (width < 4) yield* product([BYTES, BYTES, EDGES].slice(0, width));
  else {
    yield* product([BYTES, BYTES, CONTINUATION_EDGES, CONTINUATION_EDGES]);
    yield* product([BYTES, SECOND_EDGES, EDGES, EDGES]);
  }
}
const HEX = /^[0-9a-f]*$/;
const HASH = new Uint8Array(createHash("sha256").update("hex link").digest());
const HASH_HEX = ascii(Buffer.from(HASH).toString("hex"));
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const single = (probe: string, member: (c: number) => boolean, message: string): GadgetClass =>
  ({ probe, inputs: () => product([BYTES]), expected: ([c]) => (member(c!) ? accepted() : refused(message)) });
const shape = (probe: string, bases: readonly string[], member: (text: string) => boolean, message: string): GadgetClass => ({
  probe,
  *inputs() {
    for (const base of bases) yield* deviations(ascii(base));
  },
  expected: bytes => (member(latin1(bytes)) ? accepted() : refused(message)),
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
  { probe: "dec_u64_w1", inputs: () => product([BYTES]), expected: ([c]) => (c! >= 0x30 && c! <= 0x39 ? accepted(BigInt(c! - 0x30)) : refused("decimal digit")) },
  {
    probe: "dec_u64_w2",
    inputs: () => product([BYTES, BYTES]),
    expected: bytes => {
      const text = latin1(bytes);
      return !/^[0-9]{2}$/.test(text) ? refused("decimal digit") : text.startsWith("0") ? refused("decimal leading zero") : accepted(BigInt(text));
    },
  },
  {
    probe: "hex_halves",
    inputs: () => deviations(ascii("0123456789abcdef".repeat(4))),
    expected: bytes => {
      const text = latin1(bytes);
      return HEX.test(text) ? accepted([BigInt(`0x${text.slice(0, 32)}`), BigInt(`0x${text.slice(32)}`)]) : refused("noncanonical hex");
    },
  },
  {
    probe: "hex_of_hash",
    inputs: () => deviations(HASH_HEX),
    args: bytes => [bytes.map(BigInt), HASH],
    expected: bytes => (isDeepStrictEqual(bytes, HASH_HEX) ? accepted() : HEX.test(latin1(bytes)) ? refused("hex opening") : refused("noncanonical hex")),
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
