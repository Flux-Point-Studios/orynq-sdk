// The byte templates of the conduct opening circuits. compile-conduct emits Compact from them, and the tests render,
// classify and open real producer output with them.
// Build-order rule: node builtins only, so compile-conduct runs from the files the npm package ships, with no workspace build.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

/**
 * @typedef {{ c?: string, v?: string, lex?: string, max?: number, nonzero?: boolean }} Segment
 * @typedef {{ kind: string, values: Record<string, string>, lengths: Record<string, number> }} ClassifiedEvent
 * @typedef {{ lengths: Record<string, number>, segments: Record<string, Uint8Array> }} ClassifiedMandate
 * @typedef {{ active: boolean, sibRight: boolean, sib: Uint8Array }} PathLevel
 * @typedef {{ notBefore: bigint, notAfter: bigint, assetDigest: Uint8Array, capAmount: bigint, windowSeconds: bigint, egressMode: bigint, counterpartyRoot: Uint8Array, egressRoot: Uint8Array }} StepAtoms
 * @typedef {{ q: bigint, r: bigint, rClock: bigint }} StepWindow
 */

const circuits = new URL("../../circuits/conduct/", import.meta.url);
const readJson = path => JSON.parse(readFileSync(new URL(path, circuits), "utf8"));
export const TEMPLATE = readJson("templates/guard-event-v1.json");
export const CLASSES = readJson("classes.json");

// Adjacent constants, strings or byte arrays, merge and empty ones drop, so parts alternate constants and values.
function merged(parts) {
  const out = [];
  for (const part of parts) {
    if (part.c?.length === 0) continue;
    const last = out.at(-1);
    if (part.c !== undefined && last?.c !== undefined) out[out.length - 1] = { c: last.c.concat(part.c) };
    else out.push(part);
  }
  return out;
}

function denial(segments, reason, rule) {
  const { insertAfter, insert } = TEMPLATE.denial;
  const [actionType, denialType] = [TEMPLATE.types.action, TEMPLATE.types.denial].map(type => `"type":"${type}"`);
  const at = segments.findIndex(s => s.v === insertAfter);
  const typed = segments.map(s => (s.c?.includes(actionType) ? { c: s.c.replace(actionType, denialType) } : s));
  return merged([...typed.slice(0, at + 1), { c: insert.replace("{reason}", reason).replace("{rule}", rule) }, ...typed.slice(at + 1)]);
}

/**
 * Every guard event kind, as its canonical segments: `{c}` constants and `{v, lex, max?, nonzero?}` values.
 * @returns {Record<string, Segment[]>}
 */
export function expandKinds() {
  /** @type {Record<string, Segment[]>} */
  const kinds = {};
  for (const [action, segments] of Object.entries(TEMPLATE.actions)) {
    kinds[`${action}-action`] = merged(segments);
    const reasons = Object.entries(TEMPLATE.reasons).filter(([, r]) => r.actions.includes(action)).sort(([, a], [, b]) => a.code - b.code);
    for (const [reason, { code, rule }] of reasons) kinds[`${action}-denial-${code}`] = denial(segments, reason, rule);
  }
  return kinds;
}

const KINDS = expandKinds();

/**
 * The value segments of a guard event kind, each once, keyed by value name.
 * @param {string} kind
 * @returns {Map<string, Segment>}
 */
export const valueSpecs = kind => new Map(KINDS[kind].filter(s => s.v !== undefined).map(s => [s.v, s]));

const refuse = (code, message) => {
  throw new Error(`${code}: ${message}`);
};

const hasKeys = (value, keys) =>
  typeof value === "object" && value !== null && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());

const EVENT_KEYS = ["data", "eventType", "id", "kind", "seq", "timestamp", "visibility"];
const DATA_KEYS = ["action", "actionDigest", "actionKind", "enforcedAt", "mandateCommitment", "seq", "timestamp", "type"];
const ACTION_KEYS = { payment: ["amount", "asset", "counterparty", "kind", "timestamp"], egress: ["destination", "kind", "timestamp"] };
const U64_LIMIT = 1n << 64n;
const ISO_AFTER_YEAR = "-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";
const ISO24 = new RegExp(`^[0-9]{4}${ISO_AFTER_YEAR}`);
// Date#toISOString writes a year outside 0000-9999 with a sign and six digits.
const ISO_EXPANDED_YEAR = new RegExp(`^[+-][0-9]{6}${ISO_AFTER_YEAR}`);

// Each lexical class as the opening circuits' gadgets enforce it, with the refusal code for a value outside it. An
// integer trace sequence of 2^53 or more and an ISO time of an expanded year have their own codes.
const LEXICAL = {
  dec64: (v, s) => /^(0|[1-9][0-9]*)$/.test(v) && v.length <= s.max && BigInt(v) < U64_LIMIT && !(s.nonzero && v === "0") || "OUT_OF_CLASS",
  dec53: v => /^(0|[1-9][0-9]{0,15})$/.test(v) && Number.isSafeInteger(Number(v)) || (Number.isInteger(Number(v)) && Number(v) >= 2 ** 53 ? "TRACE_SEQ_UNSAFE" : "OUT_OF_CLASS"),
  str: (v, s) => (JSON.stringify(v) !== `"${v}"` ? "ESCAPED_STRING" : v.length > 0 && Buffer.byteLength(v, "utf8") <= s.max || "OUT_OF_CLASS"),
  hex64: v => /^[0-9a-f]{64}$/.test(v) || "OUT_OF_CLASS",
  uuid: v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) || "OUT_OF_CLASS",
  iso24: v => ISO24.test(v) || (ISO_EXPANDED_YEAR.test(v) ? "ISO_OUT_OF_RANGE" : "OUT_OF_CLASS"),
  vis: v => ["public", "private", "secret"].includes(v) || "OUT_OF_CLASS",
};
const FIXED_WIDTHS = { hex64: 64, uuid: 36, iso24: 24 };

/**
 * The kind of a process-trace guard event, its value segments keyed by the template's value names, and the byte
 * lengths that select its class. Throws `<CODE>: <reason>` for an event outside every class.
 * @param {unknown} event
 * @returns {ClassifiedEvent}
 */
export function classify(event) {
  const { hash: _hash, ...body } = event ?? {};
  if (!hasKeys(body, EVENT_KEYS) || body.kind !== "custom" || body.eventType !== TEMPLATE.types.event) refuse("UNKNOWN_SHAPE", "not a process-trace guard event");
  const { data } = body;
  const denied = data?.type === TEMPLATE.types.denial;
  if (!denied && data?.type !== TEMPLATE.types.action) refuse("UNKNOWN_SHAPE", "unknown guard event type");
  if (!hasKeys(data, denied ? [...DATA_KEYS, "reason", "rule"] : DATA_KEYS)) refuse("UNKNOWN_SHAPE", "guard event data keys");
  const { action } = data;
  if (!Object.hasOwn(ACTION_KEYS, action?.kind) || !hasKeys(action, ACTION_KEYS[action.kind]) || data.actionKind !== action.kind) refuse("UNKNOWN_SHAPE", "guard action keys");
  let kind = `${action.kind}-action`;
  if (denied) {
    const reason = Object.hasOwn(TEMPLATE.reasons, data.reason) ? TEMPLATE.reasons[data.reason] : undefined;
    if (!reason?.actions.includes(action.kind) || data.rule !== reason.rule) refuse("UNKNOWN_SHAPE", "unknown denial reason or rule");
    kind = `${action.kind}-denial-${reason.code}`;
  }
  if (typeof body.seq !== "number") refuse("UNKNOWN_SHAPE", "trace seq is not a number");
  const party = action.kind === "payment" ? { amount: action.amount, asset: action.asset, counterparty: action.counterparty } : { destination: action.destination };
  const values = {
    ...party, ts: action.timestamp, actionDigest: data.actionDigest, enforcedAt: data.enforcedAt, mandateCommitment: data.mandateCommitment,
    dataSeq: data.seq, id: body.id, traceSeq: String(body.seq), iso: body.timestamp, vis: body.visibility,
  };
  /** @type {Record<string, number>} */
  const lengths = {};
  for (const segment of valueSpecs(kind).values()) {
    const value = values[segment.v];
    if (typeof value !== "string") refuse("UNKNOWN_SHAPE", `${segment.v} is not a string`);
    const verdict = LEXICAL[segment.lex](value, segment);
    if (verdict !== true) refuse(verdict, `${segment.v} is outside the ${segment.lex} class`);
    if (!Object.hasOwn(FIXED_WIDTHS, segment.lex)) lengths[segment.v] = Buffer.byteLength(value, "utf8");
  }
  if (data.timestamp !== action.timestamp) refuse("TS_MISMATCH", "guard data timestamp differs from the action timestamp");
  return { kind, values, lengths };
}

/**
 * The compiled opening circuit for a classified event.
 * @param {ClassifiedEvent} classified
 * @returns {string}
 */
export function eventClass({ kind, lengths }) {
  const match = Object.entries(CLASSES.openings.events).find(([, c]) => c.kind === kind && isDeepStrictEqual(c.lengths, lengths));
  if (match === undefined) refuse("NO_COMPILED_CLASS", `no compiled ${kind} class has lengths ${JSON.stringify(lengths)}`);
  return match[0];
}

/**
 * The domain-prefixed preimage of a classified event.
 * @type {(classified: Pick<ClassifiedEvent, "kind" | "values">) => string}
 */
export const render = ({ kind, values }) => KINDS[kind].map(s => s.c ?? values[s.v]).join("");

const utf8 = text => new TextEncoder().encode(text);
const sha256 = (...parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
const ROLL_DOMAIN = "poi-trace:roll:v1|";
const ALLOWLIST_LEAF_DOMAIN = "orynq:conduct:allowlist:leaf:v1|";

// The CBOR text-string head of an n-byte string.
const textHead = n => (n < 24 ? [0x60 + n] : n < 256 ? [0x78, n] : [0x79, n >> 8, n & 0xff]);

// Constant hash inputs: string literals for runs of printable ASCII, byte vectors for the rest.
const printable = b => b >= 0x20 && b <= 0x7e;
function constant(bytes) {
  const parts = [];
  for (let start = 0; start < bytes.length;) {
    let end = start;
    while (end < bytes.length && printable(bytes[end]) === printable(bytes[start])) end += 1;
    const run = bytes.slice(start, end);
    parts.push(printable(bytes[start])
      ? { type: `Bytes<${run.length}>`, value: JSON.stringify(Buffer.from(run).toString("latin1")) }
      : { type: `Vector<${run.length}, Uint<8>>`, value: `[${run.join(", ")}]` });
    start = end;
  }
  return parts;
}
const segment = (name, length) => ({ type: `Vector<${length}, Uint<8>>`, value: name });
const hashOf = parts => `persistentHash<[${parts.map(p => p.type).join(", ")}]>([${parts.map(p => p.value).join(", ")}])`;
const leafPrefix = length => constant([...utf8(ALLOWLIST_LEAF_DOMAIN), ...textHead(length)]);

// Each opened value's statement fields, read from its bytes with the circuit's own arithmetic, so a test can derive the
// statement a cheating prover would claim for bytes outside the class.
const decimal = bytes => bytes.reduce((acc, b) => acc * 10n + BigInt(b) - 48n, 0n);
const nibbles = bytes => bytes.reduce((acc, c) => acc * 16n + BigInt(c - 48 - (c >= 97 ? 39 : 0)), 0n);
const OPENERS = {
  decimal: {
    type: "Uint<64>", fields: field => [field], read: bytes => [decimal(bytes)],
    emit: (name, field, length, spec) => [
      `assert(${spec.lex === "dec53" ? "dec53" : "decU64"}<${length}>(${name}) == s.${field}, "${field} opening");`,
      ...(spec.nonzero ? [`assert(s.${field} != 0, "decimal nonzero");`] : []),
    ],
  },
  hex: {
    type: "Uint<128>", fields: field => [`${field}Hi`, `${field}Lo`], read: bytes => [nibbles(bytes.subarray(0, 32)), nibbles(bytes.subarray(32))],
    emit: (name, field) => [
      `const ${name}Halves = hexHalves(${name});`,
      `assert(${name}Halves[0] == (s.${field}Hi as Field) && ${name}Halves[1] == (s.${field}Lo as Field), "${field} opening");`,
    ],
  },
  digest: {
    type: "Bytes<32>", fields: field => [field], read: bytes => [sha256(bytes)],
    emit: (name, field, length) => [`assert(${hashOf([segment(name, length)])} == s.${field}, "${field} opening");`],
  },
  leaf: {
    type: "Bytes<32>", fields: field => [field], read: bytes => [sha256(utf8(ALLOWLIST_LEAF_DOMAIN), Uint8Array.from(textHead(bytes.length)), bytes)],
    emit: (name, field, length) => [`assert(${hashOf([...leafPrefix(length), segment(name, length)])} == s.${field}, "${field} opening");`],
  },
};
const STATEMENT = {
  amount: ["decimal", "amount"], asset: ["digest", "assetDigest"], counterparty: ["leaf", "counterpartyLeaf"], destination: ["leaf", "destinationLeaf"],
  ts: ["decimal", "timestamp"], actionDigest: ["hex", "actionDigest"], enforcedAt: ["decimal", "enforcedAt"],
  mandateCommitment: ["hex", "mandateCommitment"], dataSeq: ["decimal", "dataSeq"], traceSeq: ["decimal", "traceSeq"],
};
const ROLL_FIELDS = [["prevRollHex", "Bytes<64>"], ["rollAfter", "Bytes<32>"]];

const valueNames = kind => [...valueSpecs(kind).keys()];
const opened = kind => valueNames(kind).filter(name => Object.hasOwn(STATEMENT, name)).map(name => [name, OPENERS[STATEMENT[name][0]], STATEMENT[name][1]]);

/**
 * The UTF-8 bytes of each value of a classified event: the witness segments of its opening.
 * @type {(classified: ClassifiedEvent) => Record<string, Uint8Array>}
 */
export const eventSegments = ({ kind, values }) => Object.fromEntries(valueNames(kind).map(name => [name, utf8(values[name])]));

const concat = parts => Uint8Array.from(parts.flatMap(part => [...part]));
const preimageOf = (kind, segments) => concat(KINDS[kind].map(s => (s.c === undefined ? segments[s.v] : utf8(s.c))));

/**
 * The witnesses and statement that open `segments` in the event class `circuit` after the rolling hash `prevRollHex`.
 * The segments may hold any bytes: the hash chain and statement are derived from them as the circuit derives them.
 * @param {string} circuit
 * @param {Readonly<Record<string, Uint8Array>>} segments
 * @param {string} prevRollHex
 * @returns {{ witnesses: Record<string, Uint8Array>, statement: Record<string, Uint8Array | bigint> }}
 */
export function eventOpening(circuit, segments, prevRollHex) {
  const { kind } = CLASSES.openings.events[circuit];
  const eventHex = utf8(Buffer.from(sha256(preimageOf(kind, segments))).toString("hex"));
  const statement = { prevRollHex: utf8(prevRollHex), rollAfter: sha256(utf8(ROLL_DOMAIN), utf8(prevRollHex), utf8("|"), eventHex) };
  for (const [name, opener, field] of opened(kind)) {
    const values = opener.read(segments[name]);
    opener.fields(field).forEach((key, i) => { statement[key] = values[i]; });
  }
  const witnesses = Object.fromEntries([...Object.entries(segments), ["eventHex", eventHex]].map(([name, bytes]) => [`${circuit}_${name}`, bytes]));
  return { witnesses, statement };
}

const MANDATE_DOMAIN = "orynq:conduct:mandate:v1|";
const ATOMS_DOMAIN = "orynq:conduct:mandate-atoms:v1";
const DID_PREFIX = "did:key:z";
// The deterministic CBOR of a v1 mandate (packages/conduct/docs/mandate-v1.cddl) as constants and fields. A text
// field's length and a uint field's head width (0 when the value sits in the head byte) are the class dimensions.
const MANDATE_LAYOUT = [
  { c: [0xab, 0x00, 0x01, 0x01, 0x50] }, { v: "mandateId", bytes: 16 },
  { c: [0x02] }, { v: "principalDid", text: "did" },
  { c: [0x03] }, { v: "agentDid", text: "did" },
  { c: [0x04, 0x00, 0x05, 0xa3, 0x00] }, { v: "asset", text: "ascii" },
  { c: [0x01] }, { v: "capAmount", uint: true },
  { c: [0x02] }, { v: "windowSeconds", uint: true },
  { c: [0x06, 0x58, 0x20] }, { v: "counterpartyRoot", bytes: 32 },
  { c: [0x07, 0xa2, 0x00] }, { v: "egressMode", bytes: 1 },
  { c: [0x01, 0x58, 0x20] }, { v: "egressRoot", bytes: 32 },
  { c: [0x08, 0x58, 0x20] }, { v: "measurementRoot", bytes: 32 },
  { c: [0x09, 0xa2, 0x00] }, { v: "notBefore", uint: true },
  { c: [0x01] }, { v: "notAfter", uint: true },
  { c: [0x0a, 0xa3, 0x00] }, { v: "committeeId", text: "utf8" },
  { c: [0x01] }, { v: "threshold", uint: true },
  { c: [0x02] }, { v: "committeeSize", uint: true },
];
const UINT_WIDTHS = { 0x18: 1, 0x19: 2, 0x1a: 4, 0x1b: 8 };
const UINT_HEADS = Object.fromEntries(Object.entries(UINT_WIDTHS).map(([head, width]) => [width, Number(head)]));
const uintHead = width => (width === 0 ? [] : [UINT_HEADS[width]]);
const MANDATE_FIELDS = MANDATE_LAYOUT.filter(f => f.v !== undefined);

/**
 * The class dimensions and the witness segments of a mandate's CBOR, read by its fixed layout alone. Throws
 * `MANDATE_LAYOUT: <reason>` for bytes the layout cannot express; the circuits enforce the schema's value rules.
 * @param {Uint8Array} cbor
 * @returns {ClassifiedMandate}
 */
export function mandateSegments(cbor) {
  const bytes = Uint8Array.from(cbor);
  let at = 0;
  const take = n => {
    if (at + n > bytes.length) refuse("MANDATE_LAYOUT", "truncated mandate");
    at += n;
    return bytes.slice(at - n, at);
  };
  const lengths = {};
  const segments = {};
  for (const field of MANDATE_LAYOUT) {
    if (field.c !== undefined) {
      if (!isDeepStrictEqual([...take(field.c.length)], field.c)) refuse("MANDATE_LAYOUT", `bytes at ${at - field.c.length} differ from the layout`);
    } else if (field.bytes !== undefined) {
      segments[field.v] = take(field.bytes);
    } else if (field.text !== undefined) {
      const head = take(1)[0];
      const length = head >= 0x60 && head <= 0x77 ? head - 0x60 : head === 0x78 ? take(1)[0] : head === 0x79 ? take(1)[0] * 256 + take(1)[0] : -1;
      if (length < 0 || !isDeepStrictEqual(textHead(length), [...bytes.slice(at - textHead(length).length, at)])) refuse("MANDATE_LAYOUT", `${field.v} has no minimal text head`);
      lengths[field.v] = length;
      if (field.text === "did") {
        if (length < DID_PREFIX.length || Buffer.from(take(DID_PREFIX.length)).toString("latin1") !== DID_PREFIX) refuse("MANDATE_LAYOUT", `${field.v} is not a did:key:z DID`);
        segments[field.v] = take(length - DID_PREFIX.length);
      } else segments[field.v] = take(length);
    } else {
      const head = take(1)[0];
      if (head <= 23) {
        lengths[field.v] = 0;
        segments[field.v] = Uint8Array.of(head);
      } else if (Object.hasOwn(UINT_WIDTHS, head)) {
        lengths[field.v] = UINT_WIDTHS[head];
        segments[field.v] = take(UINT_WIDTHS[head]);
      } else refuse("MANDATE_LAYOUT", `${field.v} is not a uint`);
    }
  }
  if (at !== bytes.length) refuse("MANDATE_LAYOUT", "trailing bytes");
  return { lengths, segments };
}

/**
 * The compiled mandate opening circuit for a classified mandate.
 * @param {Pick<ClassifiedMandate, "lengths">} classified
 * @returns {string}
 */
export function mandateClass({ lengths }) {
  const match = Object.entries(CLASSES.openings.mandates).find(([, c]) => isDeepStrictEqual(c, lengths));
  if (match === undefined) refuse("NO_COMPILED_CLASS", `no compiled mandate class has dimensions ${JSON.stringify(lengths)}`);
  return match[0];
}

const mandateParts = lengths => MANDATE_LAYOUT.flatMap(field => {
  if (field.c !== undefined) return [{ c: field.c }];
  if (field.bytes !== undefined) return [{ v: field.v }];
  if (field.text !== undefined) return [{ c: [...textHead(lengths[field.v]), ...(field.text === "did" ? utf8(DID_PREFIX) : [])] }, { v: field.v }];
  return [{ c: uintHead(lengths[field.v]) }, { v: field.v }];
});
/**
 * The uint a big-endian byte string encodes.
 * @type {(bytes: Uint8Array) => bigint}
 */
export const uintOfBigEndian = bytes => bytes.reduce((acc, b) => acc * 256n + BigInt(b), 0n);
const le8 = value => Uint8Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn));

/**
 * The witnesses and statement that open `segments` in the mandate class `circuit`: C over the CBOR the segments render
 * to, and K over C and the atoms read from them as the circuit reads them.
 * @param {string} circuit
 * @param {Readonly<Record<string, Uint8Array>>} segments
 * @returns {{ witnesses: Record<string, Uint8Array>, statement: { commitment: Uint8Array, atoms: Uint8Array }, atoms: Record<string, Uint8Array | bigint> }}
 */
export function mandateOpening(circuit, segments) {
  const lengths = CLASSES.openings.mandates[circuit];
  const cbor = concat(mandateParts(lengths).map(part => (part.c === undefined ? segments[part.v] : part.c)));
  const commitment = sha256(utf8(MANDATE_DOMAIN), cbor);
  const uint = name => (lengths[name] === 0 ? BigInt(segments[name][0]) : uintOfBigEndian(segments[name]));
  const atoms = {
    notBefore: uint("notBefore"), notAfter: uint("notAfter"), asset: segments.asset, cap: uint("capAmount"), window: uint("windowSeconds"),
    egressMode: BigInt(segments.egressMode[0]), counterpartyRoot: segments.counterpartyRoot, egressRoot: segments.egressRoot,
  };
  const domain = new Uint8Array(32);
  domain.set(utf8(ATOMS_DOMAIN));
  const k = sha256(domain, commitment, le8(atoms.notBefore), le8(atoms.notAfter), sha256(atoms.asset), le8(atoms.cap), le8(atoms.window),
    segments.egressMode, atoms.counterpartyRoot, atoms.egressRoot);
  const witnesses = Object.fromEntries(Object.entries(segments).map(([name, bytes]) => [`${circuit}_${name}`, bytes]));
  return { witnesses, statement: { commitment, atoms: k }, atoms };
}

const actionOf = kind => kind.slice(0, kind.indexOf("-"));
const statementType = action => `${action[0].toUpperCase()}${action.slice(1)}Opening`;

// The lexical gadget of each class whose statement binding does not already enforce it.
const LEXICAL_GADGET = {
  str: (name, length) => [`jsonStr<${length}>(${name});`],
  uuid: name => [`uuid(${name});`],
  iso24: name => [`iso8601(${name});`],
  vis: (name, length) => [`vis${length}(${name});`],
};
const valueLength = (spec, lengths) => lengths[spec.v] ?? FIXED_WIDTHS[spec.lex];

function eventCircuit(id, { kind, lengths }) {
  const action = actionOf(kind);
  const specs = valueSpecs(kind);
  const out = [];
  for (const [name, spec] of specs) out.push(`witness ${id}_${name}(): Vector<${valueLength(spec, lengths)}, Uint<8>>;`);
  out.push(`witness ${id}_eventHex(): Vector<64, Uint<8>>;`, "", `export circuit ${id}(s: ${statementType(action)}): [] {`);
  for (const name of specs.keys()) out.push(`  const ${name} = ${id}_${name}();`);
  const preimage = KINDS[kind].flatMap(s => (s.c === undefined ? [segment(s.v, valueLength(s, lengths))] : constant([...utf8(s.c)])));
  out.push(
    `  const eventHash = ${hashOf(preimage)};`,
    `  const eventHex = ${id}_eventHex();`,
    "  hexOfHash(eventHex, eventHash);",
    `  assert(${hashOf([...constant([...utf8(ROLL_DOMAIN)]), { type: "Bytes<64>", value: "s.prevRollHex" }, ...constant([...utf8("|")]), segment("eventHex", 64)])} == s.rollAfter, "rolling root mismatch");`,
    ...opened(kind).flatMap(([name, opener, field]) => opener.emit(name, field, valueLength(specs.get(name), lengths), specs.get(name)).map(line => `  ${line}`)),
    ...[...specs].flatMap(([name, spec]) => LEXICAL_GADGET[spec.lex]?.(name, valueLength(spec, lengths)) ?? []).map(line => `  ${line}`),
    `  ${action}Opening = disclose(s);`,
    "}",
    "",
  );
  return out;
}

function mandateCircuit(id, lengths) {
  const width = field => field.bytes ?? (field.text === "did" ? lengths[field.v] - DID_PREFIX.length : field.text === undefined ? Math.max(lengths[field.v], 1) : lengths[field.v]);
  const widths = Object.fromEntries(MANDATE_FIELDS.map(field => [field.v, width(field)]));
  const uints = MANDATE_FIELDS.filter(field => field.uint).map(field => field.v);
  const value = field => (lengths[field] === 0 ? `cborHeadValue(${field}[0])` : `cborUint<${lengths[field]}>(${field})`);
  const preimage = merged([{ c: [...utf8(MANDATE_DOMAIN)] }, ...mandateParts(lengths)])
    .flatMap(part => (part.c === undefined ? [segment(part.v, widths[part.v])] : constant(part.c)));
  const atoms = [
    { type: "Bytes<32>", value: `pad(32, ${JSON.stringify(ATOMS_DOMAIN)})` }, { type: "Bytes<32>", value: "commitment" },
    { type: "Uint<64>", value: "notBeforeValue" }, { type: "Uint<64>", value: "notAfterValue" },
    { type: "Bytes<32>", value: hashOf([segment("asset", widths.asset)]) }, { type: "Uint<64>", value: "capAmountValue" },
    { type: "Uint<64>", value: "windowSecondsValue" }, { type: "Uint<8>", value: "egressMode[0]" },
    segment("counterpartyRoot", 32), segment("egressRoot", 32),
  ];
  return [
    ...MANDATE_FIELDS.map(field => `witness ${id}_${field.v}(): Vector<${widths[field.v]}, Uint<8>>;`),
    "",
    `export circuit ${id}(s: MandateOpening): [] {`,
    ...MANDATE_FIELDS.map(field => `  const ${field.v} = ${id}_${field.v}();`),
    `  const commitment = ${hashOf(preimage)};`,
    '  assert(commitment == s.commitment, "mandate commitment opening");',
    ...uints.map(field => `  const ${field}Value = ${value(field)};`),
    `  assert(${hashOf(atoms)} == s.atoms, "mandate atoms opening");`,
    `  base58<${widths.principalDid}>(principalDid);`,
    `  base58<${widths.agentDid}>(agentDid);`,
    `  asciiPrint<${widths.asset}>(asset);`,
    '  assert(windowSecondsValue >= 1, "mandate window");',
    '  assert(egressMode[0] <= 1, "egress mode");',
    "  for (const b of egressRoot) {",
    '    assert(egressMode[0] == 1 || b == 0, "deny-all egress root");',
    "  }",
    '  assert(notBeforeValue < notAfterValue, "mandate validity window");',
    `  utf8Any<${widths.committeeId}>(committeeId);`,
    '  assert(thresholdValue >= 1 && thresholdValue <= committeeSizeValue, "mandate disclosure threshold");',
    "  mandateOpening = disclose(s);",
    "}",
    "",
  ];
}

const vector = n => `v: Vector<${n}, Uint<8>>`;
// The widths the event classes read decimals of the given lexical classes at.
const decimalWidths = (...lexes) => [...new Set(Object.values(CLASSES.openings.events)
  .flatMap(({ kind, lengths }) => [...valueSpecs(kind).values()].filter(s => lexes.includes(s.lex)).map(s => lengths[s.v])))].sort((a, b) => a - b);
// Pure probes of the gadgets, as [name, parameters, return type, call], so the tests can run each over its input class.
// dec53 reads through decU64 at its own width, so decU64 has a probe at every width either is read at.
const PROBES = [
  ["cbor_uint_w0", "head: Uint<8>", "Uint<64>", "cborHeadValue(head)"],
  ...Object.values(UINT_WIDTHS).map(width => [`cbor_uint_w${width}`, vector(width), "Uint<64>", `cborUint<${width}>(v)`]),
  ...[1, 2, 3, 4].flatMap(n => [[`json_str_w${n}`, vector(n), "[]", `jsonStr<${n}>(v)`], [`utf8_any_w${n}`, vector(n), "[]", `utf8Any<${n}>(v)`]]),
  ...decimalWidths("dec64", "dec53").map(n => [`dec_u64_w${n}`, vector(n), "Uint<64>", `decU64<${n}>(v)`]),
  ...decimalWidths("dec53").map(n => [`dec53_w${n}`, vector(n), "Uint<64>", `dec53<${n}>(v)`]),
  ["hex_halves", vector(64), "[Field, Field]", "hexHalves(v)"],
  ["hex_of_hash", `${vector(64)}, hash: Bytes<32>`, "[]", "hexOfHash(v, hash)"],
  ["uuid_shape", vector(36), "[]", "uuid(v)"],
  ["iso8601_shape", vector(24), "[]", "iso8601(v)"],
  ["vis6_shape", vector(6), "[]", "vis6(v)"],
  ["vis7_shape", vector(7), "[]", "vis7(v)"],
  ["base58_w1", vector(1), "[]", "base58<1>(v)"],
  ["ascii_print_w1", vector(1), "[]", "asciiPrint<1>(v)"],
];

/**
 * The Compact source of the opening circuits of every class in classes.json, and the pure probes of the gadgets.
 * @returns {string}
 */
export function emitOpenings() {
  const out = [
    "// Generated from templates/guard-event-v1.json and classes.json by scripts/compile-conduct.mjs --write.",
    "pragma language_version 0.23;",
    "import CompactStandardLibrary;",
    'include "gadgets";',
    "import ConductGadgets;",
    "",
  ];
  for (const action of Object.keys(TEMPLATE.actions)) {
    const fields = [...ROLL_FIELDS, ...opened(`${action}-action`).flatMap(([, opener, field]) => opener.fields(field).map(key => [key, opener.type]))];
    out.push(`export struct ${statementType(action)} {`, fields.map(([key, type]) => `  ${key}: ${type}`).join(",\n"), "}", `export ledger ${action}Opening: ${statementType(action)};`, "");
  }
  out.push("export struct MandateOpening {", "  commitment: Bytes<32>,", "  atoms: Bytes<32>", "}", "export ledger mandateOpening: MandateOpening;", "");
  for (const [id, eventClass] of Object.entries(CLASSES.openings.events)) out.push(...eventCircuit(id, eventClass));
  for (const [id, lengths] of Object.entries(CLASSES.openings.mandates)) out.push(...mandateCircuit(id, lengths));
  for (const [name, parameters, returns, call] of PROBES) out.push(`export pure circuit ${name}(${parameters}): ${returns} {`, `  return ${call};`, "}", "");
  return out.join("\n");
}

const ACTION_DIGEST_DOMAIN = "orynq:conduct:guard:action:v1|";
const ALLOWLIST_NODE_DOMAIN = "orynq:conduct:allowlist:node:v1|";
const STEP_FIELDS = [
  ["prevRollHex", "Bytes<64>"], ["rollAfter", "Bytes<32>"], ["atoms", "Bytes<32>"], ["windowIndex", "Uint<64>"], ["priorSpent", "Uint<64>"],
  ["verdict", "Uint<8>"], ["dataSeq", "Uint<64>"], ["traceSeq", "Uint<64>"],
];
// The atoms of a mandate that K commits after C, in K's order, with the type a step's witness holds each at.
const ATOM_FIELDS = [
  ["notBefore", "Uint<64>"], ["notAfter", "Uint<64>"], ["assetDigest", "Bytes<32>"], ["capAmount", "Uint<64>"], ["windowSeconds", "Uint<64>"],
  ["egressMode", "Uint<8>"], ["counterpartyRoot", "Bytes<32>"], ["egressRoot", "Bytes<32>"],
];
const WINDOW_FIELDS = ["q", "r", "rClock"];
// Verdicts 5 and 7 state that a party is on no list, which a membership path cannot show.
const NON_MEMBERSHIP = [5, 7];
// The decisions that read a membership path: an allowed action, and a payment the cap denied after its counterparty passed.
const READS_MEMBERSHIP = { payment: [0, 4], egress: [0] };

/**
 * The verdict code a guard event kind records: 0 for an action, the reason's code for a denial.
 * @type {(kind: string) => number}
 */
export const stepVerdict = kind => Number(/-denial-(\d)$/.exec(kind)?.[1] ?? 0);

const U64 = 1n << 64n;
// The argument bytes of the shortest CBOR head of a uint; 0 where the head byte holds the value.
const cborWidth = value => (value < 24n ? 0 : value < 256n ? 1 : value < 65536n ? 2 : value < 1n << 32n ? 4 : 8);

/**
 * The compiled step circuit for a classified event. A denial for a party on no list has none: non-membership is not
 * provable, so it is refused, never approximated.
 * @param {ClassifiedEvent} classified
 * @returns {string}
 */
export function stepClass({ kind, values, lengths }) {
  if (NON_MEMBERSHIP.includes(stepVerdict(kind))) refuse("NON_MEMBERSHIP_UNPROVABLE", "non-membership not provable");
  const cbor = { ...(values.amount === undefined ? {} : { amount: cborWidth(BigInt(values.amount)) }), ts: cborWidth(BigInt(values.ts)) };
  const match = Object.entries(CLASSES.steps).find(([, c]) => c.kind === kind && isDeepStrictEqual(c.lengths, lengths) && isDeepStrictEqual(c.cbor, cbor));
  if (match === undefined) refuse("NO_COMPILED_CLASS", `no compiled ${kind} step class has lengths ${JSON.stringify(lengths)} and uint widths ${JSON.stringify(cbor)}`);
  return match[0];
}

const hexOf = bytes => Buffer.from(bytes).toString("hex");
const leafOf = member => sha256(utf8(ALLOWLIST_LEAF_DOMAIN), Uint8Array.from(textHead(utf8(member).length)), utf8(member));
const IDLE_LEVEL = () => ({ active: false, sibRight: false, sib: new Uint8Array(32) });

/**
 * The path of `member` through the conduct allowlist tree of `members`, as `depth` levels: an active level holds the
 * sibling and its side, and an inactive one stands for an odd last node promoted unchanged and for the levels above
 * the root. Throws `ALLOWLIST_TOO_DEEP` for a list of more than 2^depth members and `NOT_A_MEMBER` for a party off it.
 * @param {readonly string[]} members
 * @param {string} member
 * @param {number} depth
 * @returns {{ path: PathLevel[], root: Uint8Array }}
 */
export function allowlistPath(members, member, depth) {
  let level = [...new Map(members.map(leafOf).map(leaf => [hexOf(leaf), leaf])).values()].sort((a, b) => Buffer.compare(a, b));
  if (level.length > 2 ** depth) refuse("ALLOWLIST_TOO_DEEP", `a list of ${level.length} members needs more than ${depth} levels`);
  const own = hexOf(leafOf(member));
  let at = level.findIndex(leaf => hexOf(leaf) === own);
  if (at < 0) refuse("NOT_A_MEMBER", "the allowlist does not hold the party");
  const path = [];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push(sha256(utf8(ALLOWLIST_NODE_DOMAIN), level[i], level[i + 1]));
    const odd = level.length % 2 === 1;
    if (odd) next.push(level.at(-1));
    path.push(odd && at === level.length - 1 ? IDLE_LEVEL() : { active: true, sibRight: at % 2 === 0, sib: level[at ^ 1] });
    at >>= 1;
    level = next;
  }
  while (path.length < depth) path.push(IDLE_LEVEL());
  return { path, root: level[0] };
}

const u64 = value => (value >= 0n && value < U64 ? value : 0n);
const bigEndian = (value, width) => Uint8Array.from({ length: width }, (_, i) => Number((value >> BigInt(8 * (width - 1 - i))) & 0xffn));
// The CBOR uint a step class hashes for a value: in the head byte, or the head and the class's argument bytes.
const cborUintBytes = (value, width) => (width === 0 ? [Number(value & 0xffn)] : [...uintHead(width), ...bigEndian(value, width)]);
const cborText = bytes => [...textHead(bytes.length), ...bytes];

// The CBOR of a guard action (packages/conduct/src/actions.ts) as a step class encodes it from its event's own bytes.
function actionCbor(circuit, segments) {
  const { kind, cbor } = CLASSES.steps[circuit];
  const ts = cborUintBytes(decimal(segments.ts), cbor.ts);
  return actionOf(kind) === "payment"
    ? [0xa5, 0x00, ...cborText(utf8("payment")), 0x01, ...cborText(segments.asset), 0x02, ...cborUintBytes(decimal(segments.amount), cbor.amount), 0x03,
      ...cborText(segments.counterparty), 0x04, ...ts]
    : [0xa3, 0x00, ...cborText(utf8("egress")), 0x01, ...cborText(segments.destination), 0x02, ...ts];
}

/**
 * The lowercase hex of the action digest a step class recomputes from the event's action bytes.
 * @param {string} circuit
 * @param {Readonly<Record<string, Uint8Array>>} segments
 * @returns {Uint8Array}
 */
export const stepActionDigest = (circuit, segments) => utf8(hexOf(sha256(utf8(ACTION_DIGEST_DOMAIN), Uint8Array.from(actionCbor(circuit, segments)))));

// The bytes 64 hex digits encode, read with the circuit's own nibble arithmetic.
const hexDecoded = hex => Uint8Array.from({ length: 32 }, (_, i) => Number((nibbles(hex.subarray(2 * i, 2 * i + 1)) * 16n + nibbles(hex.subarray(2 * i + 1, 2 * i + 2))) & 0xffn));

/**
 * The witnesses and statement that open `segments` as a step of the class `circuit` after the rolling hash
 * `prevRollHex`, under the mandate atoms, membership path and prior spend of `context`. The segments may hold any
 * bytes: the hash chain, K, the window split and the statement are derived from them as the circuit derives them, and
 * a value outside uint64 is stated as 0.
 * @param {string} circuit
 * @param {Readonly<Record<string, Uint8Array>>} segments
 * @param {string} prevRollHex
 * @param {{ atoms: StepAtoms, path?: readonly PathLevel[], priorSpent: bigint, commitment?: Uint8Array, window?: StepWindow }} context
 * @returns {{ witnesses: Record<string, Uint8Array | StepAtoms | StepWindow | readonly PathLevel[]>, statement: Record<string, Uint8Array | bigint> }}
 */
export function stepOpening(circuit, segments, prevRollHex, context) {
  const { kind, cbor, depth } = CLASSES.steps[circuit];
  const { atoms, priorSpent } = context;
  const eventHex = utf8(hexOf(sha256(preimageOf(kind, segments))));
  const commitment = context.commitment ?? hexDecoded(segments.mandateCommitment);
  const domain = new Uint8Array(32);
  domain.set(utf8(ATOMS_DOMAIN));
  const k = sha256(domain, commitment, ...ATOM_FIELDS.map(([name, type]) => (type === "Bytes<32>" ? atoms[name] : type === "Uint<8>" ? Uint8Array.of(Number(atoms[name] & 0xffn)) : le8(atoms[name]))));
  const [ts, clock, width] = [decimal(segments.ts), decimal(segments.enforcedAt), atoms.windowSeconds];
  const q = width === 0n ? 0n : u64(ts) / width;
  const window = context.window ?? { q, r: u64(ts - q * width), rClock: u64(clock - q * width) };
  const statement = {
    prevRollHex: utf8(prevRollHex), rollAfter: sha256(utf8(ROLL_DOMAIN), utf8(prevRollHex), utf8("|"), eventHex), atoms: k, windowIndex: window.q, priorSpent,
    verdict: BigInt(stepVerdict(kind)), dataSeq: u64(decimal(segments.dataSeq)), traceSeq: u64(decimal(segments.traceSeq)),
  };
  const derived = [
    ["eventHex", eventHex],
    ...Object.entries(cbor).filter(([, w]) => w > 0).map(([name, w]) => [`${name}Cbor`, bigEndian(decimal(segments[name]), w)]),
    ["commitment", commitment], ["atoms", atoms], ["window", window], ...(depth === undefined ? [] : [["path", context.path]]),
  ];
  const witnesses = Object.fromEntries([...Object.entries(segments), ...derived].map(([name, value]) => [`${circuit}_${name}`, value]));
  return { witnesses, statement };
}

function stepCircuit(id, { kind, lengths, cbor, depth }) {
  const action = actionOf(kind);
  const verdict = stepVerdict(kind);
  if (NON_MEMBERSHIP.includes(verdict)) throw new Error(`${id}: a denial ${verdict} states non-membership and has no step class`);
  if (READS_MEMBERSHIP[action].includes(verdict) !== (depth !== undefined)) throw new Error(`${id}: a step class has a depth exactly when its decision reads a membership path`);
  const specs = valueSpecs(kind);
  const width = name => valueLength(specs.get(name), lengths);
  const party = action === "payment" ? "counterparty" : "destination";
  const uints = Object.keys(cbor);
  const out = [];
  for (const name of specs.keys()) out.push(`witness ${id}_${name}(): Vector<${width(name)}, Uint<8>>;`);
  out.push(`witness ${id}_eventHex(): Vector<64, Uint<8>>;`);
  for (const name of uints.filter(u => cbor[u] > 0)) out.push(`witness ${id}_${name}Cbor(): Vector<${cbor[name]}, Uint<8>>;`);
  out.push(`witness ${id}_commitment(): Vector<32, Uint<8>>;`, `witness ${id}_atoms(): MandateAtoms;`, `witness ${id}_window(): WindowSplit;`);
  if (depth !== undefined) out.push(`witness ${id}_path(): Vector<${depth}, PathStep>;`);
  out.push("", `export circuit ${id}(s: ConductStep): [] {`);
  const body = [];
  for (const name of specs.keys()) body.push(`const ${name} = ${id}_${name}();`);
  const preimage = KINDS[kind].flatMap(s => (s.c === undefined ? [segment(s.v, width(s.v))] : constant([...utf8(s.c)])));
  body.push(
    `const eventHash = ${hashOf(preimage)};`,
    `const eventHex = ${id}_eventHex();`,
    "hexOfHash(eventHex, eventHash);",
    `assert(${hashOf([...constant([...utf8(ROLL_DOMAIN)]), { type: "Bytes<64>", value: "s.prevRollHex" }, ...constant([...utf8("|")]), segment("eventHex", 64)])} == s.rollAfter, "rolling root mismatch");`,
  );
  // Every value is read through the gadget of its lexical class: the action's atoms as values the verdict takes, the
  // two sequences against the statement.
  if (action === "payment") body.push(`const amountValue = decU64<${width("amount")}>(amount);`, 'assert(amountValue != 0, "decimal nonzero");');
  body.push(
    `const tsValue = decU64<${width("ts")}>(ts);`,
    `const enforcedAtValue = decU64<${width("enforcedAt")}>(enforcedAt);`,
    `assert(decU64<${width("dataSeq")}>(dataSeq) == s.dataSeq, "dataSeq opening");`,
    `assert(dec53<${width("traceSeq")}>(traceSeq) == s.traceSeq, "traceSeq opening");`,
    ...[...specs].flatMap(([name, spec]) => LEXICAL_GADGET[spec.lex]?.(name, width(name)) ?? []),
  );
  // D6: the action digest is recomputed from the opened action bytes, each uint in the CBOR head width of the class.
  const uint = name => {
    if (cbor[name] === 0) {
      body.push(`assert(${name}Value <= 23, "action cbor head");`);
      return [{ type: "Uint<8>", value: `${name}Value as Uint<8>` }];
    }
    body.push(`const ${name}Cbor = ${id}_${name}Cbor();`, `assert(cborUint<${cbor[name]}>(${name}Cbor) == ${name}Value, "action cbor uint");`);
    return [{ c: uintHead(cbor[name]) }, segment(`${name}Cbor`, cbor[name])];
  };
  const text = name => [{ c: textHead(width(name)) }, segment(name, width(name))];
  const digest = [{ c: [...utf8(ACTION_DIGEST_DOMAIN)] }, ...(action === "payment"
    ? [{ c: [0xa5, 0x00, ...cborText(utf8("payment")), 0x01] }, ...text("asset"), { c: [0x02] }, ...uint("amount"), { c: [0x03] }, ...text("counterparty"), { c: [0x04] }, ...uint("ts")]
    : [{ c: [0xa3, 0x00, ...cborText(utf8("egress")), 0x01] }, ...text("destination"), { c: [0x02] }, ...uint("ts")])];
  // Adjacent constants join, so the hash lists one run of constant bytes between two values.
  const digestParts = merged(digest).flatMap(part => (part.c === undefined ? [part] : constant(part.c)));
  body.push(
    `hexOfHash(actionDigest, ${hashOf(digestParts)});`,
    `const commitment = ${id}_commitment();`,
    "hexOfBytes(mandateCommitment, commitment);",
    `const atoms = ${id}_atoms();`,
    `assert(${hashOf([
      { type: "Bytes<32>", value: `pad(32, ${JSON.stringify(ATOMS_DOMAIN)})` }, { type: "Vector<32, Uint<8>>", value: "commitment" },
      ...ATOM_FIELDS.map(([name, type]) => ({ type, value: `atoms.${name}` })),
    ])} == s.atoms, "mandate atoms mismatch");`,
    `const window = ${id}_window();`,
    "windowOf(tsValue, enforcedAtValue, atoms.windowSeconds, window.q, window.r, window.rClock);",
    'assert(window.q == s.windowIndex, "window index");',
  );
  if (action === "payment") body.push(`const assetOk = ${hashOf([segment("asset", width("asset"))])} == atoms.assetDigest;`);
  if (depth !== undefined) {
    body.push(
      `const path = ${id}_path();`,
      `const memberOk = allowlistRoot<${depth}>(${hashOf([...leafPrefix(width(party)), segment(party, width(party))])}, path) == atoms.${action === "payment" ? "counterpartyRoot" : "egressRoot"};`,
    );
  }
  const member = depth === undefined ? "false" : "memberOk";
  const decide = action === "payment"
    ? `0, tsValue, amountValue, assetOk, ${member}, s.priorSpent, false`
    : `1, tsValue, 0, false, false, s.priorSpent, ${member}`;
  body.push(
    `const verdict = CV_decide(enforcedAtValue, atoms.notBefore, atoms.notAfter, atoms.capAmount, atoms.egressMode, ${decide});`,
    'assert(verdict != 5 && verdict != 7, "non-membership not provable");',
    'assert(verdict == s.verdict, "verdict mismatch");',
    `assert(verdict == ${verdict}, "recorded decision");`,
    "conductStep = disclose(s);",
  );
  out.push(...body.map(line => `  ${line}`), "}", "");
  return out;
}

/** The depths the steps unit compiles a pure probe of the path gadget at. */
export const PATH_PROBE_DEPTHS = [1, 2, 3, 4, 5, 6];
const STEP_PROBES = [
  ...PATH_PROBE_DEPTHS.map(d => [`allowlist_root_d${d}`, `leaf: Bytes<32>, path: Vector<${d}, PathStep>`, "Bytes<32>", `allowlistRoot<${d}>(leaf, path)`]),
  ["window_split", "ts: Uint<64>, clock: Uint<64>, w: Uint<64>, q: Uint<64>, r: Uint<64>, rClock: Uint<64>", "[]", "windowOf(ts, clock, w, q, r, rClock)"],
  ["hex_of_bytes", `${vector(64)}, b: Vector<32, Uint<8>>`, "[]", "hexOfBytes(v, b)"],
];

/**
 * The Compact source of the step circuits of every class in classes.json, and the pure probes of their gadgets.
 * @returns {string}
 */
export function emitSteps() {
  const struct = (name, fields) => [`export struct ${name} {`, fields.map(([key, type]) => `  ${key}: ${type}`).join(",\n"), "}"];
  const out = [
    "// Generated from templates/guard-event-v1.json and classes.json by scripts/compile-conduct.mjs --write.",
    "pragma language_version 0.23;",
    "import CompactStandardLibrary;",
    'include "gadgets";',
    "import ConductGadgets;",
    'include "verdict_core";',
    "import ConductVerdict prefix CV_;",
    "",
    ...struct("ConductStep", STEP_FIELDS), "export ledger conductStep: ConductStep;", "",
    ...struct("MandateAtoms", ATOM_FIELDS), "",
    ...struct("WindowSplit", WINDOW_FIELDS.map(name => [name, "Uint<64>"])), "",
  ];
  for (const [id, stepClassOf] of Object.entries(CLASSES.steps)) out.push(...stepCircuit(id, stepClassOf));
  for (const [name, parameters, returns, call] of STEP_PROBES) out.push(`export pure circuit ${name}(${parameters}): ${returns} {`, `  return ${call};`, "}", "");
  return out.join("\n");
}

// A mandate DID is did:key:z and 8 to 256 base58 characters.
const DID_TAIL = { min: 8, max: 256 };
const VISIBILITIES = ["public", "private", "secret"];

/**
 * How many exact-length classes, and so circuits and verifier keys, the v1 encodings span. Arithmetic over the
 * template's bounds, not a measurement: the whole payment-action envelope, the same with ten-digit times and one asset,
 * the pairs of DID lengths of a mandate, and what a fixed-width encoding would leave per template (the trace sequence's
 * digits and the visibility's length).
 * @returns {{ paymentActionEnvelope: bigint, paymentActionFixedTimesAndAsset: bigint, mandateDidPairs: bigint, fixedWidthPerTemplate: bigint }}
 */
export function classCounts() {
  const lengths = spec => (spec.lex === "vis" ? BigInt(new Set(VISIBILITIES.map(v => v.length)).size) : spec.max === undefined ? 1n : BigInt(spec.max));
  const specs = [...valueSpecs("payment-action").values()];
  const product = list => list.reduce((n, spec) => n * lengths(spec), 1n);
  const dids = BigInt(DID_TAIL.max - DID_TAIL.min + 1);
  return {
    paymentActionEnvelope: product(specs),
    paymentActionFixedTimesAndAsset: product(specs.filter(spec => !["ts", "enforcedAt", "asset"].includes(spec.v))),
    mandateDidPairs: dids * dids,
    fixedWidthPerTemplate: product(specs.filter(spec => ["traceSeq", "vis"].includes(spec.v))),
  };
}
