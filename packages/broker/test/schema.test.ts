import { readFileSync } from "node:fs";
import { CBOR } from "@cbortech/cbor";
import { CDDL, type CddlSchema } from "@cbortech/cbor/cddl";
import { bytesToHex, cborDecode, cborEncode } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { bytes, jsonToCbor, jsonToDcbor, map, text, type Shape } from "../src/dcbor.js";
import { RpcError } from "../src/errors.js";
import { METHOD_PARAMS, SCHEMA_RULES, schemaRules, type EffectKind } from "../src/schema.js";
import { parseJsonPayload } from "../src/strict-json.js";

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
// accept before it is probed, so no node of any rule goes unprobed.
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

  it("refuses every effect while no effect kind is registered", () => {
    const [, params] = FILES.find(([name]) => name === "params")!;
    const [, release] = FILES.find(([name]) => name === "release")!;
    for (const vector of [...params.valid, ...release.valid].filter(v => v.rule === "intent-submit-params" || v.rule === "release-request")) {
      expect(profileRefusal(vector.json, shapeOf(SCHEMA_RULES, vector.rule))).toMatchObject({ code: -32602, field: "params" });
      expect(cddlVerdict(compile(undefined), CBOR.cdnToCbor(vector.cdn), vector.rule).valid).toBe(false);
    }
  });
});
