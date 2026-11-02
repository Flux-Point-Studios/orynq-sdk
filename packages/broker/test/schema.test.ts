import { readFileSync } from "node:fs";
import { CBOR } from "@cbortech/cbor";
import { CDDL, type CddlSchema } from "@cbortech/cbor/cddl";
import { bytesToHex, cborDecode, cborEncode } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { bytes, jsonToDcbor, map, text, type Shape } from "../src/dcbor.js";
import { RpcError } from "../src/errors.js";
import { METHOD_PARAMS, SCHEMA_RULES, schemaRules, type EffectKind } from "../src/schema.js";
import { parseJsonPayload } from "../src/strict-json.js";

// The CDDL in docs/ is normative and @cbortech/cbor judges it; src/schema.ts is its runtime
// form. Every vector must get the same verdict from both.

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

describe("array bounds agree", () => {
  const params = new Map(FILES.flatMap(([, file]) => file.valid.map(v => [v.name, [v, file] as const])));
  const cases: [string, Path, number][] = [
    ["minimal draft", ["members"], 256],
    ["mandate.register with a WebAuthn assertion", ["members"], 256],
    ["intent.submit minimal", ["mandates"], 8],
    ["intent.submit with expect, wait and note", ["expect", "outflows"], 256],
    ["session.open", ["mandates"], 16],
    ["in-mandate release with one call step", ["mandates"], 8],
    ["in-mandate release with one call step", ["mandates", 0, "steps"], 258],
    ["release record with proof references", ["heads"], 8],
    ["release record with proof references", ["proofRefs"], 258],
  ];
  const at = (value: unknown, path: Path) => path.reduce((node: unknown, key) => (node as Record<string | number, unknown>)[key], value) as unknown[];

  it.each(cases)("%s: %j holds at most %i", (name, path, max) => {
    const [vector, file] = params.get(name) ?? [];
    if (!vector || !file) throw new Error(`no vector ${name}`);
    const schema = compile(file.extension);
    const shape = shapeOf(rulesFor(file), vector.rule);
    const cdn = CBOR.parse(vector.cdn);
    for (const [size, accepted] of [[max, true], [max + 1, false]] as const) {
      const json = patched(vector.json, path, { value: Array.from({ length: size }, () => at(vector.json, path)[0]) });
      const cbor = patched(cdn, path, { value: Array.from({ length: size }, () => at(cdn, path)[0]) });
      expect(profileRefusal(json, shape) === undefined).toBe(accepted);
      expect(cddlVerdict(schema, CBOR.encode(cbor), vector.rule).valid).toBe(accepted);
    }
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

  it("refuses every effect while no effect kind is registered", () => {
    const [, params] = FILES.find(([name]) => name === "params")!;
    const [, release] = FILES.find(([name]) => name === "release")!;
    for (const vector of [...params.valid, ...release.valid].filter(v => v.rule === "intent-submit-params" || v.rule === "release-request")) {
      expect(profileRefusal(vector.json, shapeOf(SCHEMA_RULES, vector.rule))).toMatchObject({ code: -32602, field: "params" });
      expect(cddlVerdict(compile(undefined), CBOR.cdnToCbor(vector.cdn), vector.rule).valid).toBe(false);
    }
  });
});
