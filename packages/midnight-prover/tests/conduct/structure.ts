import { unitSource } from "./harness.js";

const AUDITED_FILES = ["verdict_core.compact", "predicate.compact"] as const;
type Sources = Readonly<Record<(typeof AUDITED_FILES)[number], string>>;

export const predicateSources = (unit = "predicate"): Sources =>
  Object.fromEntries(AUDITED_FILES.map(file => [file, unitSource(unit, file)])) as Sources;

/** Every numeric literal inside a circuit body: the verdict codes 0-7, the kind and mode tests, the domain bounds and the amount floor. */
const AUDITED_LITERALS: readonly string[] = ["0", "0", "0", "0", "1", "1", "1", "1", "1", "2", "2", "3", "4", "5", "6", "7"];

/** Every comparison, as its left operand, operator and right operand. */
export const AUDITED_COMPARISONS: readonly string[] = [
  "not_before < not_after", "action_kind <= 1", "egress_mode <= 1", "action_kind == 1", "action_amount >= 1",
  "action_timestamp < not_before", "action_timestamp >= not_after", "action_kind == 0", "prior_spent + action_amount > cap_amount", "egress_mode == 0",
  "action_timestamp <= enforced_at", "enforced_at >= not_after",
  "cap_asset == action_asset", "cap_asset == action_asset",
  "guard_verdict(enforced_at, not_before, not_after, cap_asset, cap_amount, egress_mode, action_kind, action_timestamp, action_asset, action_amount, counterparty_ok, prior_spent, egress_ok) == claimed",
];

const U64 = (...names: string[]) => names.map(name => `${name}: Uint<64>`).join(", ");
const CORE_PARAMS = `${U64("not_before", "not_after", "cap_amount")}, egress_mode: Uint<8>, action_kind: Uint<8>, ${U64("action_timestamp", "action_amount")}, `
  + "asset_ok: Boolean, counterparty_ok: Boolean, prior_spent: Uint<64>, egress_ok: Boolean";
const PREDICATE_PARAMS = `${U64("not_before", "not_after")}, cap_asset: Field, cap_amount: Uint<64>, egress_mode: Uint<8>, action_kind: Uint<8>, `
  + "action_timestamp: Uint<64>, action_asset: Field, action_amount: Uint<64>, counterparty_ok: Boolean, prior_spent: Uint<64>, egress_ok: Boolean";
const CORE_ARGS = "not_before, not_after, cap_amount, egress_mode, action_kind, action_timestamp, action_amount, asset_ok, counterparty_ok, prior_spent, egress_ok";
const WIRED_ARGS = "not_before, not_after, cap_amount, egress_mode, action_kind, action_timestamp, action_amount, cap_asset == action_asset, counterparty_ok, prior_spent, egress_ok";

/** Each circuit's signature, then its decisions in order, with every condition elided as `(...)`. */
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
    'assert (...), "verdict mismatch"',
    "verdictOut = disclose(claimed)",
  ],
};

interface Token { readonly kind: "number" | "name" | "string" | "punct"; readonly text: string }

function tokenize(source: string): Token[] {
  const pattern = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|("(?:[^"\\]|\\.)*")|(\d+)|([A-Za-z_]\w*)|(&&|\|\||[<>=!]=|[-+*<>=!?:(){}[\],;.#])/y;
  const tokens: Token[] = [];
  while (pattern.lastIndex < source.length) {
    const offset = pattern.lastIndex;
    const match = pattern.exec(source);
    if (!match) throw new Error(`cannot read the Compact source at offset ${offset}`);
    const [, string, number, name, punct] = match;
    if (string !== undefined) tokens.push({ kind: "string", text: string });
    else if (number !== undefined) tokens.push({ kind: "number", text: number });
    else if (name !== undefined) tokens.push({ kind: "name", text: name });
    else if (punct !== undefined) tokens.push({ kind: "punct", text: punct });
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

  // Declarations other than circuits (pragma, import, include, ledger) are skipped up to their semicolon.
  circuits(module = ""): Circuit[] {
    const found: Circuit[] = [];
    while (this.peek() !== undefined && this.peek() !== "}") {
      if (this.accept("module")) {
        const name = this.next().text;
        this.expect("{");
        found.push(...this.circuits(`${name}.`));
        this.expect("}");
        continue;
      }
      const modifiers: string[] = [];
      while (this.peek() === "export" || this.peek() === "pure") modifiers.push(this.next().text);
      if (this.accept("circuit")) found.push(this.circuit(module, modifiers));
      else while (this.next().text !== ";");
    }
    return found;
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

function decisions(statements: readonly Statement[]): string[] {
  return statements.flatMap(s => {
    switch (s.type) {
      case "assert": return [`assert ${ELIDED}, ${s.message}`];
      case "return": return [s.value === undefined ? "return" : `return ${render(s.value, true)}`];
      case "bind": return [`${s.target} = ${render(s.value, true)}`];
      case "if": {
        const [only] = s.then;
        const then = s.then.length === 1 && only!.type !== "if" ? [`if ${ELIDED} ${decisions(s.then)[0]}`] : [`if ${ELIDED} {`, ...decisions(s.then), "}"];
        return s.otherwise === undefined ? then : [...then, "else {", ...decisions(s.otherwise), "}"];
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

function multisetDifference(found: readonly string[], audited: readonly string[]): { added: string[]; removed: string[] } {
  const removed = [...audited];
  const added: string[] = [];
  for (const item of found) {
    const index = removed.indexOf(item);
    if (index < 0) added.push(item);
    else removed.splice(index, 1);
  }
  return { added, removed };
}

const byValue = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

/** The ways the sources differ from the audited structure; empty when they hold exactly the audited structure. */
export function auditStructure(sources: Sources): string[] {
  const circuits = AUDITED_FILES.flatMap(file => new Parser(tokenize(sources[file])).circuits());
  const findings: string[] = [];
  const report = (view: string, found: readonly string[], audited: readonly string[], order?: (a: string, b: string) => number) => {
    const { added, removed } = multisetDifference(found, audited);
    if (added.length + removed.length > 0) findings.push(`${view} differ from the audited list: added [${added.sort(order).join(", ")}], removed [${removed.sort(order).join(", ")}]`);
  };
  report("numeric literals", circuits.flatMap(c => c.literals), AUDITED_LITERALS, byValue);
  const all = circuits.flatMap(c => [...expressions(c.body)].flatMap(({ expr }) => [...subexpressions(expr)]));
  report("comparisons", all.flatMap(e => (e.type === "binary" && COMPARISONS.includes(e.op) ? [`${render(e.left)} ${e.op} ${render(e.right)}`] : [])), AUDITED_COMPARISONS);
  report("circuits", circuits.map(c => c.name), Object.keys(AUDITED_DECISIONS));
  for (const c of circuits) {
    const audited = AUDITED_DECISIONS[c.name];
    if (audited === undefined) continue;
    const found = [c.header, ...decisions(c.body)];
    const line = found.findIndex((text, i) => text !== audited[i]);
    const at = line < 0 && found.length < audited.length ? found.length : line;
    if (at >= 0) findings.push(`${c.name} differs from its audited decision list at line ${at + 1}: found ${JSON.stringify(found[at] ?? "the end")}, audited ${JSON.stringify(audited[at] ?? "the end")}`);
    const tests = [...expressions(c.body)].flatMap(({ expr, condition }) => [
      ...(condition ? [expr] : []), ...[...subexpressions(expr)].flatMap(e => (e.type === "ternary" ? [e.test] : [])),
    ]);
    for (const read of tests.flatMap(test => unauditedReads(test, c.booleans))) {
      findings.push(`a condition in ${c.name} reads ${render(read)}, which is neither a comparison nor a Boolean input`);
    }
  }
  return findings;
}
