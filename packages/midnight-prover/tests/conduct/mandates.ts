import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { buildAllowlistRoot, decodeMandate, encodeMandate, hexToBytes, type MandateV1 } from "@fluxpointstudios/orynq-sdk-conduct";
import { CLASSES, mandateClass, mandateOpening, mandateSegments, uintOfBigEndian } from "../../scripts/conduct/template.mjs";
import { MAX_U64 } from "./cases.js";
import { BASE58 } from "./lexical.js";
import { endSpliced, MANDATE_UINT_FIELDS, spliced, withByte, type Forgery } from "./openings.js";

interface MandateVector { readonly name: string; readonly cborHex: string; readonly commitmentHex?: string; readonly code?: string }
export const MANDATE_VECTORS: { valid: MandateVector[]; invalid: MandateVector[] } =
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../conduct/tests/fixtures/mandate-vectors.json"), "utf8"));

/** The largest mandate the codec accepts: 256-character DID tails, 128-byte asset and committee, 8-byte uints. */
export function maxMandate(): MandateV1 {
  const tail = BASE58.repeat(5).slice(0, 256);
  return {
    schemaVersion: 1n, mandateId: new Uint8Array(16).fill(0xee), principalDid: `did:key:z${tail}`, agentDid: `did:key:z${[...tail].reverse().join("")}`,
    didFormatVersion: 0n, spendCap: { asset: "~".repeat(128), amount: MAX_U64, windowSeconds: MAX_U64 - 1n },
    counterpartyAllowlistRoot: new Uint8Array(32).fill(0x22), egressPolicy: { mode: 1n, allowlistRoot: new Uint8Array(32).fill(0x33) },
    approvedMeasurementSetRoot: new Uint8Array(32).fill(0x44), validityWindow: { notBefore: 1n << 32n, notAfter: MAX_U64 },
    disclosurePolicy: { committeeId: `${"€".repeat(42)}ab`, threshold: 1n << 32n, committeeSize: MAX_U64 },
  };
}

/** The mandate the step classes open: 17-byte DIDs, asset USD, committee c, every uint in its CBOR head. */
function stepMandate(): MandateV1 {
  return {
    schemaVersion: 1n, mandateId: new Uint8Array(16).fill(0x5a), principalDid: "did:key:z6MkhaXgB", agentDid: "did:key:z6MkjchhF",
    didFormatVersion: 0n, spendCap: { asset: "USD", amount: 9n, windowSeconds: 4n },
    counterpartyAllowlistRoot: buildAllowlistRoot(["acme", "beta", "cafe"]),
    egressPolicy: { mode: 1n, allowlistRoot: buildAllowlistRoot(["api1", "api2", "api3"]) },
    approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: 2n, notAfter: 8n },
    disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n },
  };
}

const VECTOR_CLASSES: Readonly<Record<string, string>> = {
  "base allowlist-egress mandate": "m_base",
  "deny-all egress with zero root": "m_base",
  "zero spend cap (deny all spending)": "m_zero_cap",
  "field maxima + unicode committee id + cardano unit asset": "m_field_maxima",
  "one-second validity window, unanimous 2-of-2": "m_one_second",
};
/** Each honest mandate with the class it opens in: the valid fixture vectors, the largest mandate and the step mandate. */
export const HONEST_MANDATES: readonly (readonly [string, Uint8Array, string | undefined])[] = [
  ...MANDATE_VECTORS.valid.map(v => [v.name, hexToBytes(v.cborHex), VECTOR_CLASSES[v.name]] as const),
  ["the largest mandate", encodeMandate(maxMandate()), "m_max"],
  ["the step mandate", encodeMandate(stepMandate()), "m_step"],
];

// The first of value^1, value^2 and value^3 that `ok` admits. Each has the value's CBOR head width, because the width
// bounds 24, 2^8, 2^16, 2^32 and 2^64 are multiples of 4.
const near = (value: bigint, ok: (v: bigint) => boolean = () => true) => [1n, 2n, 3n].map(d => value ^ d).find(ok)!;
const flipped = (root: Uint8Array) => Uint8Array.from(root, b => b ^ 1);

/** A mandate of the class of `cbor` with the other egress mode and every other atom of K changed. */
export function sibling(cbor: Uint8Array): Uint8Array {
  const m = decodeMandate(cbor);
  const { notBefore, notAfter } = m.validityWindow;
  const [nb, na] = [1n, 2n, 3n].flatMap(d => [1n, 2n, 3n].map(e => [notBefore ^ d, notAfter ^ e] as const)).find(([b, a]) => b < a)!;
  return encodeMandate({
    ...m,
    spendCap: {
      asset: [...m.spendCap.asset].map(c => (c === "~" ? "!" : String.fromCharCode(c.charCodeAt(0) + 1))).join(""),
      amount: near(m.spendCap.amount), windowSeconds: near(m.spendCap.windowSeconds, v => v >= 1n),
    },
    counterpartyAllowlistRoot: flipped(m.counterpartyAllowlistRoot),
    egressPolicy: m.egressPolicy.mode === 1n ? { mode: 0n, allowlistRoot: new Uint8Array(32) } : { mode: 1n, allowlistRoot: flipped(m.egressPolicy.allowlistRoot) },
    validityWindow: { notBefore: nb, notAfter: na },
  });
}

export interface MandateOpening {
  readonly circuit: string;
  readonly segments: Readonly<Record<string, Uint8Array>>;
  readonly witnesses: Readonly<Record<string, Uint8Array>>;
  readonly statement: Readonly<{ commitment: Uint8Array; atoms: Uint8Array }>;
  readonly atoms: Readonly<Record<string, Uint8Array | bigint>>;
}

/** The class dimensions and segments of a mandate the strict codec accepts; the codec's refusal passes through. */
export function classifiedMandate(cbor: Uint8Array) {
  decodeMandate(cbor);
  return mandateSegments(cbor);
}

export function mandateOpeningOf(cbor: Uint8Array): MandateOpening {
  const classified = classifiedMandate(cbor);
  const circuit = mandateClass(classified);
  return { circuit, segments: classified.segments, ...mandateOpening(circuit, classified.segments) };
}

/**
 * Segments changed past the codec, with C and K re-derived from them, so the commitment and atoms bindings hold and only
 * the circuit's schema rule can refuse.
 */
export function crafted(opening: MandateOpening, changes: Readonly<Record<string, Uint8Array>>): MandateOpening {
  const segments = { ...opening.segments, ...changes };
  return { ...opening, segments, ...mandateOpening(opening.circuit, segments) };
}

export const bigEndianBytes = (value: bigint, width: number) => Uint8Array.from({ length: width }, (_, i) => Number((value >> BigInt(8 * (width - 1 - i))) & 0xffn));
// The largest value each argument width encodes that a shorter encoding also holds.
const BELOW_MINIMAL: Readonly<Record<number, bigint>> = { 1: 23n, 2: 255n, 4: 65535n, 8: (1n << 32n) - 1n };
const COMMITTEE_MALFORMED: readonly (readonly [string, readonly number[]])[] = [
  ["a lone continuation byte", [0x80]], ["an overlong", [0xc0, 0xaf]], ["a surrogate", [0xed, 0xa0, 0x80]], ["a lead above F4", [0xf5, 0x80, 0x80, 0x80]],
];

/**
 * In every field a gadget reads, bytes outside its class crafted past the codec, with C and K re-derived, and the assert
 * that refuses them: base58 DIDs and a printable ASCII asset, broken at their first and their last byte, a well-formed
 * committee id and the shortest uint encodings.
 */
export function fieldForgeries(opening: MandateOpening): Forgery<MandateOpening>[] {
  const forgery = (label: string, name: string, bytes: Uint8Array, refusal: string) => ({ label, opening: crafted(opening, { [name]: bytes }), refusal: `failed assert: ${refusal}` });
  const atEnds = (label: string, name: string, c: number, refusal: string) => [
    forgery(`${label} first in the ${name}`, name, spliced(opening.segments[name]!, [c]), refusal),
    forgery(`${label} last in the ${name}`, name, endSpliced(opening.segments[name]!, [c]), refusal),
  ];
  const widths: Readonly<Record<string, number>> = CLASSES.openings.mandates[opening.circuit];
  const committee = opening.segments.committeeId!;
  return [
    ...["principalDid", "agentDid"].flatMap(name => [..."0OIl"].flatMap(c => atEnds(c, name, c.charCodeAt(0), "base58"))),
    ...([["a space", 0x20], ["DEL", 0x7f]] as const).flatMap(([label, c]) => atEnds(label, "asset", c, "printable ASCII")),
    ...COMMITTEE_MALFORMED.filter(([, bytes]) => bytes.length <= committee.length)
      .map(([label, bytes]) => forgery(`${label} in the committee id`, "committeeId", spliced(committee, bytes), "well-formed UTF-8")),
    forgery("a truncated lead ending the committee id", "committeeId", withByte(committee, committee.length - 1, 0xe2), "well-formed UTF-8"),
    ...MANDATE_UINT_FIELDS.map(name => (widths[name] === 0
      ? forgery(`a head byte of 24 for the ${name}`, name, Uint8Array.of(24), "cbor head")
      : forgery(`a ${widths[name]}-byte ${name} with a shorter encoding`, name, bigEndianBytes(BELOW_MINIMAL[widths[name]!]!, widths[name]!), "cbor uint not minimal"))),
  ];
}

/** A schema rule's breach that the widths of a class cannot encode, and why. */
export interface Unencodable { readonly label: string; readonly reason: string }

const SHORTEST_ABOVE_23 = "a shortest uint of one or more argument bytes is at least 24";

/**
 * Each schema rule's breach crafted past the codec in the class of `opening`, with C and K re-derived so only the rule
 * can refuse, and each breach the class's uint widths cannot encode. The deny-all breach puts one non-zero byte at each
 * position of the egress root.
 */
export function schemaBreaches(opening: MandateOpening): { forgeries: Forgery<MandateOpening>[]; unencodable: Unencodable[] } {
  const widths: Readonly<Record<string, number>> = CLASSES.openings.mandates[opening.circuit];
  const { segments } = opening;
  const forgeries: Forgery<MandateOpening>[] = [];
  const unencodable: Unencodable[] = [];
  const breach = (label: string, changes: Readonly<Record<string, Uint8Array>>, refusal: string) =>
    forgeries.push({ label, opening: crafted(opening, changes), refusal: `failed assert: ${refusal}` });
  const zero = new Uint8Array(32);
  if (widths.notBefore === widths.notAfter) {
    breach("notBefore equal to notAfter", { notBefore: segments.notAfter! }, "mandate validity window");
    breach("notBefore after notAfter", { notBefore: segments.notAfter!, notAfter: segments.notBefore! }, "mandate validity window");
  } else unencodable.push({ label: "notBefore not below notAfter", reason: "notBefore has the narrower head, so every shortest encoding keeps it below notAfter" });
  if (widths.windowSeconds === 0) breach("a window of 0", { windowSeconds: Uint8Array.of(0) }, "mandate window");
  else unencodable.push({ label: "a window of 0", reason: SHORTEST_ABOVE_23 });
  breach("egress mode 2", { egressMode: Uint8Array.of(2), egressRoot: zero }, "egress mode");
  for (let at = 0; at < 32; at++) breach(`deny-all with root byte ${at} non-zero`, { egressMode: Uint8Array.of(0), egressRoot: withByte(zero, at, 1) }, "deny-all egress root");
  if (widths.threshold === widths.committeeSize) {
    const size = segments.committeeSize!;
    const above = bigEndianBytes(uintOfBigEndian(size) + 1n, size.length);
    breach("a threshold above the committee size", isDeepStrictEqual(segments.threshold, size) ? { threshold: above } : { threshold: size, committeeSize: segments.threshold! }, "mandate disclosure threshold");
  } else unencodable.push({ label: "a threshold above the committee size", reason: "the threshold has the narrower head, so every shortest encoding keeps it below the committee size" });
  if (widths.threshold === 0) breach("a threshold of 0", { threshold: Uint8Array.of(0) }, "mandate disclosure threshold");
  else unencodable.push({ label: "a threshold of 0", reason: SHORTEST_ABOVE_23 });
  return { forgeries, unencodable };
}
