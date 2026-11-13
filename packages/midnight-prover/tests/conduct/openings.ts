import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, CLASSES, eventClass, eventOpening, eventSegments, valueSpecs } from "../../scripts/conduct/template.mjs";
import { maxClassEvent, realEvent, type RealEvent } from "./guard-events.js";
import { CAST_FAILED, runLedger, unitDir, zkCheck } from "./harness.js";

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
  "m_step_deny_all_skips_last_byte", "amount_reread", "event_hex_reread", "cap_reread", "decimal_leading_zero_waived_for_nines",
  "cbor_uint_minimal_waived_at_1000",
];

/**
 * Each guard event value's lexical class, and the payment amount's floor, as S-EVENT-OPEN declares them. The opening
 * reference and the lexical forgeries read them here, never from the template the emitter reads, which must agree.
 */
export const VALUE_CLASSES: Readonly<Record<string, { readonly lex: string; readonly nonzero?: true }>> = {
  amount: { lex: "dec64", nonzero: true }, asset: { lex: "str" }, counterparty: { lex: "str" }, destination: { lex: "str" },
  ts: { lex: "dec64" }, actionDigest: { lex: "hex64" }, enforcedAt: { lex: "dec64" }, mandateCommitment: { lex: "hex64" },
  dataSeq: { lex: "dec64" }, id: { lex: "uuid" }, traceSeq: { lex: "dec53" }, iso: { lex: "iso24" }, vis: { lex: "vis" },
};

/** The uint fields of a mandate, each read from its CBOR head byte or from the argument bytes after it. */
export const MANDATE_UINT_FIELDS = ["capAmount", "windowSeconds", "notBefore", "notAfter", "threshold", "committeeSize"] as const;
// Hex digests, the uuid, the ISO time and the event hash hex have fixed widths outside the class tuple.
const FIXED_EVENT_WITNESS_BYTES = 64 + 64 + 36 + 24 + 64;
// The mandate id, the counterparty, egress and measurement roots, and the egress mode byte.
const FIXED_MANDATE_WITNESS_BYTES = 16 + 32 + 32 + 32 + 1;
/** The prefix of every DID a mandate holds; its circuits read only the tail after it. */
export const DID_PREFIX = "did:key:z";
const sum = (values: readonly number[]) => values.reduce((total, n) => total + n, 0);

/**
 * The witness bytes of a compiled opening class, from its classes.json entry alone: an event's value lengths and fixed
 * widths, or a mandate's DID tails after `did:key:z`, asset, committee id, fixed fields and uint widths, where a uint in
 * its head byte still takes one.
 */
export function witnessWidth(circuit: string): number {
  const event: { lengths: Record<string, number> } | undefined = CLASSES.openings.events[circuit];
  if (event !== undefined) return sum(Object.values(event.lengths)) + FIXED_EVENT_WITNESS_BYTES;
  const m: Record<string, number> = CLASSES.openings.mandates[circuit];
  return FIXED_MANDATE_WITNESS_BYTES + m.principalDid! + m.agentDid! - 2 * DID_PREFIX.length + m.asset! + m.committeeId!
    + sum(MANDATE_UINT_FIELDS.map(field => Math.max(m[field]!, 1)));
}

/** The private inputs of a circuit's ZKIR as `unit` compiled it: one per witness byte each read of a witness takes. */
export function privateInputs(unit: string, circuit: string): number {
  const ir: { instructions: { op: string }[] } = JSON.parse(readFileSync(join(unitDir(unit), "zkir", `${circuit}.zkir`), "utf8"));
  return ir.instructions.filter(instruction => instruction.op === "private_input").length;
}

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

/**
 * The witnesses of one circuit run. The contract asks for every witness of the unit at construction; a circuit that
 * calls one outside its class fails, and so does a second call of any witness, whose answer the hashed bytes would not bind.
 */
export function witnessFunctions(witnesses: Readonly<Record<string, Uint8Array>>): object {
  const read = new Set<string>();
  const own = Object.fromEntries(Object.entries(witnesses).map(([name, bytes]) => [name, (context: { privateState: unknown }) => {
    if (read.has(name)) throw new Error(`witness ${name} read twice`);
    read.add(name);
    return [context.privateState, Array.from(bytes, BigInt)];
  }]));
  return new Proxy(own, {
    get: (target, name) => target[name as string] ?? (() => { throw new Error(`witness ${String(name)} is outside the opened class`); }),
  });
}

/** An event or mandate opening as a prover presents it: the class circuit, the witnesses it reads and the statement it claims. */
export type Presented = Readonly<Pick<Opening, "circuit" | "witnesses" | "statement">>;

/** The ledger cell an opening class writes its statement to. */
export function ledgerCell(circuit: string): string {
  const event: { kind: string } | undefined = CLASSES.openings.events[circuit];
  return event === undefined ? "mandateOpening" : event.kind.startsWith("payment-") ? "paymentOpening" : "egressOpening";
}

/** Opens an event or a mandate in its class through the generated JS of `unit` and returns the statement its ledger write disclosed. */
export async function runOpening({ circuit, witnesses, statement }: Presented, unit = OPENINGS_UNIT): Promise<unknown> {
  return (await runLedger(unit, circuit, witnessFunctions(witnesses), [statement]))[ledgerCell(circuit)];
}

/** Checks an opening at ZKIR on the assert-stripped copy of `unit` and returns the ledger its transcript wrote. */
export const checkOpening = ({ circuit, witnesses, statement }: Presented, unit = OPENINGS_UNIT) => zkCheck(unit, circuit, witnessFunctions(witnesses), [statement]);

/** "accepted", or the message `run` was refused with. */
export const settle = (run: Promise<unknown>) => run.then(() => "accepted", (error: Error) => error.message);

/** "accepted", or the message the generated JS of `unit` refused the opening with. */
export const openingOutcome = (opening: Presented, unit = OPENINGS_UNIT) => settle(runOpening(opening, unit));

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
export const endSpliced = (bytes: Uint8Array, tail: readonly number[]) => Uint8Array.from(bytes, (b, i) => tail[i - bytes.length + tail.length] ?? b);
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

const EVENT_CLASSES: Readonly<Record<string, { kind: string }>> = CLASSES.openings.events;
/** Each value of a compiled event class with its audited class. */
const classSegments = (id: string): Segment[] => [...valueSpecs(EVENT_CLASSES[id]!.kind).keys()].map(v => {
  const audited = VALUE_CLASSES[v];
  if (audited === undefined) throw new Error(`${v} has no audited lexical class`);
  return { v, ...audited };
});
/** Every string segment of every compiled event class. */
export const STRING_SEGMENTS: readonly (readonly [string, string])[] = Object.keys(EVENT_CLASSES)
  .flatMap(id => classSegments(id).filter(s => s.lex === "str").map(s => [id, s.v!] as const));

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
    const placed = atEnd ? endSpliced(segment, bytes) : spliced(segment, bytes);
    return { label, opening: rederived(opening, name, placed), refusal: STRING_CLASS };
  });
}

/**
 * A lexical forgery. Where the arithmetic of its bytes leaves a statement field's type, the forgery is out of type and
 * the field keeps its honest value.
 */
export interface LexicalForgery extends Forgery { readonly outOfType?: true }
/** A lexical forgery that a segment of its class's width cannot hold, and why. */
export interface Unheld { readonly label: string; readonly reason: string }

const fits = (field: string, value: bigint) => value >= 0n && value < 1n << (/(Hi|Lo)$/.test(field) ? 128n : 64n);
function lexical(o: Opening, label: string, name: string, bytes: Uint8Array, refusal: string | RegExp): LexicalForgery {
  const forged = rederived(o, name, bytes);
  const outside = Object.keys(forged.statement).filter(field => typeof forged.statement[field] === "bigint" && !fits(field, forged.statement[field] as bigint));
  if (outside.length === 0) return { label, opening: forged, refusal };
  return { label, opening: { ...forged, statement: { ...forged.statement, ...Object.fromEntries(outside.map(field => [field, o.statement[field]!])) } }, refusal, outOfType: true };
}

const CAST = new RegExp(CAST_FAILED);
// The bytes just outside the digits, and just outside the digits and the lowercase hex letters.
const DIGIT_EDGES = [0x2f, 0x3a];
const HEX_EDGES = [0x2f, 0x3a, 0x60, 0x67];
const char = (c: number) => String.fromCharCode(c);
function uppercased(segment: Uint8Array): Uint8Array {
  const at = segment.findIndex(b => b >= 0x61 && b <= 0x66);
  if (at < 0) throw new Error("the segment holds no hex letter to uppercase");
  return withByte(segment, at, segment[at]! - 0x20);
}

// Bytes outside the lexical class of one non-string segment, with the hash chain and statement re-derived.
function segmentForgeries(o: Opening, { v: name, lex, nonzero }: Segment): (LexicalForgery | Unheld)[] {
  const segment = o.segments[name!]!;
  const n = segment.length;
  const forge = (label: string, bytes: Uint8Array, refusal: string | RegExp) => lexical(o, `${name} ${label}`, name!, bytes, refusal);
  const unheld = (label: string, reason: string): Unheld => ({ label: `${name} ${label}`, reason });
  const last = (c: number) => withByte(segment, n - 1, c);
  const first = (c: number) => withByte(segment, 0, c);
  switch (lex) {
    case "dec64":
    case "dec53":
      return [
        n > 1 ? forge("with a leading zero", first(0x30), "failed assert: decimal leading zero") : unheld("with a leading zero", "one digit has no leading zero"),
        ...DIGIT_EDGES.map(c => forge(`with ${char(c)} as its last digit`, last(c), "failed assert: decimal digit")),
        ...(nonzero ? [n === 1 ? forge("of zero", latin1("0"), "failed assert: decimal nonzero") : unheld("of zero", "a zero of more than one digit has a leading zero, which is refused first")] : []),
        ...(lex === "dec64"
          ? [n === 20 ? forge("of the 20 digits of 2^64", latin1("18446744073709551616"), CAST) : unheld("of the 20 digits of 2^64", "fewer than 20 digits stay below 2^64")]
          : [
            forge("with an exponent e", withByte(segment, Math.min(1, n - 1), 0x65), "failed assert: decimal digit"),
            n === 16 ? forge("of the 16 digits of 2^53", latin1("9007199254740992"), "failed assert: trace seq unsafe") : unheld("of the 16 digits of 2^53", "fewer than 16 digits stay below 2^53"),
          ]),
      ];
    case "hex64":
      return [forge("with an uppercase hex letter", uppercased(segment), "failed assert: noncanonical hex"), ...HEX_EDGES.map(c => forge(`with ${char(c)} as its last digit`, last(c), "failed assert: noncanonical hex"))];
    case "uuid":
      return [
        forge("with an uppercase hex letter", uppercased(segment), "failed assert: uuid"), ...HEX_EDGES.map(c => forge(`with ${char(c)} as its first digit`, first(c), "failed assert: uuid")),
        forge("without its first hyphen", withByte(segment, 8, 0x30), "failed assert: uuid"),
      ];
    case "iso24":
      return [forge("without its T", withByte(segment, 10, 0x20), "failed assert: iso8601"), ...[0x41, 0x2f, 0x3a].map(c => forge(`with ${char(c)} as its first digit`, first(c), "failed assert: iso8601"))];
    case "vis":
      return [forge("with an uppercase first letter", first(segment[0]! - 0x20), "failed assert: visibility"), forge("with a digit for its first letter", first(0x30), "failed assert: visibility")];
    case "str":
      return [];
    default:
      throw new Error(`no lexical forgeries for the ${lex} class`);
  }
}

/** The lexical forgeries of every non-string segment of an honest opening, and those its class's widths cannot hold. */
export function lexicalForgeries(o: Opening): { forgeries: LexicalForgery[]; unheld: Unheld[] } {
  const all = classSegments(o.circuit).flatMap(spec => segmentForgeries(o, spec));
  return { forgeries: all.filter((f): f is LexicalForgery => "opening" in f), unheld: all.filter((f): f is Unheld => "reason" in f) };
}
