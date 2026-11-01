import { createHash } from "node:crypto";
import { allowlistLeaf } from "@fluxpointstudios/orynq-sdk-conduct";
import { computeEventHash, updateRollingHash } from "@fluxpointstudios/orynq-sdk-process-trace";
import { classify, eventClass, eventOpening, eventSegments } from "../../scripts/conduct/template.mjs";
import { maxClassEvent, realEvent, type RealEvent } from "./guard-events.js";
import { runLedger } from "./harness.js";

export interface Opening {
  readonly circuit: string;
  readonly kind: string;
  readonly segments: Readonly<Record<string, Uint8Array>>;
  readonly witnesses: Readonly<Record<string, Uint8Array>>;
  readonly statement: Readonly<Record<string, Uint8Array | bigint>>;
}

export const OPENINGS_UNIT = "openings";

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

/** Opens an event in its class through the generated JS and returns the statement its ledger write disclosed. */
export async function runOpening({ circuit, kind, witnesses, statement }: Opening): Promise<unknown> {
  return (await runLedger(OPENINGS_UNIT, circuit, witnessFunctions(witnesses), [statement]))[ledgerCell(kind)];
}

export function openingOf(e: RealEvent): Opening {
  const classified = classify(e.event);
  const circuit = eventClass(classified);
  const segments = eventSegments(classified);
  return { circuit, kind: classified.kind, segments, ...eventOpening(circuit, segments, e.rollBefore) };
}

const sha256 = (bytes: Uint8Array | string) => new Uint8Array(createHash("sha256").update(bytes).digest());
const halves = (hex: string) => [BigInt(`0x${hex.slice(0, 32)}`), BigInt(`0x${hex.slice(32)}`)] as const;

/** The statement an opening of `e` must disclose, computed from the guard event by the product's own functions. */
export async function productStatement(e: RealEvent): Promise<Record<string, Uint8Array | bigint>> {
  const { guardEvent: g, event } = e;
  const roll = await updateRollingHash({ currentHash: e.rollBefore, itemCount: 0 }, await computeEventHash(event));
  const [actionDigestHi, actionDigestLo] = halves(g.actionDigest);
  const [mandateCommitmentHi, mandateCommitmentLo] = halves(g.mandateCommitment);
  const common = {
    prevRollHex: new Uint8Array(Buffer.from(e.rollBefore, "ascii")), rollAfter: new Uint8Array(Buffer.from(roll.currentHash, "hex")),
    timestamp: g.timestamp, enforcedAt: g.enforcedAt, dataSeq: g.seq, traceSeq: BigInt(event.seq),
    actionDigestHi, actionDigestLo, mandateCommitmentHi, mandateCommitmentLo,
  };
  const a = g.action;
  return a.kind === "payment"
    ? { ...common, amount: a.amount, assetDigest: sha256(a.asset), counterpartyLeaf: allowlistLeaf(a.counterparty) }
    : { ...common, destinationLeaf: allowlistLeaf(a.destination) };
}

export const latin1 = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
export const withByte = (bytes: Uint8Array, at: number, value: number) => Uint8Array.from(bytes, (b, i) => (i === at ? value : b));
export const spliced = (bytes: Uint8Array, head: readonly number[]) => Uint8Array.from(bytes, (b, i) => head[i] ?? b);
export const withWitness = (opening: Opening, name: string, bytes: Uint8Array): Opening => ({ ...opening, witnesses: { ...opening.witnesses, [name]: bytes } });

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
