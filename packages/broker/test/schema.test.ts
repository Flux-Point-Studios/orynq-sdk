import { readFileSync } from "node:fs";
import { CBOR } from "@cbortech/cbor";
import {
  CDDL,
  type CddlGroup,
  type CddlGroupEntry,
  type CddlSchema,
  type CddlType,
  type CddlType1,
  type CddlType2,
} from "@cbortech/cbor/cddl";
import { actionDigestHex, bytesToHex, cborDecode, cborEncode } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { array, bytes, jsonToCbor, jsonToDcbor, map, text, uint, type Shape } from "../src/dcbor.js";
import { RpcError } from "../src/errors.js";
import { decodeRequest } from "../src/framing.js";
import { METHOD_PARAMS, SCHEMA_RULES, schemaRules, type EffectKind } from "../src/schema.js";
import { MAX_REQUEST_VALUES, parseJsonPayload } from "../src/strict-json.js";

// The CDDL in docs/ is normative and @cbortech/cbor judges it; src/schema.ts is its runtime
// form. Every vector, and every bound probe generated below, must get one verdict from both.

type Path = readonly (string | number)[];
interface Patch { readonly path: Path; readonly json?: unknown; readonly cdn?: string; readonly remove?: true }
interface Valid { readonly name: string; readonly rule: string; readonly json: unknown; readonly cdn: string }
interface Invalid { readonly name: string; readonly base: string; readonly patch: readonly Patch[]; readonly refusedBy: readonly ("profile" | "cddl")[] }
interface VectorFile { readonly extension?: string; readonly valid: readonly Valid[]; readonly invalid: readonly Invalid[] }

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const CDDL_SOURCE = ["params.cddl", "mandate-draft.cddl", "release.cddl"].map(file => read(`../docs/${file}`)).join("\n");
const FILES = ["mandate-draft", "params", "release"].map(name => [name, JSON.parse(read(`./vectors/${name}.json`)) as VectorFile] as const);

// The runtime form of the vectors' test-only effect kinds (see each file's `extension`).
const TEST_EFFECTS: Readonly<Record<string, EffectKind>> = {
  "test.echo": { params: map({ message: text(64, { minBytes: 1 }) }), effect: map({ message: text(64, { minBytes: 1 }) }) },
  "test.raw": { params: map({ tx: bytes(1, 16384) }), effect: bytes(1, 16384) },
};

const compile = (extension: string | undefined): CddlSchema => CDDL.compile(`${CDDL_SOURCE}\n${extension ?? ""}`);
const rulesFor = (file: VectorFile) => (file.extension === undefined ? SCHEMA_RULES : schemaRules(TEST_EFFECTS));
const shapeOf = (rules: Readonly<Record<string, Shape>>, rule: string): Shape => {
  const shape = rules[rule];
  if (!shape) throw new Error(`no runtime shape for rule ${rule}`);
  return shape;
};

const wire = (json: unknown) => new TextEncoder().encode(JSON.stringify(json));
const profile = (json: unknown, shape: Shape) => jsonToDcbor(parseJsonPayload(wire(json)), shape);
const cddlVerdict = (schema: CddlSchema, cbor: Uint8Array, rule: string) => schema.validate(cbor, { rule });

function profileRefusal(json: unknown, shape: Shape): RpcError | undefined {
  try {
    profile(json, shape);
    return undefined;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
}

function refusedPayload(payload: Uint8Array): unknown {
  try {
    parseJsonPayload(payload);
  } catch (error) {
    return ((error as RpcError).cause as { code?: unknown }).code;
  }
  throw new Error("payload accepted");
}

function patched(target: unknown, path: Path, change: { remove: true } | { value: unknown }): unknown {
  const root = structuredClone(target);
  let parent = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if ("remove" in change) {
    if (!(last in parent)) throw new Error(`patch removes missing ${path.join(".")}`);
    delete parent[last];
  } else {
    parent[last] = change.value;
  }
  return root;
}

for (const [name, file] of FILES) {
  describe(`${name} vectors`, () => {
    const schema = compile(file.extension);
    const rules = rulesFor(file);
    const valid = new Map(file.valid.map(v => [v.name, v]));

    it("compile without warnings and name distinct vectors", () => {
      expect(schema.warnings ?? []).toEqual([]);
      expect(new Set([...file.valid, ...file.invalid].map(v => v.name)).size).toBe(file.valid.length + file.invalid.length);
    });

    it.each(file.valid.map(v => [v.name, v] as const))("valid: %s", (_, vector) => {
      const cbor = CBOR.cdnToCbor(vector.cdn);
      const verdict = cddlVerdict(schema, cbor, vector.rule);
      expect(verdict.errors ?? []).toEqual([]);
      expect(verdict.valid).toBe(true);
      expect(bytesToHex(cborEncode(cborDecode(cbor)))).toBe(bytesToHex(cbor));
      expect(bytesToHex(profile(vector.json, shapeOf(rules, vector.rule)))).toBe(bytesToHex(cbor));
    });

    it.each(file.invalid.map(v => [v.name, v] as const))("invalid: %s", (_, vector) => {
      const base = valid.get(vector.base);
      if (!base) throw new Error(`unknown base ${vector.base}`);
      let json = base.json;
      let cdn: unknown = CBOR.parse(base.cdn);
      const touched = new Set<string>();
      for (const patch of vector.patch) {
        if (patch.remove) {
          json = patched(json, patch.path, { remove: true });
          cdn = patched(cdn, patch.path, { remove: true });
          touched.add("profile").add("cddl");
          continue;
        }
        if ("json" in patch) {
          json = patched(json, patch.path, { value: patch.json });
          touched.add("profile");
        }
        if (patch.cdn !== undefined) {
          cdn = patched(cdn, patch.path, { value: CBOR.parse(patch.cdn) });
          touched.add("cddl");
        }
      }
      expect([...touched].sort()).toEqual([...vector.refusedBy].sort());
      if (touched.has("profile")) {
        const refusal = profileRefusal(json, shapeOf(rules, base.rule));
        expect(refusal?.code).toBe(-32602);
      }
      if (touched.has("cddl")) {
        expect(cddlVerdict(schema, CBOR.encode(cdn), base.rule).valid).toBe(false);
      }
    });
  });
}

// The runtime shapes are a second spelling of the CDDL, so every node of every rule is probed at
// its bounds and both sides must give the same verdict on each probe: integers at min - 1, min,
// max and max + 1; texts, byte strings and arrays at the sizes around both bounds; every present
// member removed; an unknown member added; every literal changed. The probes run on the vectors'
// valid instances. A member or choice no vector reaches gets an instance built from the runtime
// shape (every optional member present, the choices on its path taken), which both sides must
// accept before it is probed, so no runtime node goes unprobed. In the other direction, every
// alternative of every choice the CDDL's rules reach (type choices, group choices and socket
// extensions) gets an instance built from the CDDL the same way, which both sides must accept,
// so an alternative, literal or optional member that only the CDDL has, or that the runtime
// lacks, fails the suite.
describe("CDDL and runtime agree at every bound", () => {
  const extension = FILES.find(([, file]) => file.extension !== undefined)?.[1].extension;
  const schema = compile(extension);
  const rules = schemaRules(TEST_EFFECTS);

  interface Instance { readonly json: unknown; readonly cbor: unknown }
  interface Base extends Instance { readonly name: string; readonly rule: string }
  interface Occurrence extends Instance { readonly shape: Shape; readonly base: Base; readonly path: Path }
  interface Probe { readonly label: string; readonly path: Path; readonly json?: unknown; readonly cbor?: unknown; readonly remove?: true }

  const accepts = (json: unknown, shape: Shape) => {
    try {
      jsonToCbor(json, shape);
      return true;
    } catch (error) {
      if (error instanceof RpcError) return false;
      throw error;
    }
  };
  const child = (value: unknown, key: string | number) => (value as Record<string | number, unknown>)[key];
  const uintJson = (shape: Extract<Shape, { type: "uint" }>, value: bigint) => (shape.max <= 2n ** 53n ? Number(value) : value.toString());

  // Every node a rule's shape can reach: members (optional ones included), array items (unless
  // the array must be empty) and choice options, named like `rule.member[]|option`.
  function schemaPaths(shape: Shape, at: string, out: string[] = []): string[] {
    out.push(at);
    if (shape.type === "map") for (const [name, field] of shape.fields) schemaPaths(field.shape, `${at}.${name}`, out);
    if (shape.type === "array" && shape.max > 0) schemaPaths(shape.items, `${at}[]`, out);
    if (shape.type === "choice") shape.options.forEach((option, k) => schemaPaths(option, `${at}|${k}`, out));
    return out;
  }

  const occurrences = new Map<string, Occurrence>();
  const itemSamples = new Map<Shape, Instance>();
  const patternSamples = new Map<string, string>();

  function walk(shape: Shape, node: Instance, path: Path, at: string, base: Base) {
    if (!occurrences.has(at)) occurrences.set(at, { shape, base, path, ...node });
    if (!itemSamples.has(shape)) itemSamples.set(shape, node);
    if (shape.type === "text" && shape.pattern) patternSamples.set(shape.pattern.source, node.json as string);
    if (shape.type === "map") {
      for (const [name, field] of shape.fields) {
        if (Object.hasOwn(node.json as object, name)) {
          walk(field.shape, { json: child(node.json, name), cbor: child(node.cbor, name) }, [...path, name], `${at}.${name}`, base);
        }
      }
    } else if (shape.type === "array") {
      (node.json as unknown[]).forEach((item, i) => walk(shape.items, { json: item, cbor: child(node.cbor, i) }, [...path, i], `${at}[]`, base));
    } else if (shape.type === "choice") {
      const k = shape.options.findIndex(option => accepts(node.json, option));
      walk(shape.options[k] as Shape, node, path, `${at}|${k}`, base);
    }
  }

  // A valid instance of `shape` with every optional member present and one item per array that
  // may hold one; `options` picks the choice taken at a schema path (otherwise the first).
  function build(shape: Shape, at: string, options: ReadonlyMap<string, number>): Instance {
    switch (shape.type) {
      case "uint":
        return { json: uintJson(shape, shape.min), cbor: shape.min };
      case "text": {
        const text = shape.pattern ? patternSamples.get(shape.pattern.source) : "a".repeat(Math.max(shape.minBytes, 1));
        if (text === undefined) throw new Error(`no vector holds a text matching ${shape.pattern?.source}`);
        return { json: text, cbor: text };
      }
      case "bytes":
        return { json: "00".repeat(shape.minSize), cbor: new Uint8Array(shape.minSize) };
      case "literal":
        return { json: typeof shape.value === "bigint" ? Number(shape.value) : shape.value, cbor: shape.value };
      case "array": {
        const items = shape.max > 0 ? [build(shape.items, `${at}[]`, options)] : [];
        return { json: items.map(item => item.json), cbor: items.map(item => item.cbor) };
      }
      case "map": {
        const members = [...shape.fields].map(([name, field]) => [name, build(field.shape, `${at}.${name}`, options)] as const);
        return {
          json: Object.fromEntries(members.map(([name, member]) => [name, member.json])),
          cbor: Object.fromEntries(members.map(([name, member]) => [name, member.cbor])),
        };
      }
      case "choice": {
        const k = options.get(at) ?? 0;
        return build(shape.options[k] as Shape, `${at}|${k}`, options);
      }
    }
  }

  for (const [, file] of FILES) {
    for (const { name, rule, json, cdn } of file.valid) {
      const base = { name, rule, json, cbor: CBOR.parse(cdn) };
      walk(shapeOf(rules, rule), base, [], rule, base);
    }
  }
  const builtBases: Base[] = [];
  for (const [rule, shape] of Object.entries(rules)) {
    for (const at of schemaPaths(shape, rule)) {
      if (occurrences.has(at)) continue;
      const options = new Map([...at.matchAll(/\|(\d+)/g)].map(match => [at.slice(0, match.index), Number(match[1])] as const));
      const base = { name: `built for ${at}`, rule, ...build(shape, rule, options) };
      builtBases.push(base);
      walk(shape, base, [], rule, base);
    }
  }

  // A choice the CDDL offers: a rule's alternatives, its /= and //= extensions included, keyed by
  // the rule's name, or an inline type's or group's, keyed by its offset. `picks` maps a key to
  // the option taken (otherwise the first); `seen` collects the choices a build passes through.
  interface Choice<T> { readonly key: string; readonly options: readonly T[] }
  interface Picks { readonly picks: ReadonlyMap<string, number>; readonly seen: Map<string, number> }
  const U64_MAX = 2n ** 64n - 1n;
  const typeChoice = (type: CddlType): Choice<CddlType1> => ({ key: `type@${type.start}`, options: type.alternatives });
  const groupChoice = (group: CddlGroup): Choice<CddlGroupEntry[]> => ({ key: `group@${group.start}`, options: group.choices });

  function ruleType(name: string): Choice<CddlType1> {
    const types = (schema.rules.get(name) ?? []).map(({ body }) => {
      if (body.kind !== "entry" || body.memberKey || body.occur) throw new Error(`${name} is not a type rule`);
      return body.value;
    });
    if (types.length === 0) throw new Error(`the CDDL defines no rule ${name}`);
    return { key: name, options: types.flatMap(type => type.alternatives) };
  }

  function ruleGroup(name: string): Choice<CddlGroupEntry[]> {
    const groups = (schema.rules.get(name) ?? []).map(({ body }) => {
      if (body.kind !== "entry-group") throw new Error(`${name} is not a group rule`);
      return body.group;
    });
    if (groups.length === 0) throw new Error(`the CDDL defines no group ${name}`);
    return { key: name, options: groups.flatMap(group => group.choices) };
  }

  function take<T>(choice: Choice<T>, { picks, seen }: Picks): T {
    if (choice.options.length > 1) seen.set(choice.key, choice.options.length);
    const option = choice.options[picks.get(choice.key) ?? 0];
    if (option === undefined) throw new Error(`${choice.key} offers no option ${picks.get(choice.key) ?? 0}`);
    return option;
  }

  const uintInstance = (value: bigint, max: bigint): Instance => ({ json: max <= 2n ** 53n ? Number(value) : value.toString(), cbor: value });
  const intValue = (node: CddlType2): bigint => {
    if (node.kind !== "value" || node.type !== "int") throw new Error(`expected an integer at ${node.start}`);
    return BigInt(node.value);
  };
  // The smallest size a .size controller allows: `n` or `(min..max)`.
  const minimumSize = (controller: CddlType2): number => {
    if (controller.kind === "paren" && controller.type.alternatives.length === 1) {
      const [range] = controller.type.alternatives;
      if (range!.op?.kind === "range") return Number(intValue(range!.target));
    }
    return Number(intValue(controller));
  };

  function fromType1(node: CddlType1, state: Picks): Instance {
    if (!node.op) return fromType2(node.target, state);
    const ref = node.target.kind === "ref" ? node.target.name : undefined;
    const controller = node.controller as CddlType2;
    const op = node.op.kind === "ctl" ? node.op.name : "range";
    if (op === "size" && (ref === "text" || ref === "tstr")) return { json: "a".repeat(minimumSize(controller)), cbor: "a".repeat(minimumSize(controller)) };
    if (op === "size" && (ref === "bytes" || ref === "bstr")) return { json: "00".repeat(minimumSize(controller)), cbor: new Uint8Array(minimumSize(controller)) };
    if (op === "regexp" && (ref === "text" || ref === "tstr") && controller.kind === "value" && controller.type === "text") {
      const sample = patternSamples.get(new RegExp(`^(?:${controller.value})$`, "u").source);
      if (sample === undefined) throw new Error(`no vector holds a text matching ${controller.value}`);
      return { json: sample, cbor: sample };
    }
    if (op === "le" && ref === "uint") return uintInstance(0n, intValue(controller));
    if (op === "ge" && ref === "uint") return uintInstance(intValue(controller), U64_MAX);
    // The CDDL's own verdict on the whole instance checks the controller.
    if (op === "and") return fromType2(node.target, state);
    throw new Error(`no instance builder for .${op} at ${node.start}`);
  }

  function fromType2(node: CddlType2, state: Picks): Instance {
    switch (node.kind) {
      case "value":
        if (node.type === "text") return { json: node.value, cbor: node.value };
        if (node.type === "int") return { json: Number(node.value), cbor: BigInt(node.value) };
        break;
      case "ref":
        if (node.name === "uint") return uintInstance(0n, U64_MAX);
        if (node.name === "text" || node.name === "tstr") return { json: "", cbor: "" };
        if (node.name === "bytes" || node.name === "bstr") return { json: "", cbor: new Uint8Array(0) };
        return fromType1(take(ruleType(node.name), state), state);
      case "paren":
        return fromType1(take(typeChoice(node.type), state), state);
      case "map": {
        const members = fromEntries(take(groupChoice(node.group), state), state);
        return {
          json: Object.fromEntries(members.map(([name, member]) => [name, member.json])),
          cbor: Object.fromEntries(members.map(([name, member]) => [name, member.cbor])),
        };
      }
      case "array": {
        const items = take(groupChoice(node.group), state).flatMap(entry => {
          if (entry.kind !== "entry" || entry.memberKey) throw new Error(`unsupported array entry at ${entry.start}`);
          const occur = entry.occur;
          const count = !occur ? 1 : occur.marker === "+" ? 1 : Math.max(occur.min ?? 0, (occur.max ?? 1) > 0 ? 1 : 0);
          const item = fromType1(take(typeChoice(entry.value), state), state);
          return Array<Instance>(count).fill(item);
        });
        return { json: items.map(item => item.json), cbor: items.map(item => item.cbor) };
      }
    }
    throw new Error(`no instance builder for a ${node.kind} at ${node.start}`);
  }

  // Map members, with every optional member present and group references inlined.
  function fromEntries(entries: readonly CddlGroupEntry[], state: Picks): (readonly [string, Instance])[] {
    return entries.flatMap(entry => {
      if (entry.kind === "entry-group") return fromEntries(take(groupChoice(entry.group), state), state);
      const key = entry.memberKey;
      if (key?.kind === "bareword") return [[key.key, fromType1(take(typeChoice(entry.value), state), state)] as const];
      if (key?.kind === "value" && key.key.type === "text") return [[key.key.value, fromType1(take(typeChoice(entry.value), state), state)] as const];
      const [reference] = entry.value.alternatives;
      if (key || entry.value.alternatives.length !== 1 || reference!.op || reference!.target.kind !== "ref") {
        throw new Error(`unsupported map entry at ${entry.start}`);
      }
      return fromEntries(take(ruleGroup(reference!.target.name), state), state);
    });
  }

  // From each rule, one build per option of every choice a build reaches, each taking the
  // options on its path.
  const cddlBases: Base[] = [];
  for (const rule of Object.keys(rules)) {
    const queued = new Set<string>();
    const queue: ReadonlyMap<string, number>[] = [new Map()];
    for (let picks = queue.shift(); picks; picks = queue.shift()) {
      const seen = new Map<string, number>();
      const built = fromType1(take(ruleType(rule), { picks, seen }), { picks, seen });
      const label = [...picks].map(([key, k]) => `${key}=${k}`).join(", ");
      cddlBases.push({ name: `CDDL-built ${rule}${label ? ` with ${label}` : ""}`, rule, ...built });
      for (const [key, count] of seen) {
        for (let k = 0; k < count; k++) {
          if (queued.has(`${key}#${k}`)) continue;
          queued.add(`${key}#${k}`);
          if ((picks.get(key) ?? 0) !== k) queue.push(new Map([...picks, [key, k]]));
        }
      }
    }
  }

  const window = (bound: number) => Array.from({ length: 9 }, (_, i) => bound - 4 + i).filter(n => n >= 0);
  const fill = (seed: string, size: number) => (size <= seed.length ? seed.slice(0, size) : seed + (seed.at(-1) ?? "a").repeat(size - seed.length));

  function* probes({ shape, path, json }: Occurrence): Generator<Probe> {
    switch (shape.type) {
      case "uint":
        for (const value of new Set([shape.min - 1n, shape.min, shape.max, shape.max + 1n])) {
          yield { label: `uint ${value}`, path, json: uintJson(shape, value), cbor: value };
        }
        return;
      case "text": {
        const seeds = ["a", "A", "0", ...(typeof json === "string" && /^[ -~]*$/.test(json) ? [json] : [])];
        const sizes = [...new Set([...window(shape.minBytes), ...window(shape.maxBytes)])];
        for (const text of new Set(seeds.flatMap(seed => sizes.map(size => fill(seed, size))))) {
          yield { label: `${text.length}-byte text "${text.slice(0, 12)}…"`, path, json: text, cbor: text };
        }
        return;
      }
      case "bytes":
        for (const size of new Set([shape.minSize - 1, shape.minSize, shape.maxSize, shape.maxSize + 1].filter(n => n >= 0))) {
          yield { label: `${size} bytes`, path, json: "00".repeat(size), cbor: new Uint8Array(size) };
        }
        return;
      case "literal":
        yield typeof shape.value === "string"
          ? { label: "another text", path, json: `${shape.value}x`, cbor: `${shape.value}x` }
          : { label: "another uint", path, json: Number(shape.value) + 1, cbor: shape.value + 1n };
        return;
      case "array": {
        const item = itemSamples.get(shape.items);
        if (!item) throw new Error(`no sample item for ${path.join(".")}`);
        for (const size of new Set([shape.min - 1, shape.min, shape.max, shape.max + 1].filter(n => n >= 0))) {
          yield { label: `${size} items`, path, json: Array(size).fill(item.json), cbor: Array(size).fill(item.cbor) };
        }
        return;
      }
      case "map":
        for (const name of shape.fields.keys()) {
          if (Object.hasOwn(json as object, name)) yield { label: `without ${name}`, path: [...path, name], remove: true };
        }
        yield { label: "with an unknown member", path: [...path, "zzUnknown"], json: 0, cbor: 0 };
        return;
      case "choice":
        return;
    }
  }

  const apply = (target: unknown, probe: Probe, value: unknown) => patched(target, probe.path, probe.remove ? { remove: true } : { value });
  const runtimeAccepts = (json: unknown, rule: string) => profileRefusal(json, shapeOf(rules, rule)) === undefined;
  const cddlAccepts = (cbor: unknown, rule: string) => cddlVerdict(schema, CBOR.encode(cbor), rule).valid;
  const verdict = (judge: () => boolean) => {
    try {
      return judge() ? "accepts" : "refuses";
    } catch (error) {
      return `throws ${(error as Error).name}`;
    }
  };

  it("reaches every member and choice of every rule", () => {
    const expected = Object.entries(rules).flatMap(([rule, shape]) => schemaPaths(shape, rule));
    expect(expected.filter(at => !occurrences.has(at))).toEqual([]);
    expect(occurrences.size).toBe(expected.length);
  });

  it("accepts on both sides every instance built for a node no vector reaches", () => {
    const refused = builtBases
      .map(base => ({ name: base.name, runtime: runtimeAccepts(base.json, base.rule), cddl: cddlAccepts(base.cbor, base.rule) }))
      .filter(verdict => !verdict.runtime || !verdict.cddl);
    expect(refused).toEqual([]);
  });

  it("accepts on both sides an instance built from the CDDL for every option of every choice", () => {
    const refused = cddlBases
      .map(base => ({ name: base.name, runtime: runtimeAccepts(base.json, base.rule), cddl: cddlAccepts(base.cbor, base.rule) }))
      .filter(verdict => !verdict.runtime || !verdict.cddl);
    expect(refused).toEqual([]);
    expect(cddlBases.length).toBeGreaterThan(Object.keys(rules).length);
  });

  it.each(Object.keys(rules))("%s: the CDDL and the runtime give every probe one verdict", rule => {
    const disagreements: string[] = [];
    let count = 0;
    for (const [at, occurrence] of occurrences) {
      if (occurrence.base.rule !== rule) continue;
      for (const probe of probes(occurrence)) {
        count++;
        const runtime = verdict(() => runtimeAccepts(apply(occurrence.base.json, probe, probe.json), rule));
        const cddl = verdict(() => cddlAccepts(apply(occurrence.base.cbor, probe, probe.cbor), rule));
        if (runtime !== cddl || runtime.startsWith("throws")) disagreements.push(`${at} ${probe.label}: runtime ${runtime}, CDDL ${cddl}`);
        if (disagreements.length === 20) break;
      }
      if (disagreements.length === 20) break;
    }
    expect(disagreements).toEqual([]);
    expect(count).toBeGreaterThan(0);
  }, 120_000);
});

// The schema cannot see these, but the release vectors are the golden inputs verifyRelease will
// replay (§3.2, §4.1, §4.4), so each must also be a release an honest B could send.
describe("release vectors replay as honest releases", () => {
  interface WireAction { readonly kind: "payment"; readonly asset: string; readonly amount: string; readonly counterparty: string; readonly timestamp: string }
  interface WireStep {
    readonly event: { readonly seq: string; readonly mandateCommitment: string; readonly actionDigest: string; readonly action: WireAction };
    readonly traceMeta: { readonly id: string; readonly seq: string };
  }
  interface WireMandate { readonly C: string; readonly head: { readonly guardLog: { readonly count: string }; readonly trace: { readonly seq: string } }; readonly steps: readonly WireStep[] }

  const [, release] = FILES.find(([name]) => name === "release")!;
  const requests = release.valid.filter(v => v.rule === "release-request" && (v.json as { mandates: unknown[] }).mandates.length > 0);

  it.each(requests.map(v => [v.name, v.json as { mandates: readonly WireMandate[] }] as const))("%s", (_, request) => {
    const mandates = request.mandates;
    expect(mandates.map(m => m.C)).toEqual(mandates.map(m => m.C).sort());
    const steps = mandates.flatMap(m => m.steps);
    for (const m of mandates) {
      expect(new Set(m.steps.map(step => step.event.action.asset)).size).toBe(1);
      m.steps.forEach((step, i) => {
        expect(step.event.mandateCommitment).toBe(m.C);
        expect(BigInt(step.event.seq)).toBe(BigInt(m.head.guardLog.count) + BigInt(i));
        expect(BigInt(step.traceMeta.seq)).toBe(BigInt(m.head.trace.seq) + BigInt(i));
      });
    }
    for (const { event: { action, actionDigest } } of steps) {
      expect(actionDigest).toBe(actionDigestHex({ ...action, amount: BigInt(action.amount), timestamp: BigInt(action.timestamp) }));
    }
    // Outflows are summed per counterparty, so no counterparty appears twice in one intent.
    expect(new Set(steps.map(step => step.event.action.counterparty)).size).toBe(steps.length);
    expect(new Set(steps.map(step => step.traceMeta.id)).size).toBe(steps.length);
  });
});

describe("runtime schema", () => {
  const cddlRules = new Set([...CDDL_SOURCE.matchAll(/^([a-z0-9-]+) =/gm)].map(match => match[1]));

  it("gives every §6.2 method a params rule that the CDDL defines", () => {
    expect(Object.keys(METHOD_PARAMS).sort()).toEqual([
      "broker.hello", "credential.list", "intent.submit", "mandate.get", "mandate.prepare", "mandate.register",
      "mandate.revoke", "release.commit", "release.history", "session.close", "session.open",
    ]);
    for (const rule of Object.values(METHOD_PARAMS)) {
      expect(cddlRules).toContain(rule);
      expect(SCHEMA_RULES).toHaveProperty([rule]);
    }
  });

  it("names only CDDL rules, and each has a valid vector", () => {
    const covered = new Set(FILES.flatMap(([, file]) => file.valid.map(v => v.rule)));
    for (const rule of Object.keys(SCHEMA_RULES)) {
      expect(cddlRules).toContain(rule);
      expect(covered).toContain(rule);
    }
  });

  it("writes every text pattern exactly as the CDDL's .regexp does", () => {
    const patterns = new Set<string>();
    const walk = (shape: Shape): void => {
      if (shape.type === "text" && shape.pattern) patterns.add(shape.pattern.source.slice("^(?:".length, -")$".length));
      if (shape.type === "array") walk(shape.items);
      if (shape.type === "map") for (const field of shape.fields.values()) walk(field.shape);
      if (shape.type === "choice") shape.options.forEach(walk);
    };
    Object.values(schemaRules(TEST_EFFECTS)).forEach(walk);
    expect(patterns.size).toBeGreaterThanOrEqual(9);
    for (const pattern of patterns) expect(CDDL_SOURCE).toContain(`.regexp ${JSON.stringify(pattern)}`);
  });

  // Counted as the strict JSON parser counts: every container and scalar, keys excluded. The
  // request envelope adds the object and its jsonrpc, id and method values.
  const valuesAtMost = (shape: Shape): number => {
    switch (shape.type) {
      case "array":
        return 1 + shape.max * valuesAtMost(shape.items);
      case "map":
        return 1 + [...shape.fields.values()].reduce((sum, field) => sum + valuesAtMost(field.shape), 0);
      case "choice":
        return Math.max(0, ...shape.options.map(valuesAtMost));
      default:
        return 1;
    }
  };
  const valuesIn = (json: unknown): number =>
    json === null || typeof json !== "object"
      ? 1
      : 1 + (Array.isArray(json) ? json : Object.values(json)).reduce((sum: number, item) => sum + valuesIn(item), 0);

  it("holds the largest params of every method, in a request, within MAX_REQUEST_VALUES", () => {
    for (const rules of [SCHEMA_RULES, schemaRules(TEST_EFFECTS)]) {
      for (const rule of Object.values(METHOD_PARAMS)) {
        expect(4 + valuesAtMost(rules[rule])).toBeLessThanOrEqual(MAX_REQUEST_VALUES);
      }
    }
  });

  it("decodes the largest release.commit: 8 mandates of 258 steps with every optional member", () => {
    const rules = schemaRules(TEST_EFFECTS);
    const [, release] = FILES.find(([name]) => name === "release")!;
    const vector = release.valid.find(v => v.name === "committee release over two mandates with a proof and instanceSig")!;
    const params = vector.json as { mandates: { steps: { proof?: unknown }[] }[] };
    const mandate = params.mandates[0]!;
    const step = params.mandates.flatMap(m => m.steps).find(s => s.proof !== undefined)!;
    const largest = {
      ...params,
      kind: "test.echo",
      effect: { message: "m" },
      mandates: Array(8).fill({ ...mandate, steps: Array(258).fill(step) }),
    };
    const request = decodeRequest(wire({ jsonrpc: "2.0", id: 1, method: "release.commit", params: largest }));
    expect(() => jsonToCbor(request.params, rules["release-request"])).not.toThrow();
    expect(valuesIn(request.params)).toBe(valuesAtMost(rules["release-request"]));
    expect(4 + valuesIn(request.params)).toBeGreaterThan(49_000);
  });

  // The largest release.commit the rules allow for an effect of `n` uints: every other member is
  // the vector's, so the request holds exactly the values the rule's shapes can.
  const filler = (n: number): EffectKind => ({ params: map({}), effect: array(uint({ max: 9n }), 0, n) });
  const fullRelease = (n: number) => {
    const [, release] = FILES.find(([name]) => name === "release")!;
    const vector = release.valid.find(v => v.name === "committee release over two mandates with a proof and instanceSig")!;
    const params = vector.json as { mandates: { steps: { proof?: unknown }[] }[] };
    const step = params.mandates.flatMap(m => m.steps).find(s => s.proof !== undefined)!;
    return {
      ...params,
      kind: "ext.fill",
      effect: Array(n).fill(0),
      mandates: Array(8).fill({ ...params.mandates[0]!, steps: Array(258).fill(step) }),
    };
  };
  const room = MAX_REQUEST_VALUES - 4 - valuesAtMost(schemaRules({ "ext.fill": filler(0) })["release-request"]);

  it("registers an effect kind whose largest request holds exactly MAX_REQUEST_VALUES, and decodes that request", () => {
    expect(room).toBeGreaterThan(0);
    const rules = schemaRules({ "ext.fill": filler(room) });
    expect(4 + valuesAtMost(rules["release-request"])).toBe(MAX_REQUEST_VALUES);
    const request = decodeRequest(wire({ jsonrpc: "2.0", id: 1, method: "release.commit", params: fullRelease(room) }));
    expect(4 + valuesIn(request.params)).toBe(MAX_REQUEST_VALUES);
    expect(() => jsonToCbor(request.params, rules["release-request"])).not.toThrow();
  });

  it("refuses to register an effect kind that would let a valid request exceed MAX_REQUEST_VALUES", () => {
    const refused = (effects: Readonly<Record<string, EffectKind>>) => {
      try {
        schemaRules(effects);
      } catch (error) {
        expect(error).toBeInstanceOf(RangeError);
        return (error as RangeError).message;
      }
      throw new Error("registered");
    };
    expect(refused({ "ext.fill": filler(room + 1) }))
      .toBe("a request for release-request could hold 65537 JSON values, above MAX_REQUEST_VALUES (65536)");
    // The request the registration refuses is the one the parser would refuse.
    expect(refusedPayload(wire({ jsonrpc: "2.0", id: 1, method: "release.commit", params: fullRelease(room + 1) })))
      .toBe("JSON_VALUES");
    const wideParams: EffectKind = { params: array(uint(), 0, MAX_REQUEST_VALUES), effect: bytes(1) };
    expect(refused({ "ext.wide": wideParams })).toContain("a request for intent-submit-params could hold ");
    // One oversized kind is refused however many fit beside it.
    expect(refused({ ...TEST_EFFECTS, "ext.fill": filler(room + 1) })).toContain("release-request");
    for (const max of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refused({ "ext.open": { params: map({}), effect: array(uint(), 0, max) } })).toContain("release-request");
    }
  });

  it("refuses every effect while no effect kind is registered", () => {
    const [, params] = FILES.find(([name]) => name === "params")!;
    const [, release] = FILES.find(([name]) => name === "release")!;
    for (const vector of [...params.valid, ...release.valid].filter(v => v.rule === "intent-submit-params" || v.rule === "release-request")) {
      expect(profileRefusal(vector.json, shapeOf(SCHEMA_RULES, vector.rule))).toMatchObject({ code: -32602, field: "params" });
      expect(cddlVerdict(compile(undefined), CBOR.cdnToCbor(vector.cdn), vector.rule).valid).toBe(false);
    }
  });
});
