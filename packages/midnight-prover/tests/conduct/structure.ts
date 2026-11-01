import { PREDICATE_LAYOUT, type PredicateInput } from "@fluxpointstudios/orynq-sdk-conduct";
import { generatedSource, unitSource } from "./harness.js";
import { referenceOpenings } from "./opening-reference.js";

const AUDITED_FILES = ["verdict_core.compact", "predicate.compact"] as const;
type AuditedFile = (typeof AUDITED_FILES)[number];
type Sources = Readonly<Record<AuditedFile, string>>;

export const predicateSources = (unit = "predicate"): Sources =>
  Object.fromEntries(AUDITED_FILES.map(file => [file, unitSource(unit, file)])) as Sources;

/** Each file's declarations in order: every declaration but a circuit verbatim, each circuit by name, and each module's bounds. */
const AUDITED_OUTLINES: Readonly<Record<AuditedFile, readonly string[]>> = {
  "verdict_core.compact": ["module ConductVerdict {", "import CompactStandardLibrary;", "circuit ConductVerdict.evaluate", "circuit ConductVerdict.decide", "}"],
  "predicate.compact": [
    "pragma language_version 0.23;", "import CompactStandardLibrary;", 'include "verdict_core";', "import ConductVerdict prefix CV_;",
    "export ledger verdictOut: Uint<8>;", "circuit evaluate", "circuit guard_verdict", "circuit check_verdict",
  ],
};

/** Every numeric literal inside a circuit body: the verdict codes 0-7, the kind and mode tests, the domain bounds and the amount floor. */
const AUDITED_LITERALS: readonly string[] = ["0", "0", "0", "0", "1", "1", "1", "1", "1", "2", "2", "3", "4", "5", "6", "7"];

const COMPACT_TYPES: Readonly<Record<PredicateInput["type"], string>> = { uint64: "Uint<64>", uint8: "Uint<8>", field: "Field", boolean: "Boolean" };
const PREDICATE_PARAMS = PREDICATE_LAYOUT.map(({ name, type }) => `${name}: ${COMPACT_TYPES[type]}`).join(", ");
const CLAIM_CHECK = `guard_verdict(enforced_at, ${PREDICATE_LAYOUT.map(({ name }) => name).join(", ")}) == claimed`;

/** Every comparison, as its left operand, operator and right operand. */
export const AUDITED_COMPARISONS: readonly string[] = [
  "not_before < not_after", "action_kind <= 1", "egress_mode <= 1", "action_kind == 1", "action_amount >= 1",
  "action_timestamp < not_before", "action_timestamp >= not_after", "action_kind == 0", "prior_spent + action_amount > cap_amount", "egress_mode == 0",
  "action_timestamp <= enforced_at", "enforced_at >= not_after",
  "cap_asset == action_asset", "cap_asset == action_asset",
  CLAIM_CHECK,
];

/** ConductVerdict's parameters, which `evaluate` and `guard_verdict` wire from the slice-1 layout. */
const CORE: readonly (readonly [string, string])[] = [
  ["not_before", "Uint<64>"], ["not_after", "Uint<64>"], ["cap_amount", "Uint<64>"], ["egress_mode", "Uint<8>"], ["action_kind", "Uint<8>"],
  ["action_timestamp", "Uint<64>"], ["action_amount", "Uint<64>"], ["asset_ok", "Boolean"], ["counterparty_ok", "Boolean"], ["prior_spent", "Uint<64>"],
  ["egress_ok", "Boolean"],
];
const CORE_PARAMS = CORE.map(([name, type]) => `${name}: ${type}`).join(", ");
const CORE_ARGS = CORE.map(([name]) => name).join(", ");
const WIRED_ARGS = CORE.map(([name]) => (name === "asset_ok" ? "cap_asset == action_asset" : name)).join(", ");

// T-A17 runs these circuits through evaluate and guard_verdict on every truth assignment of the audited comparisons that
// an input can produce, so their conditions are audited as combinations of audited comparisons and Boolean inputs and
// shown as `(...)`. Every other circuit's conditions are audited verbatim.
const REWIRABLE = ["ConductVerdict.evaluate", "ConductVerdict.decide"];

/** Each circuit's signature, then its decisions in order. */
const AUDITED_DECISIONS: Readonly<Record<string, readonly string[]>> = {
  "ConductVerdict.evaluate": [
    `export circuit evaluate(${CORE_PARAMS}): Uint<8>`,
    'assert (...), "validity window out of domain"',
    'assert (...), "action kind out of domain"',
    'assert (...), "egress mode out of domain"',
    'assert (...), "payment amount out of domain"',
    "if (...) return 1",
    "if (...) return 2",
    "if (...) {",
    "if (...) return 3",
    "if (...) return 5",
    "if (...) return 4",
    "return 0",
    "}",
    "if (...) return 6",
    "if (...) return 7",
    "return 0",
  ],
  "ConductVerdict.decide": [
    `export circuit decide(enforced_at: Uint<64>, ${CORE_PARAMS}): Uint<8>`,
    'assert (...), "action after guard clock"',
    `const verdict = evaluate(${CORE_ARGS})`,
    "return (...) ? 2 : verdict",
  ],
  evaluate: [`export pure circuit evaluate(${PREDICATE_PARAMS}): Uint<8>`, `return CV_evaluate(${WIRED_ARGS})`],
  guard_verdict: [`export pure circuit guard_verdict(enforced_at: Uint<64>, ${PREDICATE_PARAMS}): Uint<8>`, `return CV_decide(enforced_at, ${WIRED_ARGS})`],
  check_verdict: [
    `export circuit check_verdict(enforced_at: Uint<64>, ${PREDICATE_PARAMS}, claimed: Uint<8>): []`,
    `assert (${CLAIM_CHECK}), "verdict mismatch"`,
    "verdictOut = disclose(claimed)",
  ],
};

/** The generated contract class's methods: its constructor and initial state, one per audited circuit, and compactc's `_equal_N` helper for each `==` between Uints. */
const COMPILED_METHODS: readonly string[] = [
  "constructor", "initialState", ...Object.keys(AUDITED_DECISIONS).map(name => name.split(".").at(-1)!), "equal", "equal", "equal", "equal",
];

/** gadgets.compact's declarations in order. */
const GADGET_OUTLINE: readonly string[] = [
  "module ConductGadgets {", "import CompactStandardLibrary;",
  ...["decU64", "dec53", "cborHeadValue", "cborUint", "utf8Next", "jsonStep", "anyStep", "jsonStr", "utf8Any", "base58", "asciiPrint", "isHex", "nib",
    "hexHalves", "hexOfHash", "uuid", "iso8601", "vis6", "vis7"].map(name => `circuit ConductGadgets.${name}`),
  "}",
];

interface AuditedGadget {
  /** Every numeric and Boolean literal of the body, its types' included. */
  readonly literals: readonly string[];
  readonly comparisons: readonly string[];
  readonly calls: readonly string[];
  /** The signature, then every statement in order. */
  readonly statements: readonly string[];
}

const UTF8_STATE = "[Uint<0..4>, Uint<8>, Uint<8>, Boolean]";
const STRING_FOLD = (step: string) => [`fold(${step}, [0, 128, 191, true], s)`];
const HEX_FOLD = (from: number) => `fold((acc, c) => (acc * 16) + nib(c), 0 as Field, slice<32>(h, ${from}))`;

/** Each gadget's literals, comparisons with their operands, calls with their arguments, signature and statements. */
export const AUDITED_GADGETS: Readonly<Record<string, AuditedGadget>> = {
  "ConductGadgets.decU64": {
    literals: ["0", "0", "1", "10", "48", "48", "48", "57", "64"],
    comparisons: ["c >= 48", "c <= 57", "N == 1", "ds[0] != 48"],
    calls: ["fold((acc, c) => ((acc * 10) + (c as Field)) - 48, 0 as Field, ds)"],
    statements: [
      "export circuit decU64<#N>(ds: Vector<N, Uint<8>>): Uint<64>", "for (const c of ds) {", 'assert ((c >= 48) && (c <= 57)), "decimal digit"', "}",
      'assert ((N == 1) || (ds[0] != 48)), "decimal leading zero"',
      "return fold((acc, c) => ((acc * 10) + (c as Field)) - 48, 0 as Field, ds) as Uint<64>",
    ],
  },
  "ConductGadgets.dec53": {
    literals: ["9007199254740992"],
    comparisons: ["value < 9007199254740992"],
    calls: ["decU64<N>(ds)"],
    statements: [
      "export circuit dec53<#N>(ds: Vector<N, Uint<8>>): Uint<64>", "const value = decU64<N>(ds)", 'assert (value < 9007199254740992), "trace seq unsafe"', "return value",
    ],
  },
  "ConductGadgets.cborHeadValue": {
    literals: ["23", "64"],
    comparisons: ["head <= 23"],
    calls: [],
    statements: ["export circuit cborHeadValue(head: Uint<8>): Uint<64>", 'assert (head <= 23), "cbor head"', "return head as Uint<64>"],
  },
  "ConductGadgets.cborUint": {
    literals: ["0", "1", "1", "2", "2", "4", "4", "8", "24", "64", "256", "256", "65536", "4294967296"],
    comparisons: ["W == 1", "W == 2", "W == 4", "W == 8", "value >= ((W == 1) ? 24 : ((W == 2) ? 256 : ((W == 4) ? 65536 : 4294967296)))", "W == 1", "W == 2", "W == 4"],
    calls: ["fold((acc, b) => (acc * 256) + (b as Field), 0 as Field, body)"],
    statements: [
      "export circuit cborUint<#W>(body: Vector<W, Uint<8>>): Uint<64>",
      'assert ((((W == 1) || (W == 2)) || (W == 4)) || (W == 8)), "cbor uint width"',
      "const value = fold((acc, b) => (acc * 256) + (b as Field), 0 as Field, body) as Uint<64>",
      'assert (value >= ((W == 1) ? 24 : ((W == 2) ? 256 : ((W == 4) ? 65536 : 4294967296)))), "cbor uint not minimal"',
      "return value",
    ],
  },
  "ConductGadgets.utf8Next": {
    literals: [
      "0", "0", "0", "0", "0", "0", "0", "0", "1", "1", "1", "2", "2", "2", "2", "3", "3", "3", "4", "8", "8",
      "128", "128", "143", "144", "159", "160", "191", "191", "194", "223", "224", "224", "237", "239", "240", "240", "244", "244",
    ],
    comparisons: [
      "b >= 194", "b <= 223", "b >= 224", "b <= 239", "b >= 240", "b <= 244", "due != 0", "due == 3", "due == 2",
      "due != 0", "b == 224", "b == 240", "due != 0", "b == 237", "b == 244", "due != 0", "b >= s[1]", "b <= s[2]",
    ],
    calls: [],
    statements: [
      `circuit utf8Next(s: ${UTF8_STATE}, b: Uint<8>, ascii: Boolean): ${UTF8_STATE}`,
      "const due = s[0]",
      "const lead2 = (b >= 194) && (b <= 223)",
      "const lead3 = (b >= 224) && (b <= 239)",
      "const lead4 = (b >= 240) && (b <= 244)",
      "const next: Uint<0..4> = (due != 0) ? ((due == 3) ? 2 : ((due == 2) ? 1 : 0)) : (lead2 ? 1 : (lead3 ? 2 : (lead4 ? 3 : 0)))",
      "const lo: Uint<8> = (due != 0) ? 128 : ((b == 224) ? 160 : ((b == 240) ? 144 : 128))",
      "const hi: Uint<8> = (due != 0) ? 191 : ((b == 237) ? 159 : ((b == 244) ? 143 : 191))",
      "return [next, lo, hi, s[3] && ((due != 0) ? ((b >= s[1]) && (b <= s[2])) : (((ascii || lead2) || lead3) || lead4))]",
    ],
  },
  "ConductGadgets.jsonStep": {
    literals: ["32", "34", "92", "128"],
    comparisons: ["b >= 32", "b < 128", "b != 34", "b != 92"],
    calls: ["utf8Next(s, b, (((b >= 32) && (b < 128)) && (b != 34)) && (b != 92))"],
    statements: [`circuit jsonStep(s: ${UTF8_STATE}, b: Uint<8>): ${UTF8_STATE}`, "return utf8Next(s, b, (((b >= 32) && (b < 128)) && (b != 34)) && (b != 92))"],
  },
  "ConductGadgets.anyStep": {
    literals: ["128"],
    comparisons: ["b < 128"],
    calls: ["utf8Next(s, b, b < 128)"],
    statements: [`circuit anyStep(s: ${UTF8_STATE}, b: Uint<8>): ${UTF8_STATE}`, "return utf8Next(s, b, b < 128)"],
  },
  "ConductGadgets.jsonStr": {
    literals: ["0", "0", "0", "3", "128", "191", "true"],
    comparisons: ["end[0] == 0"],
    calls: STRING_FOLD("jsonStep"),
    statements: ["export circuit jsonStr<#N>(s: Vector<N, Uint<8>>): []", "const end = fold(jsonStep, [0, 128, 191, true], s)", 'assert (end[3] && (end[0] == 0)), "string outside escape-free well-formed UTF-8 class"'],
  },
  "ConductGadgets.utf8Any": {
    literals: ["0", "0", "0", "3", "128", "191", "true"],
    comparisons: ["end[0] == 0"],
    calls: STRING_FOLD("anyStep"),
    statements: ["export circuit utf8Any<#N>(s: Vector<N, Uint<8>>): []", "const end = fold(anyStep, [0, 128, 191, true], s)", 'assert (end[3] && (end[0] == 0)), "well-formed UTF-8"'],
  },
  "ConductGadgets.base58": {
    literals: ["49", "57", "65", "72", "74", "78", "80", "90", "97", "107", "109", "122"],
    comparisons: ["c >= 49", "c <= 57", "c >= 65", "c <= 72", "c >= 74", "c <= 78", "c >= 80", "c <= 90", "c >= 97", "c <= 107", "c >= 109", "c <= 122"],
    calls: [],
    statements: ["export circuit base58<#N>(s: Vector<N, Uint<8>>): []", "for (const c of s) {", 'assert (((((((c >= 49) && (c <= 57)) || ((c >= 65) && (c <= 72))) || ((c >= 74) && (c <= 78))) || ((c >= 80) && (c <= 90))) || ((c >= 97) && (c <= 107))) || ((c >= 109) && (c <= 122))), "base58"', "}"],
  },
  "ConductGadgets.asciiPrint": {
    literals: ["33", "126"],
    comparisons: ["c >= 33", "c <= 126"],
    calls: [],
    statements: ["export circuit asciiPrint<#N>(s: Vector<N, Uint<8>>): []", "for (const c of s) {", 'assert ((c >= 33) && (c <= 126)), "printable ASCII"', "}"],
  },
  "ConductGadgets.isHex": {
    literals: ["48", "57", "97", "102"],
    comparisons: ["c >= 48", "c <= 57", "c >= 97", "c <= 102"],
    calls: [],
    statements: ["circuit isHex(c: Uint<8>): Boolean", "return ((c >= 48) && (c <= 57)) || ((c >= 97) && (c <= 102))"],
  },
  "ConductGadgets.nib": {
    literals: ["0", "39", "48", "97"],
    comparisons: ["c >= 97"],
    calls: ["isHex(c)"],
    statements: ["circuit nib(c: Uint<8>): Field", 'assert (isHex(c)), "noncanonical hex"', "return ((c as Field) - 48) - ((c >= 97) ? 39 : 0)"],
  },
  "ConductGadgets.hexHalves": {
    literals: ["0", "0", "0", "16", "16", "32", "32", "32"],
    comparisons: [],
    calls: [HEX_FOLD(0), "nib(c)", "slice<32>(h, 0)", HEX_FOLD(32), "nib(c)", "slice<32>(h, 32)"],
    statements: ["export circuit hexHalves(h: Vector<64, Uint<8>>): [Field, Field]", `return [${HEX_FOLD(0)}, ${HEX_FOLD(32)}]`],
  },
  "ConductGadgets.hexOfHash": {
    literals: ["0", "1", "2", "2", "8", "16", "32", "32"],
    comparisons: ["((nib(h[2 * i]) * 16) + nib(h[(2 * i) + 1])) == (bv[i] as Field)"],
    calls: ["nib(h[2 * i])", "nib(h[(2 * i) + 1])"],
    statements: [
      "export circuit hexOfHash(h: Vector<64, Uint<8>>, b: Bytes<32>): []", "const bv = b as Vector<32, Uint<8>>", "for (const i of 0..32) {",
      'assert (((nib(h[2 * i]) * 16) + nib(h[(2 * i) + 1])) == (bv[i] as Field)), "hex opening"', "}",
    ],
  },
  "ConductGadgets.uuid": {
    literals: ["0", "8", "13", "18", "23", "36", "45"],
    comparisons: ["i == 8", "i == 13", "i == 18", "i == 23", "v[i] == 45"],
    calls: ["isHex(v[i])"],
    statements: ["export circuit uuid(v: Vector<36, Uint<8>>): []", "for (const i of 0..36) {", 'assert (((((i == 8) || (i == 13)) || (i == 18)) || (i == 23)) ? (v[i] == 45) : isHex(v[i])), "uuid"', "}"],
  },
  "ConductGadgets.iso8601": {
    literals: ["0", "4", "7", "10", "13", "16", "19", "23", "24", "45", "46", "48", "57", "58", "84", "90"],
    comparisons: [
      "i == 4", "i == 7", "v[i] == 45", "i == 10", "v[i] == 84", "i == 13", "i == 16", "v[i] == 58", "i == 19", "v[i] == 46", "i == 23", "v[i] == 90",
      "v[i] >= 48", "v[i] <= 57",
    ],
    calls: [],
    statements: ["export circuit iso8601(v: Vector<24, Uint<8>>): []", "for (const i of 0..24) {", 'assert (((i == 4) || (i == 7)) ? (v[i] == 45) : ((i == 10) ? (v[i] == 84) : (((i == 13) || (i == 16)) ? (v[i] == 58) : ((i == 19) ? (v[i] == 46) : ((i == 23) ? (v[i] == 90) : ((v[i] >= 48) && (v[i] <= 57))))))), "iso8601"', "}"],
  },
  "ConductGadgets.vis6": {
    literals: ["6", "6"],
    comparisons: ['(v as Bytes<6>) == "public"', '(v as Bytes<6>) == "secret"'],
    calls: [],
    statements: ["export circuit vis6(v: Vector<6, Uint<8>>): []", 'assert (((v as Bytes<6>) == "public") || ((v as Bytes<6>) == "secret")), "visibility"'],
  },
  "ConductGadgets.vis7": {
    literals: ["7"],
    comparisons: ['(v as Bytes<7>) == "private"'],
    calls: [],
    statements: ["export circuit vis7(v: Vector<7, Uint<8>>): []", 'assert ((v as Bytes<7>) == "private"), "visibility"'],
  },
};

// compactc's generated helpers beside the audited circuits and witnesses: the constructor, the initial state, the
// equality and fold helpers, and the hash.
const COMPILED_HELPERS: readonly string[] = ["constructor", "initialState", "equal", "folder", "persistentHash"];

interface Token {
  readonly kind: "number" | "name" | "string" | "punct";
  readonly text: string;
  /** Whitespace or a comment precedes the token. */
  readonly spaced: boolean;
}

// compactc also ends a line comment at a carriage return, U+0085 or U+2028, so the audit reads only printable ASCII and
// newlines, where its comments end where compactc's do.
function tokenize(source: string): Token[] {
  const stray = /[^\x20-\x7e\n]/.exec(source);
  if (stray) throw new Error(`character U+${stray[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} at offset ${stray.index} is outside printable ASCII`);
  const pattern = /(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*")|(\d+)|([A-Za-z_]\w*)|(=>|\.\.|&&|\|\||[<>=!]=|[-+*<>=!?:(){}[\],;.#])/y;
  const tokens: Token[] = [];
  let spaced = false;
  while (pattern.lastIndex < source.length) {
    const offset = pattern.lastIndex;
    const match = pattern.exec(source);
    if (!match) throw new Error(`cannot read the Compact source at offset ${offset}`);
    const [, gap, string, number, name, punct] = match;
    if (gap !== undefined) {
      spaced = true;
      continue;
    }
    const kind = string !== undefined ? "string" : number !== undefined ? "number" : name !== undefined ? "name" : "punct";
    tokens.push({ kind, text: (string ?? number ?? name ?? punct)!, spaced });
    spaced = false;
  }
  return tokens;
}

type Expr =
  | { readonly type: "atom"; readonly text: string }
  | { readonly type: "call"; readonly callee: string; readonly generics: readonly string[]; readonly args: readonly Expr[] }
  | { readonly type: "not"; readonly operand: Expr }
  | { readonly type: "binary"; readonly op: string; readonly left: Expr; readonly right: Expr }
  | { readonly type: "ternary"; readonly test: Expr; readonly then: Expr; readonly otherwise: Expr }
  | { readonly type: "cast"; readonly value: Expr; readonly to: string }
  | { readonly type: "index"; readonly target: Expr; readonly index: Expr }
  | { readonly type: "member"; readonly target: Expr; readonly name: string }
  | { readonly type: "tuple"; readonly items: readonly Expr[] }
  | { readonly type: "lambda"; readonly params: readonly string[]; readonly body: Expr }
  | { readonly type: "range"; readonly from: Expr; readonly to: Expr };

type Statement =
  | { readonly type: "assert"; readonly test: Expr; readonly message: string }
  | { readonly type: "if"; readonly test: Expr; readonly then: readonly Statement[]; readonly otherwise?: readonly Statement[] }
  | { readonly type: "return"; readonly value?: Expr }
  | { readonly type: "bind"; readonly target: string; readonly value: Expr }
  | { readonly type: "for"; readonly binding: string; readonly iterable: Expr; readonly body: readonly Statement[] }
  | { readonly type: "expr"; readonly value: Expr };

interface Circuit {
  readonly name: string;
  readonly modifiers: readonly string[];
  readonly header: string;
  readonly params: readonly string[];
  readonly booleans: ReadonlySet<string>;
  readonly body: readonly Statement[];
  /** Every numeric literal of the body. */
  readonly literals: readonly string[];
  /** Every numeric and Boolean literal of the body outside a persistentHash call, whose preimage is audited whole. */
  readonly constants: readonly string[];
}

interface Outline {
  readonly lines: string[];
  readonly circuits: Circuit[];
  readonly witnesses: string[];
}

const COMPARISONS = ["==", "!=", "<", "<=", ">", ">="];
const HASH = "persistentHash";

class Parser {
  private at = 0;
  /** The token ranges of persistentHash calls. */
  private readonly hashes: (readonly [number, number])[] = [];
  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): string | undefined {
    return this.tokens[this.at]?.text;
  }

  private next(): Token {
    const token = this.tokens[this.at++];
    if (token === undefined) throw new Error("unexpected end of the Compact source");
    return token;
  }

  private expect(text: string): void {
    const token = this.next();
    if (token.text !== text) throw new Error(`expected "${text}" in the Compact source, found "${token.text}"`);
  }

  private accept(text: string): boolean {
    if (this.peek() !== text) return false;
    this.at++;
    return true;
  }

  // The tokens from `start` up to the current one, with a space wherever the source separated two of them.
  private text(start: number): string {
    return this.tokens.slice(start, this.at).map((token, i) => (i > 0 && token.spaced ? ` ${token.text}` : token.text)).join("");
  }

  /** The whole file: an unread token is an error, so nothing in it escapes the audit. */
  file(): Outline {
    const outline: Outline = { lines: [], circuits: [], witnesses: [] };
    this.declarations("", outline);
    if (this.peek() !== undefined) throw new Error(`unexpected "${this.peek()}" outside any module`);
    return outline;
  }

  private declarations(module: string, outline: Outline): void {
    while (this.peek() !== undefined && this.peek() !== "}") {
      const start = this.at;
      const modifiers: string[] = [];
      while (this.peek() === "export" || this.peek() === "pure") modifiers.push(this.next().text);
      if (this.accept("circuit")) {
        const circuit = this.circuit(module, modifiers);
        outline.circuits.push(circuit);
        outline.lines.push(`circuit ${circuit.name}`);
      } else if (this.accept("module")) {
        const name = this.next().text;
        this.expect("{");
        outline.lines.push(this.text(start));
        this.declarations(`${module}${name}.`, outline);
        this.expect("}");
        outline.lines.push("}");
      } else {
        if (this.peek() === "witness") outline.witnesses.push(this.tokens[this.at + 1]?.text ?? "");
        outline.lines.push(this.declaration(start));
      }
    }
  }

  // Any other declaration runs to its semicolon, or to the close of the block it opens.
  private declaration(start: number): string {
    for (let depth = 0; ;) {
      const { text } = this.next();
      if (text === "{") depth++;
      if (text === "}" && --depth < 0) throw new Error(`unexpected "}" in the declaration "${this.text(start)}"`);
      if (depth === 0 && (text === ";" || text === "}")) return this.text(start);
    }
  }

  private circuit(module: string, modifiers: readonly string[]): Circuit {
    const name = this.next().text;
    const sizes: string[] = [];
    if (this.accept("<")) {
      while (!this.accept(">")) {
        this.expect("#");
        sizes.push(`#${this.next().text}`);
        this.accept(",");
      }
    }
    this.expect("(");
    const params: [string, string][] = [];
    while (!this.accept(")")) {
      const param = this.next().text;
      this.expect(":");
      params.push([param, this.type()]);
      this.accept(",");
    }
    this.expect(":");
    const returns = this.type();
    const start = this.at;
    const body = this.block();
    const inHash = (i: number) => this.hashes.some(([from, to]) => i >= from && i < to);
    const tokens = this.tokens.slice(start, this.at).map((token, i) => ({ token, at: start + i }));
    return {
      name: `${module}${name}`,
      modifiers,
      header: `${[...modifiers, "circuit"].join(" ")} ${name}${sizes.length > 0 ? `<${sizes.join(", ")}>` : ""}(${params.map(([param, type]) => `${param}: ${type}`).join(", ")}): ${returns}`,
      params: params.map(([param]) => param),
      booleans: new Set(params.filter(([, type]) => type === "Boolean").map(([param]) => param)),
      body,
      literals: tokens.filter(({ token }) => token.kind === "number").map(({ token }) => token.text),
      constants: tokens.filter(({ token, at }) => (token.kind === "number" || token.text === "true" || token.text === "false") && !inHash(at)).map(({ token }) => token.text),
    };
  }

  private type(): string {
    if (this.accept("[")) {
      const members: string[] = [];
      while (!this.accept("]")) {
        members.push(this.type());
        this.accept(",");
      }
      return `[${members.join(", ")}]`;
    }
    const token = this.next();
    if (token.kind !== "name") throw new Error(`expected a type in the Compact source, found "${token.text}"`);
    if (!this.accept("<")) return token.text;
    const args: string[] = [];
    while (!this.accept(">")) {
      args.push(this.typeArgument());
      this.accept(",");
    }
    return `${token.text}<${args.join(", ")}>`;
  }

  // A size, a size range or a type.
  private typeArgument(): string {
    if (this.tokens[this.at]?.kind !== "number") return this.type();
    const from = this.next().text;
    return this.accept("..") ? `${from}..${this.next().text}` : from;
  }

  private block(): Statement[] {
    this.expect("{");
    const statements: Statement[] = [];
    while (!this.accept("}")) statements.push(this.statement());
    return statements;
  }

  private statement(): Statement {
    if (this.accept("assert")) {
      this.expect("(");
      const test = this.expr();
      this.expect(",");
      const message = this.next().text;
      this.expect(")");
      this.expect(";");
      return { type: "assert", test, message };
    }
    if (this.accept("if")) {
      this.expect("(");
      const test = this.expr();
      this.expect(")");
      const then = this.block();
      if (!this.accept("else")) return { type: "if", test, then };
      return { type: "if", test, then, otherwise: this.peek() === "if" ? [this.statement()] : this.block() };
    }
    if (this.accept("for")) {
      this.expect("(");
      this.expect("const");
      const binding = this.next().text;
      this.expect("of");
      const from = this.expr();
      const iterable: Expr = this.accept("..") ? { type: "range", from, to: this.expr() } : from;
      this.expect(")");
      return { type: "for", binding, iterable, body: this.block() };
    }
    if (this.accept("return")) {
      const value = this.peek() === ";" ? undefined : this.expr();
      this.expect(";");
      return value === undefined ? { type: "return" } : { type: "return", value };
    }
    if (this.accept("const")) {
      const target = this.next().text;
      const declared = this.accept(":") ? `: ${this.type()}` : "";
      this.expect("=");
      const value = this.expr();
      this.expect(";");
      return { type: "bind", target: `const ${target}${declared}`, value };
    }
    const value = this.expr();
    if (this.accept("=")) {
      if (value.type !== "atom") throw new Error(`cannot assign to ${render(value)}`);
      const assigned = this.expr();
      this.expect(";");
      return { type: "bind", target: value.text, value: assigned };
    }
    this.expect(";");
    return { type: "expr", value };
  }

  private expr(): Expr {
    const test = this.binary(0);
    if (!this.accept("?")) return test;
    const then = this.expr();
    this.expect(":");
    return { type: "ternary", test, then, otherwise: this.expr() };
  }

  // compactc's binary levels, loosest first: `a + b as T` casts the sum, and `a == b < c` compares a with b < c.
  private static readonly LEVELS: readonly (readonly string[])[] = [["||"], ["&&"], ["==", "!="], ["<", "<=", ">", ">="], ["as"], ["+", "-"], ["*"]];

  private binary(level: number): Expr {
    if (level === Parser.LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    while (Parser.LEVELS[level]!.includes(this.peek() ?? "")) {
      const op = this.next().text;
      left = op === "as" ? { type: "cast", value: left, to: this.type() } : { type: "binary", op, left, right: this.binary(level + 1) };
    }
    return left;
  }

  private unary(): Expr {
    return this.accept("!") ? { type: "not", operand: this.unary() } : this.postfix();
  }

  private postfix(): Expr {
    let value = this.primary();
    for (;;) {
      if (this.accept("[")) {
        value = { type: "index", target: value, index: this.expr() };
        this.expect("]");
      } else if (this.peek() === "." && this.tokens[this.at + 1]?.kind === "name") {
        this.at++;
        value = { type: "member", target: value, name: this.next().text };
      } else return value;
    }
  }

  private primary(): Expr {
    if (this.accept("(")) {
      const lambda = this.lambda();
      if (lambda !== undefined) return lambda;
      const inner = this.expr();
      this.expect(")");
      return inner;
    }
    if (this.accept("[")) {
      const items: Expr[] = [];
      while (!this.accept("]")) {
        items.push(this.expr());
        this.accept(",");
      }
      return { type: "tuple", items };
    }
    const start = this.at;
    const token = this.next();
    if (token.kind === "punct") throw new Error(`unexpected "${token.text}" in a Compact expression`);
    if (token.kind !== "name") return { type: "atom", text: token.text };
    const generics = this.generics();
    if (!this.accept("(")) return { type: "atom", text: token.text };
    const args: Expr[] = [];
    while (!this.accept(")")) {
      args.push(this.expr());
      this.accept(",");
    }
    if (token.text === HASH) this.hashes.push([start, this.at]);
    return { type: "call", callee: token.text, generics, args };
  }

  // A call's sizes and types: `<...>` of names, sizes, ranges and tuples directly before its arguments. Anything else
  // leaves `<` to the comparison.
  private generics(): string[] {
    if (this.peek() !== "<") return [];
    let end = this.at;
    for (let depth = 0; ; end++) {
      const token = this.tokens[end];
      if (token === undefined) return [];
      if (token.text === "<") depth++;
      else if (token.text === ">") {
        if (--depth === 0) break;
      }
      else if (token.kind !== "name" && token.kind !== "number" && ![",", "[", "]", ".."].includes(token.text)) return [];
    }
    if (this.tokens[end + 1]?.text !== "(") return [];
    this.expect("<");
    const args: string[] = [];
    while (!this.accept(">")) {
      args.push(this.typeArgument());
      this.accept(",");
    }
    return args;
  }

  // `(a, b) => body`, or undefined with nothing read when the parenthesis opens anything else.
  private lambda(): Expr | undefined {
    const start = this.at;
    const params: string[] = [];
    while (this.tokens[this.at]?.kind === "name") {
      params.push(this.next().text);
      if (!this.accept(",")) break;
    }
    if (this.accept(")") && this.accept("=>")) return { type: "lambda", params, body: this.expr() };
    this.at = start;
    return undefined;
  }
}

const ELIDED = "(...)";

// A string literal whose only escapes are \" and \\. The tokenizer admits printable ASCII alone, so each character is
// the one byte compactc's UTF-8 encoding gives it; an escape such as \u00ab, which compactc writes as C2 AB, is never a
// constant.
const PLAIN_STRING = /^"(?:[^"\\\n]|\\["\\])*"$/;

// The bytes of a constant persistentHash input and the type compactc gives the literal: a plain string literal, or a
// vector of byte literals.
function constantBytes(e: Expr): { readonly bytes: number[]; readonly type: string } | undefined {
  if (e.type === "atom" && PLAIN_STRING.test(e.text)) {
    const bytes = [...Buffer.from(e.text.slice(1, -1).replace(/\\(["\\])/g, "$1"), "utf8")];
    return { bytes, type: `Bytes<${bytes.length}>` };
  }
  if (e.type === "tuple" && e.items.length > 0 && e.items.every(item => item.type === "atom" && /^\d+$/.test(item.text) && Number(item.text) < 256)) {
    return { bytes: e.items.map(item => Number((item as { text: string }).text)), type: `Vector<${e.items.length}, Uint<8>>` };
  }
  return undefined;
}

const constantText = (bytes: readonly number[]) =>
  `"${bytes.map(b => (b >= 0x20 && b <= 0x7e && b !== 0x22 && b !== 0x5c ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`)).join("")}"`;

// The members of a rendered tuple type, or undefined for any other type.
function tupleMembers(type: string): string[] | undefined {
  if (!type.startsWith("[") || !type.endsWith("]")) return undefined;
  const members: string[] = [];
  let [depth, start] = [0, 1];
  for (let i = 1; i < type.length - 1; i++) {
    if (type[i] === "<" || type[i] === "[") depth++;
    else if (type[i] === ">" || type[i] === "]") depth--;
    else if (type[i] === "," && depth === 0) {
      members.push(type.slice(start, i).trim());
      start = i + 1;
    }
  }
  return type.length > 2 ? [...members, type.slice(start, -1).trim()] : members;
}

// A persistentHash call by the bytes it hashes, or undefined unless it lists one type per input. compactc encodes each
// input at its listed type, widening an input to a wider type, so each input is shown with that type; a constant under
// the type compactc gives the literal joins its neighbours in one run of bytes.
function hashText(e: Extract<Expr, { type: "call" }>, elide: boolean): string | undefined {
  const [only] = e.args;
  const types = e.generics.length === 1 ? tupleMembers(e.generics[0]!) : undefined;
  if (e.args.length !== 1 || only!.type !== "tuple" || types?.length !== only.items.length) return undefined;
  const parts: string[] = [];
  let run: number[] = [];
  for (const [i, item] of only.items.entries()) {
    const constant = constantBytes(item);
    if (constant?.type === types[i]) run.push(...constant.bytes);
    else {
      if (run.length > 0) parts.push(constantText(run));
      run = [];
      parts.push(`${render(item, elide)}: ${types[i]}`);
    }
  }
  if (run.length > 0) parts.push(constantText(run));
  return `${HASH}(${parts.join(", ")})`;
}

// Renders an expression; `elide` replaces the test of every ternary, which is a condition.
function render(e: Expr, elide = false): string {
  const nested = (inner: Expr) => (["binary", "ternary", "cast", "lambda", "range"].includes(inner.type) ? `(${render(inner, elide)})` : render(inner, elide));
  switch (e.type) {
    case "atom": return e.text;
    case "call": return (e.callee === HASH ? hashText(e, elide) : undefined) ?? `${e.callee}${e.generics.length > 0 ? `<${e.generics.join(", ")}>` : ""}(${e.args.map(arg => render(arg, elide)).join(", ")})`;
    case "not": return `!${nested(e.operand)}`;
    case "binary": return `${nested(e.left)} ${e.op} ${nested(e.right)}`;
    case "ternary": return `${elide ? ELIDED : nested(e.test)} ? ${nested(e.then)} : ${nested(e.otherwise)}`;
    case "cast": return `${nested(e.value)} as ${e.to}`;
    case "index": return `${nested(e.target)}[${render(e.index, elide)}]`;
    case "member": return `${nested(e.target)}.${e.name}`;
    case "tuple": return `[${e.items.map(item => render(item, elide)).join(", ")}]`;
    case "lambda": return `(${e.params.join(", ")}) => ${render(e.body, elide)}`;
    case "range": return `${render(e.from, elide)}..${render(e.to, elide)}`;
  }
}

function decisions(statements: readonly Statement[], elide: boolean): string[] {
  const condition = (test: Expr) => (elide ? ELIDED : `(${render(test)})`);
  return statements.flatMap(s => {
    switch (s.type) {
      case "assert": return [`assert ${condition(s.test)}, ${s.message}`];
      case "return": return [s.value === undefined ? "return" : `return ${render(s.value, elide)}`];
      case "bind": return [`${s.target} = ${render(s.value, elide)}`];
      case "expr": return [render(s.value, elide)];
      case "for": return [`for (const ${s.binding} of ${render(s.iterable, elide)}) {`, ...decisions(s.body, elide), "}"];
      case "if": {
        const [only] = s.then;
        const then = s.then.length === 1 && only!.type !== "if"
          ? [`if ${condition(s.test)} ${decisions(s.then, elide)[0]}`]
          : [`if ${condition(s.test)} {`, ...decisions(s.then, elide), "}"];
        return s.otherwise === undefined ? then : [...then, "else {", ...decisions(s.otherwise, elide), "}"];
      }
    }
  });
}

function* nestedStatements(statements: readonly Statement[]): Generator<Statement> {
  for (const s of statements) {
    yield s;
    if (s.type === "if") yield* nestedStatements([...s.then, ...(s.otherwise ?? [])]);
    if (s.type === "for") yield* nestedStatements(s.body);
  }
}

function* expressions(statements: readonly Statement[]): Generator<{ readonly expr: Expr; readonly condition: boolean }> {
  for (const s of nestedStatements(statements)) {
    if (s.type === "assert" || s.type === "if") yield { expr: s.test, condition: true };
    if (s.type === "for") yield { expr: s.iterable, condition: false };
    if ((s.type === "return" && s.value !== undefined) || s.type === "bind" || s.type === "expr") yield { expr: s.value!, condition: false };
  }
}

function* subexpressions(e: Expr): Generator<Expr> {
  yield e;
  switch (e.type) {
    case "call": for (const arg of e.args) yield* subexpressions(arg); break;
    case "not": yield* subexpressions(e.operand); break;
    case "binary": yield* subexpressions(e.left); yield* subexpressions(e.right); break;
    case "ternary": yield* subexpressions(e.test); yield* subexpressions(e.then); yield* subexpressions(e.otherwise); break;
    case "cast": yield* subexpressions(e.value); break;
    case "index": yield* subexpressions(e.target); yield* subexpressions(e.index); break;
    case "member": yield* subexpressions(e.target); break;
    case "tuple": for (const item of e.items) yield* subexpressions(item); break;
    case "lambda": yield* subexpressions(e.body); break;
    case "range": yield* subexpressions(e.from); yield* subexpressions(e.to); break;
    case "atom": break;
  }
}

// A condition may combine comparisons and Boolean inputs with !, && and ||, and nothing else, so its truth value is a
// function of the audited comparisons and the circuit's Boolean parameters.
function unauditedReads(test: Expr, booleans: ReadonlySet<string>): Expr[] {
  if (test.type === "binary" && COMPARISONS.includes(test.op)) return [];
  if (test.type === "binary" && (test.op === "&&" || test.op === "||")) return [...unauditedReads(test.left, booleans), ...unauditedReads(test.right, booleans)];
  if (test.type === "not") return unauditedReads(test.operand, booleans);
  if (test.type === "ternary") return [test.test, test.then, test.otherwise].flatMap(part => unauditedReads(part, booleans));
  if (test.type === "atom" && (booleans.has(test.text) || test.text === "true" || test.text === "false")) return [];
  return [test];
}

// Numbers by value, then the Boolean literals.
function byLiteral(a: string, b: string): number {
  const [x, y] = [a, b].map(text => (/^\d+$/.test(text) ? BigInt(text) : undefined));
  if (x !== undefined && y !== undefined) return x < y ? -1 : x > y ? 1 : 0;
  if (x !== undefined || y !== undefined) return x !== undefined ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function multisetDifference(view: string, found: readonly string[], audited: readonly string[], order?: (a: string, b: string) => number): string[] {
  const removed = [...audited];
  const added: string[] = [];
  for (const item of found) {
    const index = removed.indexOf(item);
    if (index < 0) added.push(item);
    else removed.splice(index, 1);
  }
  return added.length + removed.length === 0 ? [] : [`${view} differ from the audited list: added [${added.sort(order).join(", ")}], removed [${removed.sort(order).join(", ")}]`];
}

function firstDifference(subject: string, found: readonly string[], audited: readonly string[]): string[] {
  const line = found.findIndex((text, i) => text !== audited[i]);
  const at = line < 0 && found.length < audited.length ? found.length : line;
  return at < 0 ? [] : [`${subject} at line ${at + 1}: found ${JSON.stringify(found[at] ?? "the end")}, audited ${JSON.stringify(audited[at] ?? "the end")}`];
}

function parse(file: string, source: string): Outline | string {
  try {
    return new Parser(tokenize(source)).file();
  } catch (error) {
    return `${file} cannot be audited: ${(error as Error).message}`;
  }
}

/** The ways the sources differ from the audited structure; empty when they hold exactly the audited structure. */
export function auditSources(sources: Sources): string[] {
  const outlines: [AuditedFile, Outline][] = [];
  const unreadable: string[] = [];
  for (const file of AUDITED_FILES) {
    const outline = parse(file, sources[file]);
    if (typeof outline === "string") unreadable.push(outline);
    else outlines.push([file, outline]);
  }
  if (unreadable.length > 0) return unreadable;
  const circuits = outlines.flatMap(([, outline]) => outline.circuits);
  const all = circuits.flatMap(c => [...expressions(c.body)].flatMap(({ expr }) => [...subexpressions(expr)]));
  const findings = [
    ...outlines.flatMap(([file, { lines }]) => firstDifference(`${file} differs from its audited outline`, lines, AUDITED_OUTLINES[file])),
    ...multisetDifference("numeric literals", circuits.flatMap(c => c.literals), AUDITED_LITERALS, byLiteral),
    ...multisetDifference("comparisons", all.flatMap(e => (e.type === "binary" && COMPARISONS.includes(e.op) ? [`${render(e.left)} ${e.op} ${render(e.right)}`] : [])), AUDITED_COMPARISONS),
  ];
  for (const c of circuits) {
    const audited = AUDITED_DECISIONS[c.name];
    if (audited === undefined) continue;
    findings.push(...firstDifference(`${c.name} differs from its audited decision list`, [c.header, ...decisions(c.body, REWIRABLE.includes(c.name))], audited));
    const tests = [...expressions(c.body)].flatMap(({ expr, condition }) => [
      ...(condition ? [expr] : []), ...[...subexpressions(expr)].flatMap(e => (e.type === "ternary" ? [e.test] : [])),
    ]);
    for (const read of tests.flatMap(test => unauditedReads(test, c.booleans))) {
      findings.push(`a condition in ${c.name} reads ${render(read)}, which is neither a comparison nor a Boolean input`);
    }
  }
  return findings;
}

// The compiled contract class's method names, each instance helper `_name_N` by its name.
function compiledMethods(source: string): string[] | undefined {
  const start = source.indexOf("\nexport class Contract {\n");
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) return undefined;
  return [...source.slice(start, end).matchAll(/^ {2}([A-Za-z_$][\w$]*)\(/gm)].map(([, name]) => name!.replace(/^_(\w+)_\d+$/, "$1"));
}

/** How the compiled unit's contract methods differ from the audited circuits'. compactc parses the sources on its own, so a circuit the source audit never reached still shows here. */
export function compiledFindings(unit: string): string[] {
  const methods = compiledMethods(generatedSource(unit));
  if (methods === undefined) return [`the compiled ${unit} has no contract class`];
  return multisetDifference("compiled contract methods", methods, COMPILED_METHODS);
}

/** T-A16 on a compiled predicate unit: its sources and its generated contract. */
export const auditStructure = (unit: string): string[] => [...auditSources(predicateSources(unit)), ...compiledFindings(unit)];

const OPENING_FILES = ["gadgets.compact", "openings.generated.compact"] as const;
type OpeningSources = Readonly<Record<(typeof OPENING_FILES)[number], string>>;

export const openingSources = (unit = "openings"): OpeningSources =>
  Object.fromEntries(OPENING_FILES.map(file => [file, unitSource(unit, file)])) as OpeningSources;

/** A circuit as the audit compares it: its literals, comparisons, calls, witness reads, ledger writes, and statements in order. */
interface View {
  readonly literals: readonly string[];
  readonly comparisons: readonly string[];
  readonly calls: readonly string[];
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly statements: readonly string[];
}

function viewOf(c: Circuit, witnesses: ReadonlySet<string>): View {
  const all = [...expressions(c.body)].flatMap(({ expr }) => [...subexpressions(expr)]);
  const calls = all.filter((e): e is Extract<Expr, { type: "call" }> => e.type === "call");
  return {
    literals: c.constants,
    comparisons: all.filter(e => e.type === "binary" && COMPARISONS.includes(e.op)).map(e => render(e)),
    calls: calls.filter(e => !witnesses.has(e.callee)).map(e => render(e)),
    reads: calls.filter(e => witnesses.has(e.callee)).map(e => render(e)),
    writes: [...nestedStatements(c.body)].flatMap(s => (s.type === "bind" && !s.target.startsWith("const ") ? [`${s.target} = ${render(s.value)}`] : [])),
    statements: [c.header, ...decisions(c.body, false)],
  };
}

function viewFindings(subject: string, found: View, audited: View): string[] {
  return [
    ...multisetDifference(`${subject} literals`, found.literals, audited.literals, byLiteral),
    ...multisetDifference(`${subject} comparisons`, found.comparisons, audited.comparisons),
    ...multisetDifference(`${subject} calls`, found.calls, audited.calls),
    ...multisetDifference(`${subject} witness reads`, found.reads, audited.reads),
    ...multisetDifference(`${subject} ledger writes`, found.writes, audited.writes),
    ...firstDifference(`${subject} differs from its audited statement list`, found.statements, audited.statements),
  ];
}

function gadgetFindings(gadgets: Outline): string[] {
  const findings = firstDifference("gadgets.compact differs from its audited outline", gadgets.lines, GADGET_OUTLINE);
  for (const c of gadgets.circuits) {
    const audited = AUDITED_GADGETS[c.name];
    if (audited === undefined) continue;
    const found = viewOf(c, new Set());
    findings.push(
      ...multisetDifference(`${c.name} literals`, found.literals, audited.literals, byLiteral),
      ...multisetDifference(`${c.name} comparisons`, found.comparisons, audited.comparisons),
      ...multisetDifference(`${c.name} calls`, found.calls, audited.calls),
      ...firstDifference(`${c.name} differs from its audited statement list`, found.statements, audited.statements),
    );
  }
  return findings;
}

// A pure circuit of the openings unit is a probe: it returns one gadget call on its own parameters, in order.
function isProbe(c: Circuit, gadgets: ReadonlySet<string>): boolean {
  const [only, ...rest] = c.body;
  const call = only?.type === "return" ? only.value : undefined;
  return rest.length === 0 && call?.type === "call" && gadgets.has(call.callee) && call.args.length === c.params.length
    && call.args.every((arg, i) => arg.type === "atom" && arg.text === c.params[i]);
}

interface OpeningsAudit {
  readonly findings: string[];
  /** The audited names the compiled unit must implement, where the sources could be read. */
  readonly names?: { readonly classes: string[]; readonly witnesses: string[]; readonly probes: string[]; readonly gadgets: string[] };
}

function openingsAudit(sources: OpeningSources): OpeningsAudit {
  const gadgets = parse("gadgets.compact", sources["gadgets.compact"]);
  const generated = parse("openings.generated.compact", sources["openings.generated.compact"]);
  const reference = parse("the reference openings", referenceOpenings());
  if (typeof reference === "string") throw new Error(reference);
  const unreadable = [gadgets, generated].filter((outline): outline is string => typeof outline === "string");
  if (typeof gadgets === "string" || typeof generated === "string") return { findings: unreadable };
  const gadgetNames = new Set(gadgets.circuits.filter(c => c.modifiers.includes("export")).map(c => c.name.slice(c.name.indexOf(".") + 1)));
  const pure = generated.circuits.filter(c => c.modifiers.includes("pure"));
  const findings = [
    ...gadgetFindings(gadgets),
    ...multisetDifference("openings.generated.compact declarations", generated.lines.filter(line => !pure.some(c => line === `circuit ${c.name}`)), reference.lines),
    ...pure.filter(c => !isProbe(c, gadgetNames)).map(c => `the pure circuit ${c.name} does not return one gadget call on its own parameters`),
  ];
  const [found, audited] = [new Set(generated.witnesses), new Set(reference.witnesses)];
  for (const expected of reference.circuits) {
    const circuit = generated.circuits.find(c => c.name === expected.name && !c.modifiers.includes("pure"));
    if (circuit !== undefined) findings.push(...viewFindings(expected.name, viewOf(circuit, found), viewOf(expected, audited)));
  }
  return {
    findings,
    names: {
      classes: reference.circuits.map(c => c.name), witnesses: reference.witnesses, probes: pure.map(c => c.name),
      gadgets: gadgets.circuits.map(c => c.name.slice(c.name.indexOf(".") + 1)),
    },
  };
}

/** The ways the gadgets and the generated openings differ from the audited structure; empty when they hold exactly it. */
export const auditOpenings = (sources: OpeningSources): string[] => openingsAudit(sources).findings;

// The names `line` captures between `from` and the next `to` in the generated contract.
function listed(source: string, from: string, to: string, line: RegExp): string[] {
  const start = source.indexOf(from);
  return start < 0 ? [] : [...source.slice(start, source.indexOf(to, start + from.length)).matchAll(line)].map(([, name]) => name!);
}

/** AM-8 on a compiled openings unit: its sources against the audit and the reference, and its generated contract against both. */
export function auditOpeningsStructure(unit: string): string[] {
  const { findings, names } = openingsAudit(openingSources(unit));
  if (names === undefined) return findings;
  const source = generatedSource(unit);
  const methods = compiledMethods(source);
  if (methods === undefined) return [...findings, `the compiled ${unit} has no contract class`];
  const allowed = new Set([...names.classes, ...names.witnesses, ...names.probes, ...names.gadgets, ...COMPILED_HELPERS]);
  const outside = [...new Set(methods.filter(name => !allowed.has(name)))].sort();
  return [
    ...findings,
    ...multisetDifference("compiled opening circuits", listed(source, "this.impureCircuits = {", "}", /^ +(\w+): this\.circuits\.\w+,?$/gm), names.classes),
    ...multisetDifference("compiled probes", listed(source, "\nexport const pureCircuits = {", "\n};", /^ {2}(\w+): \(\.\.\.args_0\) => \{$/gm), names.probes),
    ...multisetDifference("compiled witnesses", [...source.matchAll(/does not contain a function-valued field named (\w+)'/g)].map(([, name]) => name!), names.witnesses),
    ...(outside.length === 0 ? [] : [`the compiled ${unit} has contract methods outside the audited circuits: [${outside.join(", ")}]`]),
  ];
}
