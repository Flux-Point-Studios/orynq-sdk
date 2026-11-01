import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAllowlistRoot, decodeMandate, encodeMandate, hexToBytes, type MandateV1 } from "@fluxpointstudios/orynq-sdk-conduct";
import { classifyMandate, CLASSES, mandateClass, mandateOpening } from "../../scripts/conduct/template.mjs";
import { MAX_U64 } from "./cases.js";
import { runLedger } from "./harness.js";
import { OPENINGS_UNIT, spliced, withByte, witnessFunctions, type Forgery } from "./openings.js";

interface MandateVector { readonly name: string; readonly cborHex: string; readonly commitmentHex?: string; readonly code?: string }
export const MANDATE_VECTORS: { valid: MandateVector[]; invalid: MandateVector[] } =
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../conduct/tests/fixtures/mandate-vectors.json"), "utf8"));

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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
export function stepMandate(egressMode: 0n | 1n = 1n): MandateV1 {
  return {
    schemaVersion: 1n, mandateId: new Uint8Array(16).fill(0x5a), principalDid: "did:key:z6MkhaXgB", agentDid: "did:key:z6MkjchhF",
    didFormatVersion: 0n, spendCap: { asset: "USD", amount: 9n, windowSeconds: 4n },
    counterpartyAllowlistRoot: buildAllowlistRoot(["acme", "beta", "cafe"]),
    egressPolicy: { mode: egressMode, allowlistRoot: egressMode === 1n ? buildAllowlistRoot(["api1", "api2", "api3"]) : new Uint8Array(32) },
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

export interface MandateOpening {
  readonly circuit: string;
  readonly segments: Readonly<Record<string, Uint8Array>>;
  readonly witnesses: Readonly<Record<string, Uint8Array>>;
  readonly statement: Readonly<{ commitment: Uint8Array; atoms: Uint8Array }>;
  readonly atoms: Readonly<Record<string, Uint8Array | bigint>>;
}

export function mandateOpeningOf(cbor: Uint8Array): MandateOpening {
  const classified = classifyMandate(cbor, decodeMandate);
  const circuit = mandateClass(classified);
  return { circuit, segments: classified.segments, ...mandateOpening(circuit, classified.segments) };
}

type Presented = Pick<MandateOpening, "circuit" | "witnesses" | "statement">;

export async function runMandateOpening({ circuit, witnesses, statement }: Presented, unit = OPENINGS_UNIT): Promise<unknown> {
  return (await runLedger(unit, circuit, witnessFunctions(witnesses), [statement])).mandateOpening;
}

/** "accepted", or the message the generated JS of `unit` refused the mandate opening with. */
export const mandateOutcome = (opening: Presented, unit = OPENINGS_UNIT) => runMandateOpening(opening, unit).then(() => "accepted", (error: Error) => error.message);

/**
 * Segments changed past the codec, with C and K re-derived from them, so the commitment and atoms bindings hold and only
 * the circuit's schema rule can refuse.
 */
export function crafted(opening: MandateOpening, changes: Readonly<Record<string, Uint8Array>>): MandateOpening {
  const segments = { ...opening.segments, ...changes };
  return { ...opening, segments, ...mandateOpening(opening.circuit, segments) };
}

const bigEndian = (value: bigint, width: number) => Uint8Array.from({ length: width }, (_, i) => Number((value >> BigInt(8 * (width - 1 - i))) & 0xffn));
// The largest value each argument width encodes that a shorter encoding also holds.
const BELOW_MINIMAL: Readonly<Record<number, bigint>> = { 1: 23n, 2: 255n, 4: 65535n, 8: (1n << 32n) - 1n };
const COMMITTEE_MALFORMED: readonly (readonly [string, readonly number[]])[] = [
  ["a lone continuation byte", [0x80]], ["an overlong", [0xc0, 0xaf]], ["a surrogate", [0xed, 0xa0, 0x80]], ["a lead above F4", [0xf5, 0x80, 0x80, 0x80]],
];

/**
 * In every field a gadget reads, bytes outside its class crafted past the codec, with C and K re-derived, and the assert
 * that refuses them: base58 DIDs, a printable ASCII asset, a well-formed committee id and the shortest uint encodings.
 */
export function fieldForgeries(opening: MandateOpening): Forgery<MandateOpening>[] {
  const forgery = (label: string, name: string, bytes: Uint8Array, refusal: string) => ({ label, opening: crafted(opening, { [name]: bytes }), refusal: `failed assert: ${refusal}` });
  const widths: Readonly<Record<string, number>> = CLASSES.openings.mandates[opening.circuit];
  const committee = opening.segments.committeeId!;
  return [
    ...["principalDid", "agentDid"].flatMap(name => [..."0OIl"].map(c => forgery(`${c} in the ${name}`, name, spliced(opening.segments[name]!, [c.charCodeAt(0)]), "base58"))),
    ...[["a space", 0x20], ["DEL", 0x7f]].map(([label, c]) => forgery(`${label as string} in the asset`, "asset", spliced(opening.segments.asset!, [c as number]), "printable ASCII")),
    ...COMMITTEE_MALFORMED.filter(([, bytes]) => bytes.length <= committee.length)
      .map(([label, bytes]) => forgery(`${label} in the committee id`, "committeeId", spliced(committee, bytes), "well-formed UTF-8")),
    forgery("a truncated lead ending the committee id", "committeeId", withByte(committee, committee.length - 1, 0xe2), "well-formed UTF-8"),
    ...["capAmount", "windowSeconds", "notBefore", "notAfter", "threshold", "committeeSize"].map(name => (widths[name] === 0
      ? forgery(`a head byte of 24 for the ${name}`, name, Uint8Array.of(24), "cbor head")
      : forgery(`a ${widths[name]}-byte ${name} with a shorter encoding`, name, bigEndian(BELOW_MINIMAL[widths[name]!]!, widths[name]!), "cbor uint not minimal"))),
  ];
}
