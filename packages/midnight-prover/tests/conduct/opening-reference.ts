import { createHash } from "node:crypto";
import {
  ALLOWLIST_LEAF_DOMAIN, cborEncode, compareBytes, encodeMandate, MANDATE_COMMITMENT_DOMAIN, mandateToCborMap, type CborValue, type MandateV1,
} from "@fluxpointstudios/orynq-sdk-conduct";
import { canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";
import { HASH_DOMAIN_PREFIXES } from "@fluxpointstudios/orynq-sdk-process-trace";
import { CLASSES } from "../../scripts/conduct/template.mjs";
import { KINDS, realEvent } from "./guard-events.js";
import { DID_PREFIX, MANDATE_UINT_FIELDS, VALUE_CLASSES } from "./openings.js";
import { MANDATE_ATOMS_DOMAIN } from "./statement-checker.js";

// The Compact text every compiled opening class and gadget probe must hold, written from the statements the README
// declares, the audited value classes and the producers' own bytes, and never from template.mjs's template, emitter or
// renderer. The structure audit parses this text and the generated circuits alike and compares what they read, so its
// layout need not match the generated file's.

interface Segment { readonly v: string; readonly lex: string; readonly nonzero?: true }

/** A hash input: constant bytes, or an expression with the type the hash lists for it. */
type Input = Uint8Array | readonly [expression: string, type: string];

const utf8 = (text: string) => new TextEncoder().encode(text);
const vector = (width: number) => `Vector<${width}, Uint<8>>`;
const hashOf = (inputs: readonly Input[]) => {
  const typed = inputs.filter(input => !(input instanceof Uint8Array) || input.length > 0)
    .map(input => (input instanceof Uint8Array ? [`[${input.join(", ")}]`, vector(input.length)] as const : input));
  return `persistentHash<[${typed.map(([, type]) => type).join(", ")}]>([${typed.map(([expression]) => expression).join(", ")}])`;
};
const witnessDeclaration = (name: string, width: number) => `witness ${name}(): ${vector(width)};`;

// S-EVENT-OPEN: each value a guard event discloses, with the statement field it is disclosed as and how it is read.
const OPENED: Readonly<Record<string, readonly ["decimal" | "hex" | "digest" | "leaf", string]>> = {
  amount: ["decimal", "amount"], asset: ["digest", "assetDigest"], counterparty: ["leaf", "counterpartyLeaf"], destination: ["leaf", "destinationLeaf"],
  ts: ["decimal", "timestamp"], actionDigest: ["hex", "actionDigest"], enforcedAt: ["decimal", "enforcedAt"],
  mandateCommitment: ["hex", "mandateCommitment"], dataSeq: ["decimal", "dataSeq"], traceSeq: ["decimal", "traceSeq"],
};
const FIXED_WIDTHS: Readonly<Record<string, number>> = { hex64: 64, uuid: 36, iso24: 24 };
// The class check of each value the statement does not already read through a class-enforcing gadget.
const LEXICAL: Readonly<Record<string, (name: string, width: number) => string>> = {
  str: (name, width) => `jsonStr<${width}>(${name});`,
  uuid: name => `uuid(${name});`,
  iso24: name => `iso8601(${name});`,
  vis: (name, width) => `vis${width}(${name});`,
};

const actionOf = (kind: string) => kind.slice(0, kind.indexOf("-"));
const ACTIONS = [...new Set(KINDS.map(actionOf))];

/** Each value of a guard event action with its audited class, once, in the order the producer's preimage first holds it. */
function actionValues(action: string): Segment[] {
  const names = EVENT_PREIMAGES.get(`${action}-action`)!.filter((part): part is string => typeof part === "string");
  return [...new Set(names)].map(v => ({ v, ...VALUE_CLASSES[v]! }));
}

const statementType = (action: string) => `${action[0]!.toUpperCase()}${action.slice(1)}Opening`;

// The rolling-hash fields of every event statement.
const ROLL_FIELDS = { prevRollHex: "Bytes<64>", rollAfter: "Bytes<32>" };

function statementStruct(action: string): string[] {
  const fields = Object.entries(ROLL_FIELDS);
  for (const { v } of actionValues(action)) {
    const opened = OPENED[v];
    if (opened === undefined) continue;
    const [as, field] = opened;
    if (as === "decimal") fields.push([field, "Uint<64>"]);
    else if (as === "hex") fields.push([`${field}Hi`, "Uint<128>"], [`${field}Lo`, "Uint<128>"]);
    else fields.push([field, "Bytes<32>"]);
  }
  const type = statementType(action);
  return [`export struct ${type} {`, fields.map(([name, t]) => `  ${name}: ${t}`).join(",\n"), "}", `export ledger ${action}Opening: ${type};`];
}

// Where a guard event's trace event holds each value the template names.
const VALUE_PATHS: Readonly<Record<string, readonly string[]>> = {
  amount: ["data.action.amount"], asset: ["data.action.asset"], counterparty: ["data.action.counterparty"], destination: ["data.action.destination"],
  ts: ["data.action.timestamp", "data.timestamp"], actionDigest: ["data.actionDigest"], enforcedAt: ["data.enforcedAt"],
  mandateCommitment: ["data.mandateCommitment"], dataSeq: ["data.seq"], id: ["id"], traceSeq: ["seq"], iso: ["timestamp"], vis: ["visibility"],
};
const MARK = "@@";

/**
 * The preimage process-trace hashes for a guard event of each kind, as constants and value names: a real event of the
 * kind with each value replaced by a marker, canonicalized as computeEventHash canonicalizes it and split at the markers.
 * A marker for a number, which canonicalize writes bare, loses the quotes it is written in.
 */
async function eventPreimages(): Promise<ReadonlyMap<string, (Uint8Array | string)[]>> {
  const preimages = new Map<string, (Uint8Array | string)[]>();
  for (const kind of KINDS) {
    const { event } = await realEvent(kind, "ascii-min");
    const { hash, ...body } = event;
    const preimage = `${HASH_DOMAIN_PREFIXES.event}${canonicalize(body)}`;
    if (createHash("sha256").update(preimage, "utf8").digest("hex") !== hash) throw new Error(`the ${kind} event's hash is not the hash of its canonical preimage`);
    const marked = structuredClone(body) as Record<string, unknown>;
    const values = new Map<string, string>();
    const bare: string[] = [];
    for (const [name, paths] of Object.entries(VALUE_PATHS)) {
      for (const path of paths) {
        const keys = path.split(".");
        const holder = keys.slice(0, -1).reduce<Record<string, unknown> | undefined>((at, key) => at?.[key] as Record<string, unknown> | undefined, marked);
        const key = keys.at(-1)!;
        if (holder === undefined || !Object.hasOwn(holder, key)) continue;
        values.set(name, String(holder[key]));
        if (typeof holder[key] === "number") bare.push(name);
        holder[key] = `${MARK}${name}${MARK}`;
      }
    }
    const text = bare.reduce((at, name) => at.replace(JSON.stringify(`${MARK}${name}${MARK}`), `${MARK}${name}${MARK}`), `${HASH_DOMAIN_PREFIXES.event}${canonicalize(marked)}`);
    const parts = text.split(MARK);
    if (parts.map((part, i) => (i % 2 === 0 ? part : values.get(part))).join("") !== preimage) throw new Error(`the markers do not split the ${kind} preimage`);
    preimages.set(kind, parts.map((part, i) => (i % 2 === 0 ? utf8(part) : part)));
  }
  return preimages;
}

const EVENT_PREIMAGES = await eventPreimages();

function eventCircuit(id: string, kind: string, lengths: Readonly<Record<string, number>>): string[] {
  const action = actionOf(kind);
  const values = actionValues(action);
  const width = ({ v, lex }: Segment) => lengths[v] ?? FIXED_WIDTHS[lex]!;
  const widths = new Map(values.map(segment => [segment.v, width(segment)]));
  const preimage = EVENT_PREIMAGES.get(kind)!.map((part): Input => {
    if (typeof part !== "string") return part;
    if (!widths.has(part)) throw new Error(`the ${kind} preimage holds ${part}, which no ${action} value of the template names`);
    return [part, vector(widths.get(part)!)];
  });
  const body: string[] = [
    ...values.map(({ v }) => `const ${v} = ${id}_${v}();`),
    `const eventHash = ${hashOf(preimage)};`,
    `const eventHex = ${id}_eventHex();`,
    "hexOfHash(eventHex, eventHash);",
    `assert(${hashOf([utf8(HASH_DOMAIN_PREFIXES.roll), ["s.prevRollHex", ROLL_FIELDS.prevRollHex], utf8("|"), ["eventHex", vector(FIXED_WIDTHS.hex64!)]])} == s.rollAfter, "rolling root mismatch");`,
  ];
  for (const segment of values) {
    const opened = OPENED[segment.v];
    if (opened === undefined) continue;
    const [as, field] = opened;
    const { v } = segment;
    if (as === "decimal") {
      body.push(`assert(${segment.lex === "dec53" ? "dec53" : "decU64"}<${width(segment)}>(${v}) == s.${field}, "${field} opening");`);
      if (segment.nonzero) body.push(`assert(s.${field} != 0, "decimal nonzero");`);
    } else if (as === "hex") {
      body.push(`const ${v}Halves = hexHalves(${v});`,
        `assert(${v}Halves[0] == (s.${field}Hi as Field) && ${v}Halves[1] == (s.${field}Lo as Field), "${field} opening");`);
    } else if (as === "digest") {
      body.push(`assert(${hashOf([[v, vector(width(segment))]])} == s.${field}, "${field} opening");`);
    } else {
      const head = cborEncode("x".repeat(width(segment))).subarray(0, -width(segment));
      body.push(`assert(${hashOf([Uint8Array.from([...utf8(ALLOWLIST_LEAF_DOMAIN), ...head]), [v, vector(width(segment))]])} == s.${field}, "${field} opening");`);
    }
  }
  for (const segment of values) {
    const check = LEXICAL[segment.lex];
    if (check !== undefined) body.push(check(segment.v, width(segment)));
  }
  body.push(`${action}Opening = disclose(s);`);
  return [
    ...values.map(segment => witnessDeclaration(`${id}_${segment.v}`, width(segment))),
    witnessDeclaration(`${id}_eventHex`, FIXED_WIDTHS.hex64!),
    `export circuit ${id}(s: ${statementType(action)}): [] {`,
    ...body.map(line => `  ${line}`),
    "}",
  ];
}

// The mandate CDDL's fields that a mandate opening reads, by their key path; every other value is a constant.
const MANDATE_FIELDS: Readonly<Record<string, string>> = {
  "1": "mandateId", "2": "principalDid", "3": "agentDid", "5.0": "asset", "5.1": "capAmount", "5.2": "windowSeconds", "6": "counterpartyRoot",
  "7.0": "egressMode", "7.1": "egressRoot", "8": "measurementRoot", "9.0": "notBefore", "9.1": "notAfter", "10.0": "committeeId",
  "10.1": "threshold", "10.2": "committeeSize",
};
const DIDS = ["principalDid", "agentDid"];
const UINT_AT_WIDTH: Readonly<Record<number, bigint>> = { 0: 1n, 1: 24n, 2: 256n, 4: 65536n, 8: 1n << 32n };

/** A valid mandate of a class's dimensions: each text of its length and each uint the least value of its head width. */
function classMandate(d: Readonly<Record<string, number>>): MandateV1 {
  const uint = (field: string) => UINT_AT_WIDTH[d[field]!]!;
  return {
    schemaVersion: 1n, mandateId: new Uint8Array(16).fill(1), principalDid: `${DID_PREFIX}${"1".repeat(d.principalDid! - DID_PREFIX.length)}`,
    agentDid: `${DID_PREFIX}${"2".repeat(d.agentDid! - DID_PREFIX.length)}`, didFormatVersion: 0n,
    spendCap: { asset: "A".repeat(d.asset!), amount: uint("capAmount"), windowSeconds: uint("windowSeconds") },
    counterpartyAllowlistRoot: new Uint8Array(32).fill(2), egressPolicy: { mode: 1n, allowlistRoot: new Uint8Array(32).fill(3) },
    approvedMeasurementSetRoot: new Uint8Array(32).fill(4), validityWindow: { notBefore: uint("notBefore"), notAfter: uint("notAfter") + 1n },
    disclosurePolicy: { committeeId: "c".repeat(d.committeeId!), threshold: uint("threshold"), committeeSize: uint("committeeSize") },
  };
}

type Part = { readonly c: Uint8Array } | { readonly v: string; readonly bytes: Uint8Array };

// The codec's own encoding of `value` as constants and the fields a mandate opening reads: a text's or byte string's
// head (and a DID's did:key:z) is a constant; a uint in its head byte is a field of that byte, and otherwise its
// argument bytes are.
function cborParts(value: CborValue, path: string, parts: Part[]): void {
  const encoded = cborEncode(value);
  const name = MANDATE_FIELDS[path];
  if (value instanceof Map) {
    const entries = [...value].map(([key, item]) => ({ key, item, encodedKey: cborEncode(key) })).sort((a, b) => compareBytes(a.encodedKey, b.encodedKey));
    const body = entries.reduce((n, { encodedKey, item }) => n + encodedKey.length + cborEncode(item).length, 0);
    parts.push({ c: encoded.subarray(0, encoded.length - body) });
    for (const { key, item, encodedKey } of entries) {
      parts.push({ c: encodedKey });
      cborParts(item, path === "" ? String(key) : `${path}.${String(key)}`, parts);
    }
  } else if (name === undefined) {
    parts.push({ c: encoded });
  } else if (typeof value === "bigint") {
    if (encoded.length === 1) parts.push({ v: name, bytes: encoded });
    else parts.push({ c: encoded.subarray(0, 1) }, { v: name, bytes: encoded.subarray(1) });
  } else {
    const payload = value instanceof Uint8Array ? value : utf8(value as string);
    const prefix = DIDS.includes(name) ? DID_PREFIX.length : 0;
    parts.push({ c: encoded.subarray(0, encoded.length - payload.length + prefix) }, { v: name, bytes: payload.subarray(prefix) });
  }
}

function mandateCircuit(id: string, dimensions: Readonly<Record<string, number>>): string[] {
  const m = classMandate(dimensions);
  const parts: Part[] = [];
  cborParts(mandateToCborMap(m), "", parts);
  const rebuilt = Uint8Array.from(parts.flatMap(part => [...("c" in part ? part.c : part.bytes)]));
  if (compareBytes(rebuilt, encodeMandate(m)) !== 0) throw new Error(`the reference layout of ${id} differs from the codec's encoding`);
  const fields = parts.filter((part): part is Extract<Part, { v: string }> => "v" in part);
  const width = (field: string) => fields.find(f => f.v === field)!.bytes.length;
  const preimage = [utf8(MANDATE_COMMITMENT_DOMAIN), ...parts.map((part): Input => ("c" in part ? part.c : [part.v, vector(part.bytes.length)]))];
  const value = (field: string) => (dimensions[field] === 0 ? `cborHeadValue(${field}[0])` : `cborUint<${dimensions[field]}>(${field})`);
  // K's inputs as mandateAtoms lays them out: the padded domain and C, each uint at 64 bits, the asset's hash, the mode
  // byte and the two roots.
  const atoms: Input[] = [
    [`pad(32, ${JSON.stringify(MANDATE_ATOMS_DOMAIN)})`, "Bytes<32>"], ["commitment", "Bytes<32>"], ["notBeforeValue", "Uint<64>"], ["notAfterValue", "Uint<64>"],
    [hashOf([["asset", vector(width("asset"))]]), "Bytes<32>"], ["capAmountValue", "Uint<64>"], ["windowSecondsValue", "Uint<64>"], ["egressMode[0]", "Uint<8>"],
    ["counterpartyRoot", vector(width("counterpartyRoot"))], ["egressRoot", vector(width("egressRoot"))],
  ];
  const body = [
    ...fields.map(({ v }) => `const ${v} = ${id}_${v}();`),
    `const commitment = ${hashOf(preimage)};`,
    'assert(commitment == s.commitment, "mandate commitment opening");',
    ...MANDATE_UINT_FIELDS.map(field => `const ${field}Value = ${value(field)};`),
    `assert(${hashOf(atoms)} == s.atoms, "mandate atoms opening");`,
    ...DIDS.map(did => `base58<${width(did)}>(${did});`),
    `asciiPrint<${width("asset")}>(asset);`,
    'assert(windowSecondsValue >= 1, "mandate window");',
    'assert(egressMode[0] <= 1, "egress mode");',
    "for (const b of egressRoot) {",
    '  assert(egressMode[0] == 1 || b == 0, "deny-all egress root");',
    "}",
    'assert(notBeforeValue < notAfterValue, "mandate validity window");',
    `utf8Any<${width("committeeId")}>(committeeId);`,
    'assert(thresholdValue >= 1 && thresholdValue <= committeeSizeValue, "mandate disclosure threshold");',
    "mandateOpening = disclose(s);",
  ];
  return [
    ...fields.map(({ v }) => witnessDeclaration(`${id}_${v}`, width(v))),
    `export circuit ${id}(s: MandateOpening): [] {`,
    ...body.map(line => `  ${line}`),
    "}",
  ];
}

const EVENT_CLASSES: Readonly<Record<string, { kind: string; lengths: Record<string, number> }>> = CLASSES.openings.events;

// The widths the event classes read the values of the given decimal classes at.
const decimalWidths = (...lexes: readonly string[]) => [...new Set(Object.values(EVENT_CLASSES).flatMap(({ kind, lengths }) =>
  actionValues(actionOf(kind)).filter(({ lex }) => lexes.includes(lex)).map(({ v }) => lengths[v]!)))].sort((a, b) => a - b);

/**
 * The pure probe T-B18 runs each gadget through: each CBOR uint head width, the string gadgets at one to four bytes,
 * decU64 at every width a class reads a decimal at (dec53 reads through it at its own width), dec53 at every width a
 * class reads a trace sequence at, and each fixed-shape gadget.
 */
function probeCircuits(): string[] {
  const bytes = (width: number) => `v: ${vector(width)}`;
  const probes: (readonly [name: string, params: string, returns: string, call: string])[] = [
    ...Object.keys(UINT_AT_WIDTH).map(Number).map(w => (w === 0
      ? ["cbor_uint_w0", "head: Uint<8>", "Uint<64>", "cborHeadValue(head)"] as const
      : [`cbor_uint_w${w}`, bytes(w), "Uint<64>", `cborUint<${w}>(v)`] as const)),
    ...[1, 2, 3, 4].flatMap(n => [[`json_str_w${n}`, bytes(n), "[]", `jsonStr<${n}>(v)`], [`utf8_any_w${n}`, bytes(n), "[]", `utf8Any<${n}>(v)`]] as const),
    ...decimalWidths("dec64", "dec53").map(n => [`dec_u64_w${n}`, bytes(n), "Uint<64>", `decU64<${n}>(v)`] as const),
    ...decimalWidths("dec53").map(n => [`dec53_w${n}`, bytes(n), "Uint<64>", `dec53<${n}>(v)`] as const),
    ["hex_halves", bytes(FIXED_WIDTHS.hex64!), "[Field, Field]", "hexHalves(v)"],
    ["hex_of_hash", `${bytes(FIXED_WIDTHS.hex64!)}, hash: Bytes<32>`, "[]", "hexOfHash(v, hash)"],
    ["uuid_shape", bytes(FIXED_WIDTHS.uuid!), "[]", "uuid(v)"],
    ["iso8601_shape", bytes(FIXED_WIDTHS.iso24!), "[]", "iso8601(v)"],
    ["vis6_shape", bytes(6), "[]", "vis6(v)"],
    ["vis7_shape", bytes(7), "[]", "vis7(v)"],
    ["base58_w1", bytes(1), "[]", "base58<1>(v)"],
    ["ascii_print_w1", bytes(1), "[]", "asciiPrint<1>(v)"],
  ];
  return probes.flatMap(([name, params, returns, call]) => [`export pure circuit ${name}(${params}): ${returns} {`, `  return ${call};`, "}"]);
}

/** The reference text of every compiled opening class in classes.json, with the statements they disclose, and every gadget probe. */
export function referenceOpenings(): string {
  return [
    "pragma language_version 0.23;",
    "import CompactStandardLibrary;",
    'include "gadgets";',
    "import ConductGadgets;",
    ...ACTIONS.flatMap(statementStruct),
    "export struct MandateOpening {", "  commitment: Bytes<32>,", "  atoms: Bytes<32>", "}", "export ledger mandateOpening: MandateOpening;",
    ...Object.entries(EVENT_CLASSES).flatMap(([id, { kind, lengths }]) => eventCircuit(id, kind, lengths)),
    ...Object.entries(CLASSES.openings.mandates as Record<string, Record<string, number>>).flatMap(([id, dimensions]) => mandateCircuit(id, dimensions)),
    ...probeCircuits(),
  ].join("\n");
}
