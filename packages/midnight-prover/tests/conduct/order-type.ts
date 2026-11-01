import {
  assetTag, compileMandatePredicate, MandateError, PREDICATE_LAYOUT, VERDICT_NAME, type GuardAction, type PredicateArgs,
} from "@fluxpointstudios/orynq-sdk-conduct";
import { allowlists, decisionCode, egress, guardFor, MAX_U64, payment, policy, slot, T0, type Policy } from "./cases.js";
import type { Outcome } from "./harness.js";
import { AUDITED_COMPARISONS } from "./structure.js";

export const ORDER_SCALES = ["low", "unix", "top"] as const;
export type OrderScale = (typeof ORDER_SCALES)[number];

const HALF_U64 = 1n << 63n;
// low: the four times at 0..3. unix: Unix times a day apart, with amounts and priors between 2^32 and 2^53, where
// lovelace amounts lie. top: the latest time at 2^64-1 and the others 2^32 apart below it, in one spend window of 2^63.
const SCALES: Record<OrderScale, { readonly at: (rank: number, levels: number) => bigint; readonly window: bigint; readonly amount: bigint; readonly prior: bigint }> = {
  low: { at: rank => BigInt(rank), window: MAX_U64, amount: 5n, prior: 3n },
  unix: { at: rank => T0 + BigInt(rank) * 86_400n, window: MAX_U64, amount: 700_000_000_000n, prior: 500_000_000_000n },
  top: { at: (rank, levels) => MAX_U64 - BigInt(levels - 1 - rank) * (1n << 32n), window: HALF_U64, amount: HALF_U64 - 7n, prior: HALF_U64 - 5n },
};

const TIMES = ["notBefore", "notAfter", "ts", "clock"];

/** Every weak ordering of notBefore, notAfter, the action time and the guard clock, as a rank per time. */
export function weakOrderings(): number[][] {
  const orderings: number[][] = [];
  for (let code = 0; code < 4 ** TIMES.length; code++) {
    const ranks = TIMES.map((_, i) => Math.floor(code / 4 ** i) % 4);
    const levels = new Set(ranks).size;
    if (ranks.every(rank => rank < levels)) orderings.push(ranks);
  }
  return orderings;
}

export interface OrderChunk { readonly scale: OrderScale; readonly ranks: readonly number[]; readonly label: string }

export const orderChunks = (): OrderChunk[] => ORDER_SCALES.flatMap(scale => weakOrderings().map(ranks => {
  const levels = Array.from({ length: new Set(ranks).size }, (_, level) => TIMES.filter((_, i) => ranks[i] === level).join(" = "));
  return { scale, ranks, label: `${scale}: ${levels.join(" < ")}` };
}));

export interface OrderCell {
  readonly scale: OrderScale;
  readonly name: string;
  readonly enforcedAt: bigint;
  readonly args: PredicateArgs;
  readonly window: bigint;
  /** The runtime holds the prior spend before the step: an allowed payment of it opens the spend window. */
  readonly held: boolean;
}

const MEMBER = "alice";
const STRANGER = "mallory";
const LISTED = "api.example.com";
const UNLISTED = "evil.example.com";
const LOVELACE = assetTag("lovelace");
const DUST = assetTag("dust");

function capFor(sum: bigint, relation: "<" | "=" | ">"): bigint | undefined {
  if (relation === "<") return sum < MAX_U64 ? sum + 1n : undefined;
  if (relation === "=") return sum <= MAX_U64 ? sum : undefined;
  return sum === 0n ? undefined : sum - 1n > MAX_U64 ? MAX_U64 : sum - 1n;
}

export function cellsOf({ scale, ranks, label }: OrderChunk): OrderCell[] {
  const { at, window, amount: mid, prior: midPrior } = SCALES[scale];
  const levels = new Set(ranks).size;
  const [nb, na, ts, clock] = ranks.map(rank => at(rank, levels)) as [bigint, bigint, bigint, bigint];
  const cells: OrderCell[] = [];
  for (const amount of [0n, 1n, mid]) for (const prior of [0n, midPrior, MAX_U64]) for (const relation of ["<", "=", ">"] as const) {
    const cap = capFor(prior + amount, relation);
    if (cap === undefined) continue;
    for (const kind of [0n, 1n, 2n, 255n]) for (const mode of [0n, 1n, 2n, 255n]) {
      const held = prior > 0n && prior <= cap && nb < na && mode <= 1n && nb <= ts && nb <= clock;
      if (prior === MAX_U64 && !held) continue;
      for (const assetOk of [true, false]) for (const counterpartyOk of [true, false]) for (const egressOk of [true, false]) {
        const values: Record<string, bigint | boolean> = {
          not_before: nb, not_after: na, cap_asset: LOVELACE, cap_amount: cap, egress_mode: mode, action_kind: kind, action_timestamp: ts,
          action_asset: assetOk ? LOVELACE : DUST, action_amount: amount, counterparty_ok: counterpartyOk, prior_spent: prior, egress_ok: egressOk,
        };
        cells.push({
          scale, enforcedAt: clock, window, held,
          args: PREDICATE_LAYOUT.map(input => values[input.name]!) as PredicateArgs,
          get name() {
            return `${label}, kind ${kind} mode ${mode} amount ${amount} prior ${prior} sum ${relation} cap ${cap} asset ${assetOk} counterparty ${counterpartyOk} egress ${egressOk}`;
          },
        });
      }
    }
  }
  return cells;
}

const chunkJudgements = new Map<string, readonly Judgement[]>();

/** The runtime's judgement of each of the chunk's cells, in cellsOf order; judged once per run. */
export function judgementsOf(chunk: OrderChunk, cells: readonly OrderCell[]): readonly Judgement[] {
  const known = chunkJudgements.get(chunk.label);
  if (known !== undefined) return known;
  const judged = cells.map(judge);
  chunkJudgements.set(chunk.label, judged);
  return judged;
}

export function* orderCases(): Generator<{ readonly cell: OrderCell; readonly judged: Judgement }> {
  for (const chunk of orderChunks()) {
    const cells = cellsOf(chunk);
    const judged = judgementsOf(chunk, cells);
    for (const [i, cell] of cells.entries()) yield { cell, judged: judged[i]! };
  }
}

// Most cells are refused, so both circuits throw on them, and capturing those throws' stacks costs five times the rest of
// a scan. The scan reads only the messages.
export function withoutStacks<T>(scan: () => T): T {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    return scan();
  } finally {
    Error.stackTraceLimit = limit;
  }
}

export type Judged = number | "refused";

const REFUSALS = ["validity window out of domain", "action kind out of domain", "egress mode out of domain", "payment amount out of domain", "action after guard clock"]
  .map(message => `failed assert: ${message}`);

/** A circuit outcome meets the runtime's when both are the same verdict, or both refuse. */
export const agrees = (got: Outcome, judged: Judged) => (judged === "refused" ? typeof got !== "number" && REFUSALS.includes(got.throws) : got === judged);

export interface Judgement {
  /** `MandateGuard.evaluate`, the explicit-time judge of the 12-argument evaluate. */
  readonly evaluate: Judged;
  /** `MandateGuard.enforce` under the cell's clock, the judge of guard_verdict. */
  readonly guard: Judged;
  /** The decision the runtime reached, or the refusal it raised first. */
  readonly path: string;
}

const CLOCK_REFUSAL = /action timestamp must not be later than the guard clock/;
const REFUSAL_PATHS: Readonly<Record<string, string>> = {
  SCHEMA_BAD_VALIDITY: "refused: empty validity window", SCHEMA_BAD_EGRESS: "refused: egress mode",
  SCHEMA_BAD_TYPE: "refused: action kind", SCHEMA_BAD_AMOUNT: "refused: zero payment",
};

// A refusal the schema raises, or the later-than-clock refusal, is a judgement; any other throw is a harness error, such
// as a D12 precondition the construction was meant to avoid.
function refusalOf(error: unknown): string {
  if (error instanceof MandateError && REFUSAL_PATHS[error.code] !== undefined) return REFUSAL_PATHS[error.code]!;
  if (error instanceof Error && CLOCK_REFUSAL.test(error.message)) return "refused: later than the clock";
  throw error;
}

const judgements = new Map<string, Judgement>();

/**
 * The runtime's decisions for the cell, through its own code path: a guard built from the cell's mandate, an allowed
 * opening payment of the prior spend where the runtime can hold it, then the action under the cell's clock. Slots the
 * runtime has no input for take the decision of the action it can take: a payment's egress membership, an egress's
 * asset, amount and counterparty membership, a prior spend the runtime cannot hold before an egress, and egress
 * membership under deny-all. A payment after a prior the runtime cannot hold is judged as one payment of the total.
 */
function judge(cell: OrderCell): Judgement {
  const v = (name: string) => cell.args[slot(name)]!;
  const [nb, na, cap, mode, kind, ts, amount, prior] = ["not_before", "not_after", "cap_amount", "egress_mode", "action_kind", "action_timestamp", "action_amount", "prior_spent"]
    .map(name => v(name) as bigint) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  const asset = v("action_asset") === v("cap_asset") ? "lovelace" : "dust";
  const counterparty = v("counterparty_ok") ? MEMBER : STRANGER;
  const destination = mode === 1n && v("egress_ok") ? LISTED : UNLISTED;
  const step: GuardAction = kind === 0n ? payment(cell.held || amount === 0n ? amount : prior + amount, ts, asset, counterparty)
    : kind === 1n ? egress(destination, ts) : { kind: `kind ${kind}`, timestamp: ts } as unknown as GuardAction;
  const key = [nb, na, cap, mode, cell.window, prior, cell.held, cell.enforcedAt, kind, ts, ...(kind === 0n ? [amount, asset, counterparty] : kind === 1n ? [destination] : [])].join("|");
  const known = judgements.get(key);
  if (known !== undefined) return known;

  const base = policy({ cap, window: cell.window, notBefore: nb, notAfter: na, counterparties: [MEMBER], ...(mode === 1n ? { egress: [LISTED] } : {}) });
  const p: Policy = mode > 1n ? { ...base, mandate: { ...base.mandate, egressPolicy: { mode, allowlistRoot: new Uint8Array(32) } } } : base;
  let now = 0n;
  let judgement: Judgement;
  try {
    const guard = guardFor(p, () => now);
    if (cell.held) {
      now = nb;
      if (!guard.enforce(payment(prior, nb, "lovelace", MEMBER)).allowed) throw new Error(`${cell.name}: the opening payment was denied`);
    }
    if (guard.spentInWindow(ts) !== (cell.held ? prior : 0n)) throw new Error(`${cell.name}: the guard does not hold the prior spend`);
    const evaluate = (() => {
      try {
        return decisionCode(guard.evaluate(step));
      } catch (error) {
        refusalOf(error);
        return "refused" as const;
      }
    })();
    now = cell.enforcedAt;
    try {
      const code = decisionCode(guard.enforce(step));
      const qualifier = code === 0 ? (kind === 0n ? " payment" : " egress") : code === 2 ? (ts >= na ? " by the action time" : " by the clock") : "";
      judgement = { evaluate, guard: code, path: `${code} ${VERDICT_NAME[code]}${qualifier}` };
    } catch (error) {
      judgement = { evaluate, guard: "refused", path: refusalOf(error) };
    }
  } catch (error) {
    judgement = { evaluate: "refused", guard: "refused", path: refusalOf(error) };
  }
  if (kind <= 1n && (kind === 1n || amount > 0n) && judgement.path !== "refused: empty validity window" && judgement.path !== "refused: egress mode") {
    requireBuiltArgs(cell, p, kind === 0n ? payment(amount, ts, asset, counterparty) : step);
  }
  judgements.set(key, judgement);
  return judgement;
}

// The cell's slots equal what the runtime's own argument builder makes of the action, except the slots it has no input for.
function requireBuiltArgs(cell: OrderCell, p: Policy, action: GuardAction): void {
  const built = compileMandatePredicate(p.mandate, allowlists(p)).buildArgs(action, cell.args[slot("prior_spent")] as bigint);
  const free = action.kind === "payment" ? ["egress_ok"]
    : ["action_asset", "action_amount", "counterparty_ok", ...(cell.args[slot("egress_mode")] === 0n ? ["egress_ok"] : [])];
  const differing = PREDICATE_LAYOUT.filter((input, i) => !free.includes(input.name) && built[i] !== cell.args[i]).map(input => input.name);
  if (differing.length > 0) throw new Error(`${cell.name}: buildArgs differs in ${differing.join(", ")}`);
}

/** The audited comparisons, the verdict claim aside, and the Boolean inputs no comparison reads. */
export const ATOMS: readonly { readonly text: string; readonly inputs: readonly string[]; holds(env: Readonly<Record<string, bigint | boolean>>): boolean }[] = [
  ...[...new Set(AUDITED_COMPARISONS.filter(text => !text.includes("(")))].map(text => {
    const [, left, op, right] = /^(.+) (<=|>=|==|!=|<|>) (.+)$/.exec(text)!;
    const terms = (side: string) => side.split(" + ");
    const value = (side: string, env: Readonly<Record<string, bigint | boolean>>) =>
      terms(side).reduce((sum, term) => sum + (/^\d+$/.test(term) ? BigInt(term) : env[term] as bigint), 0n);
    const compare: Record<string, (a: bigint, b: bigint) => boolean> = { "<=": (a, b) => a <= b, ">=": (a, b) => a >= b, "==": (a, b) => a === b, "!=": (a, b) => a !== b, "<": (a, b) => a < b, ">": (a, b) => a > b };
    return { text, inputs: [left!, right!].flatMap(terms).filter(term => !/^\d+$/.test(term)), holds: (env: Readonly<Record<string, bigint | boolean>>) => compare[op!]!(value(left!, env), value(right!, env)) };
  }),
  ...PREDICATE_LAYOUT.filter(input => input.type === "boolean").map(({ name }) => ({
    text: name, inputs: [name], holds: (env: Readonly<Record<string, bigint | boolean>>) => env[name] === true,
  })),
];

export function atomTruths(cell: OrderCell): boolean[] {
  const env = { ...Object.fromEntries(PREDICATE_LAYOUT.map((input, i) => [input.name, cell.args[i]!])), enforced_at: cell.enforcedAt };
  return ATOMS.map(atom => atom.holds(env));
}
