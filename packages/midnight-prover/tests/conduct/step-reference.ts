import { createHash } from "node:crypto";
import {
  ACTION_DIGEST_DOMAIN, actionDigestHex, ALLOWLIST_LEAF_DOMAIN, cborEncode, compareBytes, verdictOf, type CborValue, type GuardAction,
} from "@fluxpointstudios/orynq-sdk-conduct";
import { HASH_DOMAIN_PREFIXES } from "@fluxpointstudios/orynq-sdk-process-trace";
import { CLASSES } from "../../scripts/conduct/template.mjs";
import { realEvent, type Kind } from "./guard-events.js";
import { actionOf, actionValues, EVENT_PREIMAGES, FIXED_WIDTHS, hashOf, LEXICAL, vector, witnessDeclaration, type Input, type Segment } from "./opening-reference.js";
import { MANDATE_ATOMS_DOMAIN } from "./statement-checker.js";

// The Compact text every compiled step class and step probe must hold, written from the S-CONDUCT-STEP statement the
// README declares, the audited value classes and the producers' own bytes, and never from template.mjs's emitter. The
// structure audit parses this text and the generated circuits alike and compares what they read.

interface StepClass { readonly kind: string; readonly lengths: Readonly<Record<string, number>>; readonly cbor: Readonly<Record<string, number>>; readonly depth?: number }

const utf8 = (text: string) => new TextEncoder().encode(text);
const struct = (name: string, fields: readonly (readonly [string, string])[]) => [`export struct ${name} {`, fields.map(([field, type]) => `  ${field}: ${type}`).join(",\n"), "}"];

// S-CONDUCT-STEP: what a step discloses. It carries no leaf index.
const STATEMENT: readonly (readonly [string, string])[] = [
  ["prevRollHex", "Bytes<64>"], ["rollAfter", "Bytes<32>"], ["atoms", "Bytes<32>"], ["windowIndex", "Uint<64>"], ["priorSpent", "Uint<64>"], ["verdict", "Uint<8>"],
  ["dataSeq", "Uint<64>"], ["traceSeq", "Uint<64>"],
];
// The atoms K commits after the padded domain and C, in the order and at the widths mandateAtoms lays them out.
const ATOMS: readonly (readonly [string, string])[] = [
  ["notBefore", "Uint<64>"], ["notAfter", "Uint<64>"], ["assetDigest", "Bytes<32>"], ["capAmount", "Uint<64>"], ["windowSeconds", "Uint<64>"], ["egressMode", "Uint<8>"],
  ["counterpartyRoot", "Bytes<32>"], ["egressRoot", "Bytes<32>"],
];
const WINDOW: readonly (readonly [string, string])[] = [["q", "Uint<64>"], ["r", "Uint<64>"], ["rClock", "Uint<64>"]];
/** The depths the step probes run the path gadget at: lists of up to 2^6 members. */
const PROBE_DEPTHS = [1, 2, 3, 4, 5, 6];
// The least uint of each CBOR head width.
const UINT_AT_WIDTH: Readonly<Record<number, bigint>> = { 0: 1n, 1: 24n, 2: 256n, 4: 65536n, 8: 1n << 32n };
// The verdicts that state a party is on no list: no path shows that, so no class accepts them.
const NON_MEMBERSHIP = [5, 7];
// The decisions the runtime reaches only after the party passed its list, so their classes walk its path.
const READS_MEMBERSHIP: Readonly<Record<string, readonly number[]>> = { payment: [0, 4], egress: [0] };

/** The verdict code the runtime records for a guard event of each kind, from a real event of the kind. */
async function recordedVerdicts(kinds: readonly string[]): Promise<ReadonlyMap<string, number>> {
  const verdicts = new Map<string, number>();
  for (const kind of new Set(kinds)) {
    const { guardEvent } = await realEvent(kind as Kind, "ascii-min");
    verdicts.set(kind, guardEvent.type === "orynq.conduct.guard.denial.v1" ? verdictOf(guardEvent.reason) : 0);
  }
  return verdicts;
}

const STEP_CLASSES: Readonly<Record<string, StepClass>> = CLASSES.steps;
const VERDICTS = await recordedVerdicts(Object.values(STEP_CLASSES).map(c => c.kind));

/**
 * The inputs of the action digest: the codec's own CBOR of an action of the class's dimensions, split at its values. A
 * text is its head and the event's own bytes; a uint in its head byte is that byte, and otherwise its head and the
 * class's argument bytes. The layout is checked against actionDigest.
 */
function actionInputs(action: string, width: (name: string) => number, cbor: Readonly<Record<string, number>>): Input[] {
  const uint = (name: string) => UINT_AT_WIDTH[cbor[name]!]!;
  const fields: (readonly [bigint, string | undefined, CborValue])[] = action === "payment"
    ? [[0n, undefined, "payment"], [1n, "asset", "A".repeat(width("asset"))], [2n, "amount", uint("amount")], [3n, "counterparty", "c".repeat(width("counterparty"))], [4n, "ts", uint("ts")]]
    : [[0n, undefined, "egress"], [1n, "destination", "d".repeat(width("destination"))], [2n, "ts", uint("ts")]];
  const encoded = cborEncode(new Map<CborValue, CborValue>(fields.map(([key, , value]) => [key, value])));
  const inputs: Input[] = [utf8(ACTION_DIGEST_DOMAIN), encoded.subarray(0, 1)];
  const rebuilt = [...encoded.subarray(0, 1)];
  for (const [key, name, value] of fields) {
    const [k, v] = [cborEncode(key), cborEncode(value)];
    rebuilt.push(...k, ...v);
    if (name === undefined) inputs.push(Uint8Array.from([...k, ...v]));
    else if (typeof value === "bigint") {
      if (v.length === 1) inputs.push(k, [`${name}Value as Uint<8>`, "Uint<8>"]);
      else inputs.push(Uint8Array.from([...k, v[0]!]), [`${name}Cbor`, vector(v.length - 1)]);
    } else {
      const payload = utf8(value as string);
      inputs.push(Uint8Array.from([...k, ...v.subarray(0, v.length - payload.length)]), [name, vector(payload.length)]);
    }
  }
  const sample = Object.fromEntries(fields.map(([, name, value]) => [name ?? "kind", value]));
  const guardAction = (action === "payment"
    ? { kind: "payment", asset: sample.asset, amount: sample.amount, counterparty: sample.counterparty, timestamp: sample.ts }
    : { kind: "egress", destination: sample.destination, timestamp: sample.ts }) as GuardAction;
  const digest = createHash("sha256").update(utf8(ACTION_DIGEST_DOMAIN)).update(Uint8Array.from(rebuilt)).digest("hex");
  if (compareBytes(Uint8Array.from(rebuilt), encoded) !== 0 || digest !== actionDigestHex(guardAction)) throw new Error(`the reference layout of a ${action} action differs from the codec's`);
  return inputs;
}

function stepCircuit(id: string, { kind, lengths, cbor, depth }: StepClass): string[] {
  const action = actionOf(kind);
  const verdict = VERDICTS.get(kind)!;
  if (NON_MEMBERSHIP.includes(verdict)) throw new Error(`${id}: a denial ${verdict} states non-membership, which no step class accepts`);
  if (READS_MEMBERSHIP[action]!.includes(verdict) !== (depth !== undefined)) throw new Error(`${id}: a step class walks a membership path exactly when its decision reads one`);
  const values = actionValues(action);
  const widthOf = ({ v, lex }: Segment) => lengths[v] ?? FIXED_WIDTHS[lex]!;
  const widths = new Map(values.map(segment => [segment.v, widthOf(segment)]));
  const width = (name: string) => widths.get(name)!;
  const party = action === "payment" ? "counterparty" : "destination";
  const uints = Object.keys(cbor);
  const preimage = EVENT_PREIMAGES.get(kind)!.map((part): Input => (typeof part === "string" ? [part, vector(width(part))] : part));
  const leafHead = cborEncode("x".repeat(width(party))).subarray(0, -width(party));
  const membership = depth === undefined ? "false" : "memberOk";
  const decide = action === "payment" ? `0, tsValue, amountValue, assetOk, ${membership}, s.priorSpent, false` : `1, tsValue, 0, false, false, s.priorSpent, ${membership}`;
  const body = [
    ...values.map(({ v }) => `const ${v} = ${id}_${v}();`),
    `const eventHash = ${hashOf(preimage)};`,
    `const eventHex = ${id}_eventHex();`,
    "hexOfHash(eventHex, eventHash);",
    `assert(${hashOf([utf8(HASH_DOMAIN_PREFIXES.roll), ["s.prevRollHex", "Bytes<64>"], utf8("|"), ["eventHex", vector(64)]])} == s.rollAfter, "rolling root mismatch");`,
    ...(action === "payment" ? [`const amountValue = decU64<${width("amount")}>(amount);`, 'assert(amountValue != 0, "decimal nonzero");'] : []),
    `const tsValue = decU64<${width("ts")}>(ts);`,
    `const enforcedAtValue = decU64<${width("enforcedAt")}>(enforcedAt);`,
    `assert(decU64<${width("dataSeq")}>(dataSeq) == s.dataSeq, "dataSeq opening");`,
    `assert(dec53<${width("traceSeq")}>(traceSeq) == s.traceSeq, "traceSeq opening");`,
    ...values.flatMap(segment => (LEXICAL[segment.lex] === undefined ? [] : [LEXICAL[segment.lex]!(segment.v, widthOf(segment))])),
    ...uints.flatMap(name => (cbor[name] === 0
      ? [`assert(${name}Value <= 23, "action cbor head");`]
      : [`const ${name}Cbor = ${id}_${name}Cbor();`, `assert(cborUint<${cbor[name]}>(${name}Cbor) == ${name}Value, "action cbor uint");`])),
    `hexOfHash(actionDigest, ${hashOf(actionInputs(action, width, cbor))});`,
    `const commitment = ${id}_commitment();`,
    "hexOfBytes(mandateCommitment, commitment);",
    `const atoms = ${id}_atoms();`,
    `assert(${hashOf([[`pad(32, ${JSON.stringify(MANDATE_ATOMS_DOMAIN)})`, "Bytes<32>"], ["commitment", vector(32)], ...ATOMS.map(([atom, type]): Input => [`atoms.${atom}`, type])])} == s.atoms, "mandate atoms mismatch");`,
    `const window = ${id}_window();`,
    "windowOf(tsValue, enforcedAtValue, atoms.windowSeconds, window.q, window.r, window.rClock);",
    'assert(window.q == s.windowIndex, "window index");',
    ...(action === "payment" ? [`const assetOk = ${hashOf([["asset", vector(width("asset"))]])} == atoms.assetDigest;`] : []),
    ...(depth === undefined ? [] : [
      `const path = ${id}_path();`,
      `const memberOk = allowlistRoot<${depth}>(${hashOf([Uint8Array.from([...utf8(ALLOWLIST_LEAF_DOMAIN), ...leafHead]), [party, vector(width(party))]])}, path) == atoms.${action === "payment" ? "counterpartyRoot" : "egressRoot"};`,
    ]),
    `const verdict = CV_decide(enforcedAtValue, atoms.notBefore, atoms.notAfter, atoms.capAmount, atoms.egressMode, ${decide});`,
    'assert(verdict != 5 && verdict != 7, "non-membership not provable");',
    'assert(verdict == s.verdict, "verdict mismatch");',
    `assert(verdict == ${verdict}, "recorded decision");`,
    "conductStep = disclose(s);",
  ];
  return [
    ...values.map(segment => witnessDeclaration(`${id}_${segment.v}`, widthOf(segment))),
    witnessDeclaration(`${id}_eventHex`, 64),
    ...uints.filter(name => cbor[name]! > 0).map(name => witnessDeclaration(`${id}_${name}Cbor`, cbor[name]!)),
    witnessDeclaration(`${id}_commitment`, 32),
    `witness ${id}_atoms(): MandateAtoms;`,
    `witness ${id}_window(): WindowSplit;`,
    ...(depth === undefined ? [] : [`witness ${id}_path(): Vector<${depth}, PathStep>;`]),
    `export circuit ${id}(s: ConductStep): [] {`,
    ...body.map(line => `  ${line}`),
    "}",
  ];
}

function probeCircuits(): string[] {
  const probes: (readonly [name: string, params: string, returns: string, call: string])[] = [
    ...PROBE_DEPTHS.map(d => [`allowlist_root_d${d}`, `leaf: Bytes<32>, path: Vector<${d}, PathStep>`, "Bytes<32>", `allowlistRoot<${d}>(leaf, path)`] as const),
    ["window_split", "ts: Uint<64>, clock: Uint<64>, w: Uint<64>, q: Uint<64>, r: Uint<64>, rClock: Uint<64>", "[]", "windowOf(ts, clock, w, q, r, rClock)"],
    ["hex_of_bytes", `v: ${vector(64)}, b: ${vector(32)}`, "[]", "hexOfBytes(v, b)"],
  ];
  return probes.flatMap(([name, params, returns, call]) => [`export pure circuit ${name}(${params}): ${returns} {`, `  return ${call};`, "}"]);
}

/** The reference text of every compiled step class in classes.json, with the statement they disclose, and every step probe. */
export function referenceSteps(): string {
  return [
    "pragma language_version 0.23;",
    "import CompactStandardLibrary;",
    'include "gadgets";',
    "import ConductGadgets;",
    'include "verdict_core";',
    "import ConductVerdict prefix CV_;",
    ...struct("ConductStep", STATEMENT), "export ledger conductStep: ConductStep;",
    ...struct("MandateAtoms", ATOMS),
    ...struct("WindowSplit", WINDOW),
    ...Object.entries(STEP_CLASSES).flatMap(([id, stepClass]) => stepCircuit(id, stepClass)),
    ...probeCircuits(),
  ].join("\n");
}
