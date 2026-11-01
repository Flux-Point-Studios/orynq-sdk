import {
  ALLOWLIST_LEAF_DOMAIN, cborEncode, compareBytes, encodeMandate, MANDATE_COMMITMENT_DOMAIN, mandateToCborMap, type CborValue, type MandateV1,
} from "@fluxpointstudios/orynq-sdk-conduct";
import { HASH_DOMAIN_PREFIXES } from "@fluxpointstudios/orynq-sdk-process-trace";
import { CLASSES, render, TEMPLATE } from "../../scripts/conduct/template.mjs";
import { MANDATE_UINT_FIELDS } from "./openings.js";
import { MANDATE_ATOMS_DOMAIN } from "./statement-checker.js";

// The Compact text every compiled opening class must hold, written from the statements the README declares and the
// producers' own bytes, and never from template.mjs's emitter. The structure audit parses this text and the generated
// circuits alike and compares what they read, so its layout need not match the generated file's.

interface Segment { readonly v: string; readonly lex: string; readonly nonzero: boolean }

const utf8 = (text: string) => new TextEncoder().encode(text);
const bytes = (b: Uint8Array) => `[${[...b].join(", ")}]`;
const hashOf = (parts: readonly (Uint8Array | string)[]) =>
  `persistentHash([${parts.filter(p => typeof p === "string" || p.length > 0).map(p => (typeof p === "string" ? p : bytes(p))).join(", ")}])`;
const witnessDeclaration = (name: string, width: number) => `witness ${name}(): Vector<${width}, Uint<8>>;`;

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

/** Each value of a guard event action, once, in the order the template first writes it. */
function actionValues(action: string): Segment[] {
  const seen = new Map<string, Segment>();
  for (const part of TEMPLATE.actions[action] as { v?: string; lex?: string; nonzero?: boolean }[]) {
    if (part.v !== undefined && !seen.has(part.v)) seen.set(part.v, { v: part.v, lex: part.lex!, nonzero: part.nonzero === true });
  }
  return [...seen.values()];
}

const statementType = (action: string) => `${action[0]!.toUpperCase()}${action.slice(1)}Opening`;

function statementStruct(action: string): string[] {
  const fields = [["prevRollHex", "Bytes<64>"], ["rollAfter", "Bytes<32>"]];
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

// The preimage process-trace hashes for an event of `kind`, as constants and value names, from the template's renderer,
// which T-B01 holds to the producer's bytes.
function eventPreimage(kind: string, names: readonly string[]): (Uint8Array | string)[] {
  const mark = "\u0000";
  const text: string = render({ kind, values: Object.fromEntries(names.map(name => [name, `${mark}${name}${mark}`])) });
  return text.split(mark).map((part, i) => (i % 2 === 0 ? utf8(part) : part));
}

function eventCircuit(id: string, kind: string, lengths: Readonly<Record<string, number>>): string[] {
  const action = kind.slice(0, kind.indexOf("-"));
  const values = actionValues(action);
  const width = ({ v, lex }: Segment) => lengths[v] ?? FIXED_WIDTHS[lex]!;
  const body: string[] = [
    ...values.map(({ v }) => `const ${v} = ${id}_${v}();`),
    `const eventHash = ${hashOf(eventPreimage(kind, values.map(({ v }) => v)))};`,
    `const eventHex = ${id}_eventHex();`,
    "hexOfHash(eventHex, eventHash);",
    `assert(${hashOf([utf8(HASH_DOMAIN_PREFIXES.roll), "s.prevRollHex", utf8("|"), "eventHex"])} == s.rollAfter, "rolling root mismatch");`,
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
      body.push(`assert(${hashOf([v])} == s.${field}, "${field} opening");`);
    } else {
      const head = cborEncode("x".repeat(width(segment))).subarray(0, -width(segment));
      body.push(`assert(${hashOf([Uint8Array.from([...utf8(ALLOWLIST_LEAF_DOMAIN), ...head]), v])} == s.${field}, "${field} opening");`);
    }
  }
  for (const segment of values) {
    const check = LEXICAL[segment.lex];
    if (check !== undefined) body.push(check(segment.v, width(segment)));
  }
  body.push(`${action}Opening = disclose(s);`);
  return [
    ...values.map(segment => witnessDeclaration(`${id}_${segment.v}`, width(segment))),
    witnessDeclaration(`${id}_eventHex`, 64),
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
const DID_PREFIX = "did:key:z";
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
  const preimage = [utf8(MANDATE_COMMITMENT_DOMAIN), ...parts.map(part => ("c" in part ? part.c : part.v))];
  const value = (field: string) => (dimensions[field] === 0 ? `cborHeadValue(${field}[0])` : `cborUint<${dimensions[field]}>(${field})`);
  const atoms = [
    `pad(32, ${JSON.stringify(MANDATE_ATOMS_DOMAIN)})`, "commitment", "notBeforeValue", "notAfterValue", hashOf(["asset"]), "capAmountValue",
    "windowSecondsValue", "egressMode[0]", "counterpartyRoot", "egressRoot",
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

/** The reference text of every compiled opening class in classes.json, with the statements they disclose. */
export function referenceOpenings(): string {
  return [
    "pragma language_version 0.23;",
    "import CompactStandardLibrary;",
    'include "gadgets";',
    "import ConductGadgets;",
    ...Object.keys(TEMPLATE.actions).flatMap(statementStruct),
    "export struct MandateOpening {", "  commitment: Bytes<32>,", "  atoms: Bytes<32>", "}", "export ledger mandateOpening: MandateOpening;",
    ...Object.entries(CLASSES.openings.events as Record<string, { kind: string; lengths: Record<string, number> }>).flatMap(([id, { kind, lengths }]) => eventCircuit(id, kind, lengths)),
    ...Object.entries(CLASSES.openings.mandates as Record<string, Record<string, number>>).flatMap(([id, dimensions]) => mandateCircuit(id, dimensions)),
  ].join("\n");
}
