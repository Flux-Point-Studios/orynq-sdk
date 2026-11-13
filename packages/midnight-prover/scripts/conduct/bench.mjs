// The bench circuits of the conduct prototype: variants of the compiled opening and step circuits, and the option B
// circuits over process-trace's existing span tree. compile-conduct --units bench writes them from
// bench/conduct/bench.json into conduct-managed/bench/<group>/ and pins their sizes; they are measured, never deployed,
// and never committed. Most are text edits of a generated class, so each differs from it only by the edit it names.
// Build-order rule: node builtins and template.mjs only.
import { createHash } from "node:crypto";
import {
  allowlistPath, CLASSES, emitOpenings, emitSteps, eventOpening, mandateClass, mandateOpening, mandateSegments, stepActionDigest, valueSpecs,
} from "./template.mjs";

/** The committed sources a bench group includes beside its generated file. */
export const BENCH_INCLUDES = ["gadgets.compact", "verdict_core.compact"];

const utf8 = text => new TextEncoder().encode(text);
const sha256 = (...parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
const hexOf = bytes => Buffer.from(bytes).toString("hex");
const vector = n => `Vector<${n}, Uint<8>>`;

// `find` replaced where it occurs exactly once: an edit that no longer applies fails the build.
function once(text, find, replace) {
  const parts = text.split(find);
  if (parts.length !== 2) throw new Error(`bench edit applies ${parts.length - 1} times, not once: ${String(find).slice(0, 80)}`);
  return parts.join(replace);
}
const matchOnce = (text, pattern) => {
  const found = text.match(new RegExp(pattern.source, "g")) ?? [];
  if (found.length !== 1) throw new Error(`bench pattern matches ${found.length} times, not once: ${pattern.source.slice(0, 80)}`);
  return found[0];
};

// A generated file's declarations before its first class, and one class of it: its witnesses and its circuit.
const preamble = text => text.slice(0, text.indexOf("witness "));
function section(text, id) {
  const from = text.indexOf(`witness ${id}_`);
  const head = text.indexOf(`export circuit ${id}(`, from);
  if (from < 0 || head < 0) throw new Error(`no generated class ${id}`);
  return text.slice(from, text.indexOf("\n}\n", head) + 3);
}
const renamed = (text, id, name) => section(text, id).replaceAll(id, name);
const NOTE = "// Generated from bench/conduct/bench.json by scripts/compile-conduct.mjs --units bench. Measured, never deployed.\n";
const generatedNote = /^\/\/ Generated[^\n]*\n/;
const benchPreamble = text => preamble(text).replace(generatedNote, NOTE);

/**
 * The source of a contract that holds one class of the openings or steps unit alone, written by the unit's own
 * generator: its declarations and that class. A measurement run keys it and requires its ZKIR to equal the unit's.
 * @param {"openings" | "steps"} unit
 * @param {string} id
 * @returns {string}
 */
export function oneCircuitSource(unit, id) {
  const text = unit === "openings" ? emitOpenings() : emitSteps();
  return `${preamble(text)}${section(text, id)}`;
}

const ROLL_ASSERT = '  assert(persistentHash<[Bytes<18>, Bytes<64>, Bytes<1>, Vector<64, Uint<8>>]>(["poi-trace:roll:v1|", s.prevRollHex, "|", eventHex]) == s.rollAfter, "rolling root mismatch");\n';
const ROLL_FIELDS = "  prevRollHex: Bytes<64>,\n  rollAfter: Bytes<32>,\n";
// The payment statement of the openings with its rolling fields replaced, under another name and ledger cell.
function paymentStruct(openings, name, cell, fields) {
  const struct = matchOnce(openings, /export struct PaymentOpening \{[^}]*\}\n/);
  return `${once(once(struct, "PaymentOpening", name), ROLL_FIELDS, fields)}export ledger ${cell}: ${name};\n\n`;
}
const HEADER = `${NOTE}pragma language_version 0.23;\nimport CompactStandardLibrary;\ninclude "gadgets";\nimport ConductGadgets;\n\n`;
const WALK = [
  "export struct WalkOpening {\n  root: Bytes<32>\n}\nexport ledger walkOpening: WalkOpening;\n",
  "struct WalkStep {\n  right: Boolean,\n  sib: Bytes<32>\n}\n",
  // PoAC's shape: one hash on each branch, so two per level in the circuit.
  "circuit walkIfElse(cur: Bytes<32>, step: WalkStep): Bytes<32> {\n  if (step.right) {\n    return persistentHash<Vector<2, Bytes<32>>>([cur, step.sib]);\n  } else {\n    return persistentHash<Vector<2, Bytes<32>>>([step.sib, cur]);\n  }\n}\n",
  "circuit walkSelect(cur: Bytes<32>, step: WalkStep): Bytes<32> {\n  return persistentHash<Vector<2, Bytes<32>>>([step.right ? cur : step.sib, step.right ? step.sib : cur]);\n}\n",
].join("\n");

const nested = (n, pick) => Array.from({ length: n }, (_, i) => i + 1).reduceRight((rest, i) => (rest === undefined ? pick(i) : `len == ${i} ? ${pick(i)} : (${rest})`), undefined);

/** The name of the option B circuit for a tree of `depth` levels and a span and trace sequence of `digits` digits. */
export const spanCircuit = (depth, digits) => `b_span_d${depth}_s${digits}`;
const SPAN_HEAD = ['poi-trace:span:v1|{"childSpanIds":[],"durationMs":', ',"endedAt":"', '","eventIds":["', '"],"id":"', '","name":"guard","spanSeq":', ',"startedAt":"', '","status":"completed","visibility":"private"}|'];
const SPAN_VALUES = ["durationMs", "endedAt", "id", "spanId", "spanSeq", "startedAt", "eventHex"];
const literal = text => ({ type: `Bytes<${utf8(text).length}>`, value: JSON.stringify(text) });
const hashOf = parts => `persistentHash<[${parts.map(p => p.type).join(", ")}]>([${parts.map(p => p.value).join(", ")}])`;

// Option B over the existing tree: the event opening, the canonical preimage of a closed span that holds exactly that
// event, the span's leaf, and the hex-chained walk to the root. The root commits no leaf count and the walk reads no
// index, which the span tests pin.
function spanSection(openings, name, { depth, digits }) {
  let s = renamed(openings, "ev_pa_ascii_min", name);
  if (digits !== 1) {
    s = once(s, `witness ${name}_traceSeq(): ${vector(1)};`, `witness ${name}_traceSeq(): ${vector(digits)};`);
    s = once(s, `Bytes<24>, ${vector(1)}, Bytes<14>`, `Bytes<24>, ${vector(digits)}, Bytes<14>`);
    s = once(s, "dec53<1>(traceSeq)", `dec53<${digits}>(traceSeq)`);
  }
  const widths = { durationMs: 1, endedAt: 24, id: 36, spanId: 36, spanSeq: digits, startedAt: 24, eventHex: 64 };
  const own = ["spanId", "spanSeq", "startedAt", "endedAt", "durationMs", "spanHex"];
  const witnesses = [
    ...own.map(w => `witness ${name}_${w}(): ${vector(widths[w] ?? 64)};`),
    ...(depth === 0 ? [] : [`witness ${name}_nodeHex(): Vector<${depth}, ${vector(64)}>;`, `witness ${name}_sibs(): Vector<${depth}, ${vector(64)}>;`, `witness ${name}_dirs(): Vector<${depth}, Boolean>;`]),
  ];
  s = once(s, `witness ${name}_eventHex(): ${vector(64)};\n`, `witness ${name}_eventHex(): ${vector(64)};\n${witnesses.join("\n")}\n`);
  const span = SPAN_HEAD.flatMap((text, i) => [literal(text), { type: vector(widths[SPAN_VALUES[i]]), value: SPAN_VALUES[i] }]);
  const walk = [
    ...own.map(w => `const ${w} = ${name}_${w}();`),
    `const spanHash = ${hashOf(span)};`,
    "hexOfHash(spanHex, spanHash);",
    `const node0 = ${hashOf([literal("poi-trace:leaf:v1|"), { type: vector(64), value: "spanHex" }])};`,
    ...(depth === 0 ? [] : [`const nodeHex = ${name}_nodeHex();`, `const sibs = ${name}_sibs();`, `const dirs = ${name}_dirs();`]),
    ...Array.from({ length: depth }, (_, i) => [
      `hexOfHash(nodeHex[${i}], node${i});`,
      `const node${i + 1} = ${hashOf([literal("poi-trace:node:v1|"), { type: vector(64), value: `dirs[${i}] ? nodeHex[${i}] : sibs[${i}]` }, literal("|"), { type: vector(64), value: `dirs[${i}] ? sibs[${i}] : nodeHex[${i}]` }])};`,
    ]).flat(),
    `assert(node${depth} == s.root, "span root mismatch");`,
    'assert(decU64<1>(durationMs) <= 9, "span duration");',
    `assert(dec53<${digits}>(spanSeq) < 9007199254740992, "span sequence");`,
    "uuid(spanId);",
    "iso8601(startedAt);",
    "iso8601(endedAt);",
  ];
  s = once(s, ROLL_ASSERT, `${walk.map(line => `  ${line}\n`).join("")}`);
  s = once(s, "(s: PaymentOpening)", "(s: SpanOpening)");
  return once(s, "paymentOpening = disclose(s);", "spanOpening = disclose(s);");
}

// The fixed-width candidate encoding, with digests in place of identifiers: every decimal but the trace sequence zero-padded to 20 digits, and the
// asset and counterparty as 64 hex digits of a digest. Synthetic: no producer writes it.
const V2_PARTS = [
  ['poi-trace:event:v2|{"data":{"action":{"amount":"', "amount", 20], ['","asset":"', "asset", 64], ['","counterparty":"', "counterparty", 64],
  ['","kind":"payment","timestamp":"', "ts", 20], ['"},"actionDigest":"', "actionDigest", 64], ['","actionKind":"payment","enforcedAt":"', "enforcedAt", 20],
  ['","mandateCommitment":"', "mandateCommitment", 64], ['","seq":"', "dataSeq", 20], ['","timestamp":"', "ts", 20],
  ['","type":"orynq.conduct.guard.action.v2"},"eventType":"orynq.conduct.guard.v2","id":"', "id", 36], ['","kind":"custom","seq":', "traceSeq", 1],
  [',"timestamp":"', "iso", 24], ['","visibility":"', "vis", 7],
];
const V2_TAIL = '"}';
const V2_DECIMALS = ["amount", "ts", "enforcedAt", "dataSeq"];
const V2_HEX = ["asset", "counterparty", "actionDigest", "mandateCommitment"];
const v2Values = () => [...new Map(V2_PARTS.map(([, name, width]) => [name, width]))];
function v2Source(name) {
  const fields = [
    ["prevRollHex", "Bytes<64>"], ["rollAfter", "Bytes<32>"], ...V2_DECIMALS.map(d => [d, "Uint<64>"]), ["traceSeq", "Uint<64>"],
    ...V2_HEX.flatMap(h => [[`${h}Hi`, "Uint<128>"], [`${h}Lo`, "Uint<128>"]]),
  ];
  const body = [
    ...v2Values().map(([value]) => `const ${value} = ${name}_${value}();`),
    `const eventHash = ${hashOf([...V2_PARTS.flatMap(([text, value, width]) => [literal(text), { type: vector(width), value }]), literal(V2_TAIL)])};`,
    `const eventHex = ${name}_eventHex();`,
    "hexOfHash(eventHex, eventHash);",
    ROLL_ASSERT.trim(),
    ...V2_DECIMALS.map(d => `assert(decPad20(${d}) == s.${d}, "${d} opening");`),
    'assert(s.amount != 0, "decimal nonzero");',
    'assert(dec53<1>(traceSeq) == s.traceSeq, "traceSeq opening");',
    ...V2_HEX.flatMap(h => [`const ${h}Halves = hexHalves(${h});`, `assert(${h}Halves[0] == (s.${h}Hi as Field) && ${h}Halves[1] == (s.${h}Lo as Field), "${h} opening");`]),
    "uuid(id);", "iso8601(iso);", "vis7(vis);",
    "v2Opening = disclose(s);",
  ];
  return [
    HEADER,
    `export struct V2Opening {\n${fields.map(([field, type]) => `  ${field}: ${type}`).join(",\n")}\n}\nexport ledger v2Opening: V2Opening;\n`,
    "// Twenty digits, zero-padded; the cast to Uint<64> refuses 2^64 and above.",
    'circuit decPad20(ds: Vector<20, Uint<8>>): Uint<64> {\n  for (const c of ds) {\n    assert(c >= 48 && c <= 57, "decimal digit");\n  }\n  return fold((acc, c) => acc * 10 + (c as Field) - 48, 0 as Field, ds) as Uint<64>;\n}\n',
    ...v2Values().map(([value, width]) => `witness ${name}_${value}(): ${vector(width)};`),
    `witness ${name}_eventHex(): ${vector(64)};`,
    "",
    `export circuit ${name}(s: V2Opening): [] {`,
    ...body.map(line => `  ${line}`),
    "}",
    "",
  ].join("\n");
}

const EMIT = {
  // A-pub: the event hash is disclosed and no rolling step is taken in the circuit.
  pub(circuits) {
    const openings = emitOpenings();
    return [HEADER, paymentStruct(openings, "PubOpening", "pubOpening", "  eventHash: Bytes<32>,\n"), ...Object.entries(circuits).map(([name, spec]) => {
      let s = renamed(openings, spec.class, name);
      s = once(s, `witness ${name}_eventHex(): ${vector(64)};\n`, "");
      s = once(s, `  const eventHex = ${name}_eventHex();\n  hexOfHash(eventHex, eventHash);\n`, "");
      s = once(s, ROLL_ASSERT, '  assert(eventHash == s.eventHash, "event hash opening");\n');
      s = once(s, "(s: PaymentOpening)", "(s: PubOpening)");
      return `${once(s, "paymentOpening = disclose(s);", "pubOpening = disclose(s);")}\n`;
    })].join("");
  },
  // L-hash: the hex of the event hash is tied to it by a hash of the decoded bytes instead of unpacking the hash.
  lhash(circuits) {
    const openings = emitOpenings();
    return [benchPreamble(openings), ...Object.entries(circuits).map(([name, spec]) => {
      let s = renamed(openings, spec.class, name);
      s = once(s, `witness ${name}_eventHex(): ${vector(64)};\n`, `witness ${name}_eventHex(): ${vector(64)};\nwitness ${name}_eventBytes(): ${vector(32)};\n`);
      return `${once(s, "  hexOfHash(eventHex, eventHash);\n", [
        `  const eventBytes = ${name}_eventBytes();`, "  hexOfBytes(eventHex, eventBytes);",
        `  assert(persistentHash<[${vector(32)}]>([eventBytes]) == persistentHash<[Bytes<32>]>([eventHash]), "hash link");`, "",
      ].join("\n"))}\n`;
    })].join("");
  },
  // A-inline: a step and the opening of its mandate in one circuit, welded on K inside it.
  inline(circuits) {
    const [steps, openings] = [emitSteps(), emitOpenings()];
    const mandate = matchOnce(openings, /export struct MandateOpening \{[^}]*\}\nexport ledger mandateOpening: MandateOpening;\n/);
    const parts = [benchPreamble(steps), `${mandate}\n`];
    for (const [name, spec] of Object.entries(circuits)) {
      parts.push(`${once(section(steps, spec.step), `export circuit ${spec.step}(`, `circuit ${spec.step}(`)}\n`);
      parts.push(`${once(section(openings, spec.mandate), `export circuit ${spec.mandate}(`, `circuit ${spec.mandate}(`)}\n`);
      parts.push(`export circuit ${name}(s: ConductStep, m: MandateOpening): [] {\n  ${spec.mandate}(m);\n  ${spec.step}(s);\n  assert(s.atoms == m.atoms, "mandate weld");\n}\n\n`);
    }
    return parts.join("");
  },
  // AD-lex: the action digest is opened only as lowercase hex and never recomputed.
  adlex(circuits) {
    const steps = emitSteps();
    return [benchPreamble(steps), ...Object.entries(circuits).map(([name, spec]) => {
      let s = renamed(steps, spec.step, name);
      s = once(s, '  assert(amountValue <= 23, "action cbor head");\n', "");
      s = once(s, '  assert(tsValue <= 23, "action cbor head");\n', "");
      return `${once(s, matchOnce(s, /  hexOfHash\(actionDigest, [^\n]*\n/), "  const actionDigestHalves = hexHalves(actionDigest);\n")}\n`;
    })].join("");
  },
  // AL: membership of a 4-byte party at each depth.
  allowlist(circuits) {
    return [HEADER, "export struct AllowlistOpening {\n  root: Bytes<32>\n}\nexport ledger allowlistOpening: AllowlistOpening;\n\n", ...Object.entries(circuits).map(([name, { depth }]) => [
      `witness ${name}_member(): ${vector(4)};`, `witness ${name}_path(): Vector<${depth}, PathStep>;`, "",
      `export circuit ${name}(s: AllowlistOpening): [] {`,
      `  const member = ${name}_member();`, `  const path = ${name}_path();`, "  jsonStr<4>(member);",
      `  assert(allowlistRoot<${depth}>(persistentHash<[Bytes<33>, ${vector(4)}]>(["orynq:conduct:allowlist:leaf:v1|d", member]), path) == s.root, "allowlist root mismatch");`,
      "  allowlistOpening = disclose(s);", "}", "", "",
    ].join("\n"))].join("");
  },
  // W: one circuit for amounts of 1 to N digits, with one event hash per length and a selector.
  window(circuits) {
    const openings = emitOpenings();
    return [benchPreamble(openings), ...Object.entries(circuits).map(([name, { lengths }]) => {
      const each = make => Array.from({ length: lengths }, (_, i) => make(i + 1));
      let s = renamed(openings, "ev_pa_ascii_min", name);
      s = once(s, `witness ${name}_amount(): ${vector(1)};\n`, `${each(i => `witness ${name}_amount${i}(): ${vector(i)};`).join("\n")}\nwitness ${name}_len(): Uint<8>;\n`);
      s = once(s, `  const amount = ${name}_amount();\n`, [
        ...each(i => `  const amount${i} = ${name}_amount${i}();`), `  const len = ${name}_len();`, `  assert(len >= 1 && len <= ${lengths}, "amount length");`, "",
      ].join("\n"));
      const hash = matchOnce(s, /  const eventHash = [^\n]*\n/);
      const hashes = each(i => once(once(once(hash, "const eventHash =", `const eventHash${i} =`), `Bytes<48>, ${vector(1)}`, `Bytes<48>, ${vector(i)}`), '\\"amount\\":\\"", amount, ', `\\"amount\\":\\"", amount${i}, `));
      s = once(s, hash, `${hashes.join("")}  const eventHash = ${nested(lengths, i => `eventHash${i}`)};\n`);
      return `${once(s, '  assert(decU64<1>(amount) == s.amount, "amount opening");\n', `  assert((${nested(lengths, i => `decU64<${i}>(amount${i})`)}) == s.amount, "amount opening");\n`)}\n`;
    })].join("");
  },
  v2(circuits) {
    const names = Object.keys(circuits);
    if (names.length !== 1) throw new Error("the v2 group holds one circuit");
    return v2Source(names[0]);
  },
  span(circuits) {
    const openings = emitOpenings();
    return [HEADER, paymentStruct(openings, "SpanOpening", "spanOpening", "  root: Bytes<32>,\n"), ...Object.entries(circuits).map(([name, spec]) => `${spanSection(openings, name, spec)}\n`)].join("");
  },
  // B2: PoAC's persistentHash walk with a hash on each branch, and the same walk with one hash after a select.
  poacwalk(circuits) {
    return [HEADER, WALK, "\n", ...Object.entries(circuits).map(([name, { depth, style }]) => [
      `witness ${name}_leaf(): Bytes<32>;`, `witness ${name}_path(): Vector<${depth}, WalkStep>;`, "",
      `export circuit ${name}(s: WalkOpening): [] {`,
      `  assert(fold(${style === "ifelse" ? "walkIfElse" : "walkSelect"}, ${name}_leaf(), ${name}_path()) == s.root, "walk root mismatch");`,
      "  walkOpening = disclose(s);", "}", "", "",
    ].join("\n"))].join("");
  },
  // B-add: the event opening with its rolling step, and a new raw-byte tree over the event hash beside it.
  add(circuits) {
    const openings = emitOpenings();
    return [benchPreamble(openings), WALK, "\n", ...Object.entries(circuits).map(([name, spec]) => {
      let s = renamed(openings, spec.class, name);
      s = once(s, `witness ${name}_eventHex(): ${vector(64)};\n`, `witness ${name}_eventHex(): ${vector(64)};\nwitness ${name}_treeLeaf(): Bytes<32>;\nwitness ${name}_tree(): Vector<${spec.depth}, WalkStep>;\n`);
      s = once(s, "(s: PaymentOpening): [] {", "(s: PaymentOpening, t: WalkOpening): [] {");
      // The walk starts from a witness held equal to the event hash: compactc 0.31.1 did not finish compiling a fold
      // that starts from the hash of the event's witnesses itself.
      return `${once(s, "  paymentOpening = disclose(s);\n", [
        `  const treeLeaf = ${name}_treeLeaf();`, '  assert(treeLeaf == eventHash, "tree leaf");',
        `  assert(fold(walkSelect, treeLeaf, ${name}_tree()) == t.root, "tree root mismatch");`, "  paymentOpening = disclose(s);", "  walkOpening = disclose(t);", "",
      ].join("\n"))}\n`;
    })].join("");
  },
};

/**
 * The Compact source of one bench group.
 * @param {string} group
 * @param {{ kind: string, circuits: Record<string, Record<string, unknown>> }} spec
 * @returns {string}
 */
export function emitBench(group, { kind, circuits }) {
  if (!Object.hasOwn(EMIT, kind)) throw new Error(`bench group ${group} has unknown kind ${kind}`);
  for (const name of Object.keys(circuits)) if (!/^b_[a-z0-9_]+$/.test(name)) throw new Error(`bench circuit ${JSON.stringify(name)} must be b_ and lowercase letters, digits and underscores`);
  return EMIT[kind](circuits);
}

const prefixed = (witnesses, from, to) => Object.fromEntries(Object.entries(witnesses).map(([name, value]) => [name.replace(from, to), value]));
const nodeOf = (left, right) => sha256(utf8("poi-trace:node:v1|"), left, utf8("|"), right);

/**
 * The witnesses and statement that open a guard event and its one-event span against a span tree, by the path of
 * `siblings` (each the hex of a sibling and whether it lies on the right), with the span preimage and leaf the circuit
 * hashes. The segments and span values may hold any bytes: everything is derived from them as the circuit derives it.
 * @param {string} circuit
 * @param {Readonly<Record<string, Uint8Array>>} segments
 * @param {{ id: string, spanSeq: string, startedAt: string, endedAt: string, durationMs: string }} span
 * @param {readonly { hex: string, sibRight: boolean }[]} siblings
 */
export function spanOpening(circuit, segments, span, siblings) {
  const event = eventOpening("ev_pa_ascii_min", segments, "0".repeat(64));
  const { prevRollHex: _prev, rollAfter: _roll, ...facts } = event.statement;
  const eventHex = event.witnesses.ev_pa_ascii_min_eventHex;
  const values = { durationMs: utf8(span.durationMs), endedAt: utf8(span.endedAt), id: segments.id, spanId: utf8(span.id), spanSeq: utf8(span.spanSeq), startedAt: utf8(span.startedAt), eventHex };
  const spanPreimage = Uint8Array.from(SPAN_HEAD.flatMap((text, i) => [...utf8(text), ...values[SPAN_VALUES[i]]]));
  const spanHex = utf8(hexOf(sha256(spanPreimage)));
  const leaf = sha256(utf8("poi-trace:leaf:v1|"), spanHex);
  let node = leaf;
  const nodeHex = [];
  for (const { hex, sibRight } of siblings) {
    const own = utf8(hexOf(node));
    nodeHex.push(own);
    node = sibRight ? nodeOf(own, utf8(hex)) : nodeOf(utf8(hex), own);
  }
  const bytes = list => list.map(item => Array.from(item, BigInt));
  const walk = siblings.length === 0 ? {} : { nodeHex: bytes(nodeHex), sibs: bytes(siblings.map(s => utf8(s.hex))), dirs: siblings.map(s => s.sibRight) };
  const own = { spanId: values.spanId, spanSeq: values.spanSeq, startedAt: values.startedAt, endedAt: values.endedAt, durationMs: values.durationMs, spanHex, ...walk };
  const witnesses = { ...prefixed(event.witnesses, "ev_pa_ascii_min", circuit), ...Object.fromEntries(Object.entries(own).map(([name, value]) => [`${circuit}_${name}`, value])) };
  return { circuit, witnesses, statement: { root: node, ...facts }, spanPreimage, leaf };
}

// A synthetic guard event in the ascii-min payment class: in-class bytes with the action digest of its own action.
function sampleSegments() {
  const text = {
    amount: "5", asset: "USD", counterparty: "acme", ts: "3", enforcedAt: "4", mandateCommitment: hexOf(sha256(utf8("conduct bench mandate"))), dataSeq: "0",
    id: "550e8400-e29b-41d4-a716-446655440000", traceSeq: "2", iso: "2026-10-27T00:00:00.000Z", vis: "private",
  };
  const segments = Object.fromEntries(Object.entries(text).map(([name, value]) => [name, utf8(value)]));
  return { ...segments, actionDigest: stepActionDigest("st_pa", segments) };
}
const SAMPLE_PREV = hexOf(sha256(utf8("conduct bench chain")));
const SAMPLE_MEMBERS = Array.from({ length: 5 }, (_, i) => `mem${i}`);
const pad20 = digits => utf8(digits.padStart(20, "0"));
const halves = hex => [BigInt(`0x${Buffer.from(hex).toString("latin1").slice(0, 32)}`), BigInt(`0x${Buffer.from(hex).toString("latin1").slice(32)}`)];

const INPUT = {
  pub(name, spec) {
    if (spec.class !== "ev_pa_ascii_min") return undefined;
    const segments = sampleSegments();
    const { witnesses, statement } = eventOpening(spec.class, segments, SAMPLE_PREV);
    const { prevRollHex: _prev, rollAfter: _roll, ...facts } = statement;
    const { [`${spec.class}_eventHex`]: eventHex, ...rest } = witnesses;
    return { witnesses: prefixed(rest, spec.class, name), args: [{ eventHash: Uint8Array.from(Buffer.from(Buffer.from(eventHex).toString("latin1"), "hex")), ...facts }] };
  },
  lhash(name, spec) {
    const { witnesses, statement } = eventOpening(spec.class, sampleSegments(), SAMPLE_PREV);
    const eventBytes = Uint8Array.from(Buffer.from(Buffer.from(witnesses[`${spec.class}_eventHex`]).toString("latin1"), "hex"));
    return { witnesses: { ...prefixed(witnesses, spec.class, name), [`${name}_eventBytes`]: eventBytes }, args: [statement] };
  },
  allowlist(name, { depth }) {
    const members = SAMPLE_MEMBERS.slice(0, Math.min(SAMPLE_MEMBERS.length, 2 ** depth));
    const { path, root } = allowlistPath(members, members[0], depth);
    return { witnesses: { [`${name}_member`]: utf8(members[0]), [`${name}_path`]: path }, args: [{ root }] };
  },
  window(name, { lengths }) {
    const { witnesses, statement } = eventOpening("ev_pa_ascii_min", sampleSegments(), SAMPLE_PREV);
    const { ev_pa_ascii_min_amount: amount, ...rest } = witnesses;
    const amounts = Object.fromEntries(Array.from({ length: lengths }, (_, i) => [`${name}_amount${i + 1}`, i === 0 ? amount : utf8(`1${"0".repeat(i)}`)]));
    return { witnesses: { ...prefixed(rest, "ev_pa_ascii_min", name), ...amounts, [`${name}_len`]: 1n }, args: [statement] };
  },
  v2(name) {
    const sample = sampleSegments();
    const text = bytes => Buffer.from(bytes).toString("latin1");
    const values = {
      amount: pad20(text(sample.amount)), asset: utf8(hexOf(sha256(sample.asset))), counterparty: utf8(hexOf(sha256(sample.counterparty))), ts: pad20(text(sample.ts)),
      actionDigest: sample.actionDigest, enforcedAt: pad20(text(sample.enforcedAt)), mandateCommitment: sample.mandateCommitment, dataSeq: pad20(text(sample.dataSeq)),
      id: sample.id, traceSeq: sample.traceSeq, iso: sample.iso, vis: sample.vis,
    };
    const eventHex = utf8(hexOf(sha256(...V2_PARTS.flatMap(([constant, value]) => [utf8(constant), values[value]]), utf8(V2_TAIL))));
    const statement = {
      prevRollHex: utf8(SAMPLE_PREV), rollAfter: sha256(utf8("poi-trace:roll:v1|"), utf8(SAMPLE_PREV), utf8("|"), eventHex),
      ...Object.fromEntries(V2_DECIMALS.map(d => [d, BigInt(text(values[d]))])), traceSeq: BigInt(text(values.traceSeq)),
      ...Object.fromEntries(V2_HEX.flatMap(h => halves(values[h]).map((half, i) => [`${h}${i === 0 ? "Hi" : "Lo"}`, half]))),
    };
    return { witnesses: Object.fromEntries([...Object.entries(values), ["eventHex", eventHex]].map(([value, bytes]) => [`${name}_${value}`, bytes])), args: [statement] };
  },
  span(name, { depth, digits }) {
    const segments = { ...sampleSegments(), traceSeq: utf8("2".repeat(digits)) };
    const siblings = Array.from({ length: depth }, (_, i) => ({ hex: hexOf(sha256(utf8(`conduct bench sibling ${i}`))), sibRight: i % 2 === 0 }));
    const span = { id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8", spanSeq: "2".repeat(digits), startedAt: "2026-10-27T00:00:00.000Z", endedAt: "2026-10-27T00:00:00.000Z", durationMs: "0" };
    const { witnesses, statement } = spanOpening(name, segments, span, siblings);
    return { witnesses, args: [statement] };
  },
  poacwalk(name, { depth }) {
    const leaf = sha256(utf8("conduct bench leaf"));
    const path = Array.from({ length: depth }, (_, i) => ({ right: i % 2 === 0, sib: sha256(utf8(`conduct bench walk ${i}`)) }));
    const root = path.reduce((cur, step) => (step.right ? sha256(cur, step.sib) : sha256(step.sib, cur)), leaf);
    return { witnesses: { [`${name}_leaf`]: leaf, [`${name}_path`]: path }, args: [{ root }] };
  },
};

/**
 * An honest input of a bench circuit, synthetic and in class, for a measurement run: its witnesses and its arguments.
 * Undefined where no input builder exists; such a circuit has rows and k only.
 * @param {string} kind
 * @param {string} name
 * @param {Record<string, unknown>} spec
 * @returns {{ witnesses: Record<string, unknown>, args: unknown[] } | undefined}
 */
export const benchInput = (kind, name, spec) => INPUT[kind]?.(name, spec);

// In-class bytes of each lexical class at a width.
const SAMPLE_VALUE = {
  dec64: n => `1${"0".repeat(n - 1)}`,
  dec53: n => `1${"0".repeat(n - 1)}`,
  str: n => "a".repeat(n),
  hex64: () => hexOf(sha256(utf8("conduct bench value"))),
  uuid: () => "550e8400-e29b-41d4-a716-446655440000",
  iso24: () => "2026-10-27T00:00:00.000Z",
  vis: n => (n === 7 ? "private" : "public"),
};

/**
 * An honest input of a compiled event opening class, for a measurement run: a synthetic event of the class's lengths,
 * each value in its lexical class, opened after a synthetic rolling hash.
 * @param {string} circuit
 * @returns {{ witnesses: Record<string, Uint8Array>, args: unknown[] }}
 */
export function sampleEventInput(circuit) {
  const { kind, lengths } = CLASSES.openings.events[circuit];
  const segments = Object.fromEntries([...valueSpecs(kind).values()].map(spec => [spec.v, utf8(SAMPLE_VALUE[spec.lex](lengths[spec.v]))]));
  const { witnesses, statement } = eventOpening(circuit, segments, SAMPLE_PREV);
  return { witnesses, args: [statement] };
}

/**
 * The input that opens a mandate's CBOR in its compiled class, for a measurement run.
 * @param {Uint8Array} cbor
 * @returns {{ circuit: string, witnesses: Record<string, Uint8Array>, args: unknown[] }}
 */
export function mandateInput(cbor) {
  const classified = mandateSegments(cbor);
  const circuit = mandateClass(classified);
  const { witnesses, statement } = mandateOpening(circuit, classified.segments);
  return { circuit, witnesses, args: [statement] };
}
