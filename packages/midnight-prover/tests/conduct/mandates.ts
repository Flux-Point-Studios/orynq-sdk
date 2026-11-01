import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAllowlistRoot, decodeMandate, type MandateV1 } from "@fluxpointstudios/orynq-sdk-conduct";
import { classifyMandate, mandateClass, mandateOpening } from "../../scripts/conduct/template.mjs";
import { runLedger } from "./harness.js";
import { OPENINGS_UNIT, witnessFunctions } from "./openings.js";

export interface MandateVector { readonly name: string; readonly cborHex: string; readonly commitmentHex?: string; readonly code?: string }
export const MANDATE_VECTORS: { valid: MandateVector[]; invalid: MandateVector[] } =
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../conduct/tests/fixtures/mandate-vectors.json"), "utf8"));

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_U64 = (1n << 64n) - 1n;

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

export async function runMandateOpening({ circuit, witnesses, statement }: Pick<MandateOpening, "circuit" | "witnesses" | "statement">): Promise<unknown> {
  return (await runLedger(OPENINGS_UNIT, circuit, witnessFunctions(witnesses), [statement])).mandateOpening;
}
