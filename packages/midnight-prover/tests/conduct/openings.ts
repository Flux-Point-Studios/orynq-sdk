import { createHash } from "node:crypto";
import { classify, CLASSES, eventClass, eventOpening, eventSegments, expandKinds } from "../../scripts/conduct/template.mjs";
import { maxClassEvent, realEvent, type RealEvent } from "./guard-events.js";
import { runLedger } from "./harness.js";

export interface Segment { readonly c?: string; readonly v?: string; readonly lex?: string; readonly max?: number; readonly nonzero?: boolean }

export interface Opening {
  readonly circuit: string;
  readonly kind: string;
  readonly segments: Readonly<Record<string, Uint8Array>>;
  readonly witnesses: Readonly<Record<string, Uint8Array>>;
  readonly statement: Readonly<Record<string, Uint8Array | bigint>>;
}

export const OPENINGS_UNIT = "openings";

/** The discrimination mutants of the openings unit; openings-mutants.test.ts kills each one. */
export const OPENINGS_MUTANTS = [
  "open_no_hash_link", "hex_link_skips_last_byte", "hex_digit_g", "decimal_digit_slash", "iso_digit_slash",
  "utf8_tail_continuation_low", "utf8_lead4_to_f7", "utf8_lead2_to_e0", "json_continuation_standalone", "json_truncated_end",
  "pd4_counterparty_unchecked", "unicode_counterparty_unchecked", "pa_max_counterparty_unchecked", "m_max_principal_unchecked",
];

/** One honest guard event for each compiled event class. */
export async function honestEvents(): Promise<Map<string, RealEvent>> {
  const makers: [string, () => Promise<RealEvent>][] = [
    ["ev_pa_ascii_min", () => realEvent("payment-action", "ascii-min")],
    ["ev_pa_unicode_max", () => realEvent("payment-action", "unicode-max")],
    ["ev_pa_max", maxClassEvent],
    ["ev_pd4_ascii_min", () => realEvent("payment-denial-4", "ascii-min")],
    ["ev_ea_ascii_min", () => realEvent("egress-action", "ascii-min")],
  ];
  return new Map(await Promise.all(makers.map(async ([id, make]) => [id, await make()] as const)));
}

// The contract asks for every witness of the unit at construction; a circuit that calls one outside its class fails.
export function witnessFunctions(witnesses: Readonly<Record<string, Uint8Array>>): object {
  const own = Object.fromEntries(Object.entries(witnesses).map(([name, bytes]) => [name, (context: { privateState: unknown }) => [context.privateState, Array.from(bytes, BigInt)]]));
  return new Proxy(own, {
    get: (target, name) => target[name as string] ?? (() => { throw new Error(`witness ${String(name)} is outside the opened class`); }),
  });
}

export const ledgerCell = (kind: string) => (kind.startsWith("payment-") ? "paymentOpening" : "egressOpening");

/** Opens an event in its class through the generated JS of `unit` and returns the statement its ledger write disclosed. */
export async function runOpening({ circuit, kind, witnesses, statement }: Opening, unit = OPENINGS_UNIT): Promise<unknown> {
  return (await runLedger(unit, circuit, witnessFunctions(witnesses), [statement]))[ledgerCell(kind)];
}

/** "accepted", or the message the generated JS of `unit` refused the opening with. */
export const openingOutcome = (opening: Opening, unit = OPENINGS_UNIT) => runOpening(opening, unit).then(() => "accepted", (error: Error) => error.message);

export function openingOf(e: RealEvent): Opening {
  const classified = classify(e.event);
  const circuit = eventClass(classified);
  const segments = eventSegments(classified);
  return { circuit, kind: classified.kind, segments, ...eventOpening(circuit, segments, e.rollBefore) };
}

export const sha256 = (...parts: (Uint8Array | string)[]) => new Uint8Array(parts.reduce((hash, part) => hash.update(part), createHash("sha256")).digest());
export const latin1 = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
export const withByte = (bytes: Uint8Array, at: number, value: number) => Uint8Array.from(bytes, (b, i) => (i === at ? value : b));
export const spliced = (bytes: Uint8Array, head: readonly number[]) => Uint8Array.from(bytes, (b, i) => head[i] ?? b);
export const withWitness = (opening: Opening, name: string, bytes: Uint8Array): Opening => ({ ...opening, witnesses: { ...opening.witnesses, [name]: bytes } });

/** The rolling step over an event hash's hex, as process-trace computes it. */
export const rollAfterOf = (prevRollHex: Uint8Array, eventHex: Uint8Array) => sha256("poi-trace:roll:v1|", prevRollHex, "|", eventHex);

/**
 * The segment replaced and the statement re-derived from the new bytes as a prover would claim it, so the event hash,
 * the rolling step and every statement binding hold and only a lexical gadget can refuse.
 */
export function rederived(opening: Opening, name: string, bytes: Uint8Array, claim: Readonly<Record<string, bigint | Uint8Array>> = {}): Opening {
  const segments = { ...opening.segments, [name]: bytes };
  const { witnesses, statement } = eventOpening(opening.circuit, segments, Buffer.from(opening.statement.prevRollHex as Uint8Array).toString("latin1"));
  return { ...opening, segments, witnesses, statement: { ...statement, ...claim } };
}

/**
 * Each statement field moved by one without leaving its type, so a uint at its maximum only moves down, and a bit
 * flipped in its first and last byte.
 */
export function fieldVariants(field: string, value: Uint8Array | bigint): (Uint8Array | bigint)[] {
  if (value instanceof Uint8Array) {
    return [withByte(value, 0, value[0]! ^ 1), withByte(value, value.length - 1, value.at(-1)! ^ 1), withByte(value, value.length - 1, (value.at(-1)! + 1) % 256)];
  }
  const bits = /(Hi|Lo)$/.test(field) ? 128n : 64n;
  return [value + 1n, value - 1n, value ^ (1n << (bits - 8n)), value ^ 1n].filter(v => v >= 0n && v < 1n << bits);
}

/** An opening changed past its class, and the message of the generated assert that must refuse it. */
export interface Forgery<T = Opening> { readonly label: string; readonly opening: T; readonly refusal: string | RegExp }

/** The label and outcome of each forgery that `run` judges otherwise than with its refusal. */
export async function misjudged<T>(forgeries: readonly Forgery<T>[], run: (opening: T) => Promise<string>): Promise<string[]> {
  const out: string[] = [];
  for (const { label, opening, refusal } of forgeries) {
    const result = await run(opening);
    if (typeof refusal === "string" ? result !== refusal : !refusal.test(result)) out.push(`${label}: ${result}`);
  }
  return out;
}

const HEX = "0123456789abcdef";

/**
 * Each eventHex byte replaced and rollAfter re-derived over the forged hex, so only the hex link can refuse: another hex
 * digit, which its equality refuses, and for a letter the non-hex byte nib reads as the same nibble (':' for 'a'),
 * which only its hex check refuses.
 */
export function hexLinkForgeries(opening: Opening): Forgery[] {
  const name = `${opening.circuit}_eventHex`;
  const hex = opening.witnesses[name]!;
  return [...hex].flatMap((c, at) => {
    const nibble = HEX.indexOf(String.fromCharCode(c));
    const forged: [string, number, string][] = [[`eventHex[${at}] another hex digit`, HEX.charCodeAt(nibble ^ 1), "failed assert: hex opening"]];
    if (nibble >= 10) forged.push([`eventHex[${at}] ${String.fromCharCode(0x30 + nibble)} for ${HEX[nibble]}`, 0x30 + nibble, "failed assert: noncanonical hex"]);
    return forged.map(([label, value, refusal]) => {
      const bytes = withByte(hex, at, value);
      return { label, refusal, opening: { ...withWitness(opening, name, bytes), statement: { ...opening.statement, rollAfter: rollAfterOf(opening.statement.prevRollHex as Uint8Array, bytes) } } };
    });
  });
}

const KINDS: Record<string, Segment[]> = expandKinds();
/** Every string segment of every compiled event class. */
export const STRING_SEGMENTS: readonly (readonly [string, string])[] = Object.entries(CLASSES.openings.events as Record<string, { kind: string }>)
  .flatMap(([id, { kind }]) => [...new Set(KINDS[kind]!.filter(s => s.lex === "str").map(s => s.v!))].map(name => [id, name] as const));

const STRING_CLASS = "failed assert: string outside escape-free well-formed UTF-8 class";
// Each placed at the head of the segment, or at its end where its flag is set.
const MALFORMED_UTF8: readonly (readonly [string, readonly number[], boolean?])[] = [
  ["CESU ED A0 80", [0xed, 0xa0, 0x80]], ["overlong C0 AF", [0xc0, 0xaf]], ["overlong C1 BF", [0xc1, 0xbf]], ["overlong E0 80 AF", [0xe0, 0x80, 0xaf]],
  ["overlong F0 80 80 AF", [0xf0, 0x80, 0x80, 0xaf]], ["above U+10FFFF F4 90 80 80", [0xf4, 0x90, 0x80, 0x80]], ["lead F5 80 80 80", [0xf5, 0x80, 0x80, 0x80]],
  ["lone continuation 80", [0x80]], ["lone continuation BF", [0xbf]], ["byte FF", [0xff]], ["a quote after a lead E2 80 22", [0xe2, 0x80, 0x22]],
  ["ASCII after a lead E0 A0 41", [0xe0, 0xa0, 0x41]], ["a lead after a lead F0 9F C0 80", [0xf0, 0x9f, 0xc0, 0x80]],
  ["a truncated E2 at the end", [0xe2], true], ["a truncated F0 9F 98 at the end", [0xf0, 0x9f, 0x98], true],
  ...Array.from({ length: 32 }, (_, c) => [`raw 0x${c.toString(16).padStart(2, "0")}`, [c]] as const), ["raw quote", [0x22]], ["raw backslash", [0x5c]],
];

/** Malformed UTF-8 and every JSON-escaped byte that fit a string segment, with the hash chain and statement re-derived. */
export function malformedStrings(opening: Opening, name: string): Forgery[] {
  const segment = opening.segments[name]!;
  return MALFORMED_UTF8.filter(([, bytes]) => bytes.length <= segment.length).map(([label, bytes, atEnd]) => {
    const placed = atEnd ? Uint8Array.from(segment, (b, i) => bytes[i - segment.length + bytes.length] ?? b) : spliced(segment, bytes);
    return { label, opening: rederived(opening, name, placed), refusal: STRING_CLASS };
  });
}

/**
 * A lexical forgery of one class's honest opening. A cast's range check runs in the generated JS even with its asserts
 * stripped, so a forgery a cast refuses (`castRefused`) yields no transcript for the constraints to check.
 */
export interface ClassForgery { readonly circuit: string; readonly castRefused?: true; forge(opening: Opening): Forgery }

const segmentForgery = (label: string, circuit: string, name: string, bytes: (segment: Uint8Array) => Uint8Array, refusal: string | RegExp, claim = {}): ClassForgery =>
  ({ circuit, forge: o => ({ label, opening: rederived(o, name, bytes(o.segments[name]!), claim), refusal }) });
const firstLetter = (segment: Uint8Array) => segment.findIndex(b => b >= 0x61 && b <= 0x66);
const uppercased = (segment: Uint8Array) => withByte(segment, firstLetter(segment), segment[firstLetter(segment)]! - 0x20);
// The bytes on either side of the digits and the lowercase hex letters. Each goes in a segment's last digit, where the
// value its arithmetic reads stays inside the statement field's type.
const HEX_EDGES = [0x2f, 0x3a, 0x60, 0x67];
const lastByte = (c: number) => (segment: Uint8Array) => withByte(segment, segment.length - 1, c);

/** Bytes outside each non-string segment's lexical class, with the hash chain and statement re-derived. */
export const LEXICAL_FORGERIES: readonly ClassForgery[] = [
  segmentForgery("a leading zero", "ev_pa_unicode_max", "dataSeq", () => latin1("01"), "failed assert: decimal leading zero"),
  ...[0x2f, 0x3a].map(c => segmentForgery(`${String.fromCharCode(c)} as a dataSeq digit`, "ev_pa_unicode_max", "dataSeq", lastByte(c), "failed assert: decimal digit")),
  segmentForgery("a zero amount", "ev_pa_ascii_min", "amount", () => latin1("0"), "failed assert: decimal nonzero"),
  {
    ...segmentForgery("the 20 digits of 2^64", "ev_pa_unicode_max", "amount", () => latin1("18446744073709551616"), /cast from Field or Uint value to smaller Uint value failed/, { amount: 0n }),
    castRefused: true,
  },
  segmentForgery("the 16 digits of 2^53 as trace seq", "ev_pa_max", "traceSeq", () => latin1("9007199254740992"), "failed assert: trace seq unsafe"),
  segmentForgery("1e3 as trace seq", "ev_pa_max", "traceSeq", () => latin1("1e30000000000000"), "failed assert: decimal digit"),
  ...["actionDigest", "mandateCommitment"].flatMap(name => [
    segmentForgery(`uppercase hex in ${name}`, "ev_pa_ascii_min", name, uppercased, "failed assert: noncanonical hex"),
    ...HEX_EDGES.map(c => segmentForgery(`${String.fromCharCode(c)} in ${name}`, "ev_pa_ascii_min", name, lastByte(c), "failed assert: noncanonical hex")),
  ]),
  segmentForgery("uppercase hex in the id", "ev_pa_ascii_min", "id", uppercased, "failed assert: uuid"),
  ...HEX_EDGES.map(c => segmentForgery(`${String.fromCharCode(c)} in the id`, "ev_pa_ascii_min", "id", s => withByte(s, 0, c), "failed assert: uuid")),
  segmentForgery("a uuid without its hyphen", "ev_pa_ascii_min", "id", s => withByte(s, 8, 0x30), "failed assert: uuid"),
  segmentForgery("an ISO time without its T", "ev_pa_ascii_min", "iso", s => withByte(s, 10, 0x20), "failed assert: iso8601"),
  ...[0x41, 0x2f, 0x3a].map(c => segmentForgery(`${String.fromCharCode(c)} for an ISO digit`, "ev_pa_ascii_min", "iso", s => withByte(s, 0, c), "failed assert: iso8601")),
  segmentForgery("a visibility outside its class", "ev_pa_ascii_min", "vis", s => withByte(s, 0, 0x50), "failed assert: visibility"),
  segmentForgery("Public for public", "ev_pa_unicode_max", "vis", () => latin1("Public"), "failed assert: visibility"),
];
