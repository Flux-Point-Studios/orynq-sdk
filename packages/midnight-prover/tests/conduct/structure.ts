import { PREDICATE_LAYOUT, type PredicateInput } from "@fluxpointstudios/orynq-sdk-conduct";
import { generatedSource, unitSource } from "./harness.js";

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
  const pattern = /(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*")|(\d+)|([A-Za-z_]\w*)|(&&|\|\||[<>=!]=|[-+*<>=!?:(){}[\],;.#])/y;
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
  | { readonly type: "call"; readonly callee: string; readonly args: readonly Expr[] }
  | { readonly type: "not"; readonly operand: Expr }
  | { readonly type: "binary"; readonly op: string; readonly left: Expr; readonly right: Expr }
  | { readonly type: "ternary"; readonly test: Expr; readonly then: Expr; readonly otherwise: Expr }
  | { readonly type: "cast"; readonly value: Expr; readonly to: string };

type Statement =
  | { readonly type: "assert"; readonly test: Expr; readonly message: string }
  | { readonly type: "if"; readonly test: Expr; readonly then: readonly Statement[]; readonly otherwise?: readonly Statement[] }
  | { readonly type: "return"; readonly value?: Expr }
  | { readonly type: "bind"; readonly target: string; readonly value: Expr };

interface Circuit {
  readonly name: string;
  readonly header: string;
  readonly booleans: ReadonlySet<string>;
  readonly body: readonly Statement[];
  readonly literals: readonly string[];
}

interface Outline {
  readonly lines: string[];
  readonly circuits: Circuit[];
}

const COMPARISONS = ["==", "!=", "<", "<=", ">", ">="];

class Parser {
  private at = 0;
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
    const outline: Outline = { lines: [], circuits: [] };
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
      } else outline.lines.push(this.declaration(start));
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
    return {
      name: `${module}${name}`,
      header: `${[...modifiers, "circuit"].join(" ")} ${name}(${params.map(([param, type]) => `${param}: ${type}`).join(", ")}): ${returns}`,
      booleans: new Set(params.filter(([, type]) => type === "Boolean").map(([param]) => param)),
      body,
      literals: this.tokens.slice(start, this.at).filter(token => token.kind === "number").map(token => token.text),
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
    const name = this.next().text;
    if (!this.accept("<")) return name;
    const args: string[] = [];
    while (!this.accept(">")) {
      args.push(this.tokens[this.at]?.kind === "number" ? this.next().text : this.type());
      this.accept(",");
    }
    return `${name}<${args.join(", ")}>`;
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
    if (this.accept("return")) {
      const value = this.peek() === ";" ? undefined : this.expr();
      this.expect(";");
      return value === undefined ? { type: "return" } : { type: "return", value };
    }
    const declared = this.accept("const");
    const target = this.next().text;
    if (declared && this.accept(":")) this.type();
    this.expect("=");
    const value = this.expr();
    this.expect(";");
    return { type: "bind", target: declared ? `const ${target}` : target, value };
  }

  private expr(): Expr {
    const test = this.binary(0);
    if (!this.accept("?")) return test;
    const then = this.expr();
    this.expect(":");
    return { type: "ternary", test, then, otherwise: this.expr() };
  }

  // Loosest first: ||, &&, comparison, additive, multiplicative.
  private static readonly LEVELS: readonly (readonly string[])[] = [["||"], ["&&"], COMPARISONS, ["+", "-"], ["*"]];

  private binary(level: number): Expr {
    if (level === Parser.LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    while (Parser.LEVELS[level]!.includes(this.peek() ?? "")) {
      const op = this.next().text;
      left = { type: "binary", op, left, right: this.binary(level + 1) };
    }
    return left;
  }

  private unary(): Expr {
    if (this.accept("!")) return { type: "not", operand: this.unary() };
    let value = this.primary();
    while (this.accept("as")) value = { type: "cast", value, to: this.type() };
    return value;
  }

  private primary(): Expr {
    if (this.accept("(")) {
      const inner = this.expr();
      this.expect(")");
      return inner;
    }
    const token = this.next();
    if (token.kind !== "number" && token.kind !== "name") throw new Error(`unexpected "${token.text}" in a Compact expression`);
    if (token.kind === "number" || !this.accept("(")) return { type: "atom", text: token.text };
    const args: Expr[] = [];
    while (!this.accept(")")) {
      args.push(this.expr());
      this.accept(",");
    }
    return { type: "call", callee: token.text, args };
  }
}

const ELIDED = "(...)";

// Renders an expression; `elide` replaces the test of every ternary, which is a condition.
function render(e: Expr, elide = false): string {
  const nested = (inner: Expr) => (inner.type === "binary" || inner.type === "ternary" || inner.type === "cast" ? `(${render(inner, elide)})` : render(inner, elide));
  switch (e.type) {
    case "atom": return e.text;
    case "call": return `${e.callee}(${e.args.map(arg => render(arg, elide)).join(", ")})`;
    case "not": return `!${nested(e.operand)}`;
    case "binary": return `${nested(e.left)} ${e.op} ${nested(e.right)}`;
    case "ternary": return `${elide ? ELIDED : nested(e.test)} ? ${nested(e.then)} : ${nested(e.otherwise)}`;
    case "cast": return `${nested(e.value)} as ${e.to}`;
  }
}

function decisions(statements: readonly Statement[], elide: boolean): string[] {
  const condition = (test: Expr) => (elide ? ELIDED : `(${render(test)})`);
  return statements.flatMap(s => {
    switch (s.type) {
      case "assert": return [`assert ${condition(s.test)}, ${s.message}`];
      case "return": return [s.value === undefined ? "return" : `return ${render(s.value, elide)}`];
      case "bind": return [`${s.target} = ${render(s.value, elide)}`];
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

function* expressions(statements: readonly Statement[]): Generator<{ readonly expr: Expr; readonly condition: boolean }> {
  for (const s of statements) {
    if (s.type === "assert" || s.type === "if") yield { expr: s.test, condition: true };
    if ((s.type === "return" && s.value !== undefined) || s.type === "bind") yield { expr: s.value!, condition: false };
    if (s.type === "if") {
      yield* expressions(s.then);
      if (s.otherwise !== undefined) yield* expressions(s.otherwise);
    }
  }
}

function* subexpressions(e: Expr): Generator<Expr> {
  yield e;
  if (e.type === "call") for (const arg of e.args) yield* subexpressions(arg);
  if (e.type === "not") yield* subexpressions(e.operand);
  if (e.type === "binary") yield* [...subexpressions(e.left), ...subexpressions(e.right)];
  if (e.type === "ternary") yield* [...subexpressions(e.test), ...subexpressions(e.then), ...subexpressions(e.otherwise)];
  if (e.type === "cast") yield* subexpressions(e.value);
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

const byValue = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

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

/** The ways the sources differ from the audited structure; empty when they hold exactly the audited structure. */
export function auditSources(sources: Sources): string[] {
  const outlines: [AuditedFile, Outline][] = [];
  const unreadable: string[] = [];
  for (const file of AUDITED_FILES) {
    try {
      outlines.push([file, new Parser(tokenize(sources[file])).file()]);
    } catch (error) {
      unreadable.push(`${file} cannot be audited: ${(error as Error).message}`);
    }
  }
  if (unreadable.length > 0) return unreadable;
  const circuits = outlines.flatMap(([, outline]) => outline.circuits);
  const all = circuits.flatMap(c => [...expressions(c.body)].flatMap(({ expr }) => [...subexpressions(expr)]));
  const findings = [
    ...outlines.flatMap(([file, { lines }]) => firstDifference(`${file} differs from its audited outline`, lines, AUDITED_OUTLINES[file])),
    ...multisetDifference("numeric literals", circuits.flatMap(c => c.literals), AUDITED_LITERALS, byValue),
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

/** How the compiled unit's contract methods differ from the audited circuits'. compactc parses the sources on its own, so a circuit the source audit never reached still shows here. */
export function compiledFindings(unit: string): string[] {
  const source = generatedSource(unit);
  const start = source.indexOf("\nexport class Contract {\n");
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) return [`the compiled ${unit} has no contract class`];
  const methods = [...source.slice(start, end).matchAll(/^ {2}([A-Za-z_$][\w$]*)\(/gm)].map(([, name]) => name!.replace(/^_(\w+)_\d+$/, "$1"));
  return multisetDifference("compiled contract methods", methods, COMPILED_METHODS);
}

/** T-A16 on a compiled predicate unit: its sources and its generated contract. */
export const auditStructure = (unit: string): string[] => [...auditSources(predicateSources(unit)), ...compiledFindings(unit)];
