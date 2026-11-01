# Conduct circuits (prototype)

Prototype: not deployed, ABI not frozen. These Compact 0.31.1 sources ship under `circuits/conduct` but nothing in the package entry exports or loads them. They port the conduct verdict of `@fluxpointstudios/orynq-sdk-conduct`'s runtime guard into compiled circuits so its behavior can be compared with the runtime before any proof statement is frozen.

## Files

| File | Content |
| --- | --- |
| `verdict_core.compact` | `module ConductVerdict`: `evaluate` (11 inputs, `asset_ok` as a Boolean) and `decide`, which adds the guard clock |
| `predicate.compact` | pure `evaluate` over the slice-1 12-slot `PREDICATE_LAYOUT`, pure `guard_verdict(enforced_at, ...12)`, and the provable `check_verdict(enforced_at, ...12, claimed)` that writes `verdictOut` to the ledger |
| `mutants.json` | one-edit discrimination mutants, and one recorded equivalent mutant, each compiled from its own edited sources in `conduct-managed/mutants/<id>/source/` |
| `reference/poac_verdict_core.compact` | PoAC's verdict core wrapped as a 12-argument contract. It ships in the package only as the explicit-time test oracle of the mutant tests, is built as its own `reference` unit, pins nothing and is never deployed |
| `pins.json` | toolchain, source hashes, and for every provable circuit its ZKIR hash, k, rows and an op histogram |

`node scripts/compile-conduct.mjs --check` (run by `build:circuits`) compiles the `predicate`, `mutants` and `reference` units into the gitignored `conduct-managed/` and mock-compiles the ZKIR. It recompiles `predicate.compact` with every pure circuit unexported and refuses any difference in the provable circuits' ZKIR; `pureExportInvariant: true` is written only after that comparison passed, so the assurance is the refusal, which the tests exercise with a compiler that perturbs the unexported compile. It then requires the rebuilt pins to equal `pins.json` byte for byte. `--write` rewrites the pins. The script takes only `--check` or `--write` and one optional `--units` list, and reads only files the npm package ships. Each compiled unit's source map is rooted at the sources it was compiled from.

## Statement

| Statement | Disclosed (ledger) | Tied in-circuit to hashed bytes | Assumed | Refused |
| --- | --- | --- | --- | --- |
| S-PRED (`evaluate`, `guard_verdict`; `check_verdict` for ZKIR) | `check_verdict`: `verdictOut` | none; this is the verdict logic only | every input; for `guard_verdict`, the D12 guard-state preconditions below | an empty validity window (`not_before >= not_after`); action kind or egress mode outside {0, 1}; a payment of 0; an action later than `enforced_at` |

## Claim

C1. On the inputs below, the compiled verdict agrees with the runtime guard. Its inputs are not authenticated at this layer. `guard_verdict`'s agreement is conditional on the D12 preconditions: the runtime refuses a step that breaks one of them, and `guard_verdict` cannot see them.

The evidence has two legs that hold together (AM-6): an audit of the sources' structure, and an exhaustive differential over the space that structure leaves open.

- Structure (T-A16, `predicate-structure.test.ts`). The audit parses `verdict_core.compact` and `predicate.compact` and requires exactly the audited structure, which `tests/conduct/structure.ts` lists:
  - the 16 numeric literals: the verdict codes 0–7, the kind and mode tests, the domain bounds and the amount floor;
  - the 15 comparisons, each with its operands;
  - each circuit's signature, its calls with their arguments, and its decisions in order.

  Every condition may only combine audited comparisons and Boolean inputs with `!`, `&&` and `||`. An edit that adds, removes or re-pairs a literal or a comparison, changes a signature or a call, or moves a decision fails with an exact message. The test shows this for a band between 2^32 and 2^53 on the cap rule, a comparison of the action time with the cap, and the 4/5 rules swapped.
- Order types (T-A17, `predicate-order.test.ts`). The cells take all 75 weak orderings of `notBefore`, `notAfter`, the action time and the guard clock at three scales:
  - 0 to 3;
  - Unix times a day apart around 1.7e9, with amounts, priors and caps between 2^32 and 2^53, where lovelace amounts lie;
  - the top of uint64, the latest time at 2^64−1 and the others 2^32 apart below it.

  They cross each ordering with action kinds 0, 1, 2 and 255, egress modes 0, 1, 2 and 255, every relation of prior spend plus amount to the cap, amounts of 0, 1 and a mid value, priors of 0, a mid value and 2^64−1 where the runtime can hold it, and every asset, counterparty and egress membership: 501,120 cells.
  - Each cell is judged by the runtime guard through its own code path: a guard built from the cell's mandate, an allowed payment opening the spend window where the runtime can hold the prior, then the action under the cell's clock.
  - `evaluate` must equal `MandateGuard.evaluate` and `guard_verdict` must equal `MandateGuard.enforce`, and each must refuse wherever the runtime refuses: an empty validity window, a mode or kind outside {0, 1}, a zero payment, or an action later than the clock. Every cell agrees.
  - Slots the runtime has no input for take the decision of the action it can take: a payment's egress membership; an egress's asset, amount and counterparty membership; egress membership under deny-all; and a prior the runtime cannot hold before an egress. A payment after a prior the runtime cannot hold, because no allowed payment can precede `notBefore` or the clock, is judged as one payment of the total.
  - A coverage test shows that the cells meet every truth assignment of the audited comparisons and Boolean inputs that any input can produce. Comparisons that share no input are independent, and each group's reachable assignments are found by brute force.
  - So an edit that passes T-A16 and changes a verdict or a refusal on any input disagrees with the runtime on a T-A17 cell.
- T-A17 ZKIR leg. For each decision path (ten verdict paths and five refusals) at each scale, the sample takes the first cell to which no other refusal applies, and also the first such cell after a spend: 81 cells. `check` accepts exactly the runtime verdict and discloses it, and refuses every claim for a refused cell.
- Named sets, at the generated-JS layer. `evaluate` equals `MandateGuard.evaluate` and `guard_verdict` equals `MandateGuard.enforce` on:
  - all 17 predicate-vector cases (23 steps) and all 24 guard-vector sequences (31 steps);
  - the clock cases and all 144 matrix combinations;
  - the uint64 boundary and widened-sum cases, and the Unicode and asset cases;
  - 43 spend-window cases, 41 of which follow an allowed payment in the same spend window;
  - 103 range steps, at the bottom of uint64, at Unix times in one day's spend window and at the top;
  - 1,000 generated two-step guard histories with small values, and 2,000 drawn across uint64.

  Before every step the harness's per-window spend model equals `guard.spentInWindow`. 115 actions are later than the guard clock, and the runtime and `guard_verdict` both refuse them: 12 clock cases, the 32 late matrix actions, 24 range steps, their 24 invariance flips and 23 spend-window cases.
- Three more named sets hold inputs the runtime cannot take, so each names its own judge:
  - Invariance cases change an argument the verdict must ignore and expect the unmodified action's runtime decision.
  - Over-cap prior cases set `prior_spent` above the cap, which the runtime never holds, and expect the runtime's decision on a fresh payment of the same total.
  - The 246 out-of-domain cases set an empty validity window, an action kind or egress mode outside {0, 1}, or a payment amount of 0. Both circuits must refuse them.
- ZKIR on the named sets (`check_verdict`, which is `guard_verdict`). On every named case except the generated histories, `check` accepts exactly the expected verdict and the transcript discloses it as `verdictOut`.
  - Every other claim among the codes 0–7 and the out-of-table values 8, 128 and 255 is refused, and for one case of each verdict code every other `Uint<8>` value is refused.
  - None of the 361 refused named cases has a claim that checks.
  - On the fixture steps, the honest input under another claim's ledger write is refused.
  - Of the histories drawn across uint64, every 50th step (80 steps) is checked against every claim.
- The 12-argument `evaluate` is a pure circuit and has no ZKIR. Its explicit-time expiry (`action_timestamp >= not_after`) is evidenced only at the JS layer: inside `check_verdict` the clock rule already returns 2 whenever the action is at or past `notAfter`.

ZKIR `check` executes the compiled IR on the supplied input. It shows the compiled constraints reject a forgery; it is not proof verification.

## Divergences

The slice plan and the decision owner's rulings declare these differences from the runtime:

- The circuits refuse the inputs the runtime schema refuses, where PoAC returned a verdict:
  - an empty validity window (AM-6.2), which the runtime refuses at mandate construction (`SCHEMA_BAD_VALIDITY`);
  - action kind and egress mode outside {0, 1} (D2), where PoAC interpreted any non-zero kind or mode;
  - a payment amount of 0 (AM-2), which the runtime refuses as `SCHEMA_BAD_AMOUNT`.

  An egress, whose amount slot is 0, still evaluates.
- The 12-argument `evaluate` has no clock. With a guard clock at or past `notAfter` and an earlier action time, the runtime denies `MANDATE_EXPIRED` and `evaluate` judges the action time. `guard_verdict` follows the runtime.
- Asset equality is tag equality. The circuits compare `assetTag` values, bytes 1–31 of an undomained SHA-256 of the asset (248 bits), where the runtime compares strings. The two agree only while that truncated hash resists collisions.
- D12 (AM-3): three runtime refusals are preconditions on guard state. A pure verdict over one step cannot see prior calls or the window width. `guard_verdict`'s statement is conditional on them, and the tests pin that it returns a verdict where the runtime refuses:
  - a guard clock that moves backward;
  - an action time that moves backward;
  - a guard clock in a different spend window from the action.

  They become circuit obligations later: the same-window check in the slice 2c step circuit, through its window witness, and monotonicity in slice 3's committed predecessor state.

## Evidence

The verdict of every check comes from the test process comparing circuit output with its judge, never from a file the circuit code writes. `tests/conduct/` holds the structure, order-type, parity, matrix, boundary, domain, negative-control, constraint and mutant tests.

AM-6 retires "every named mutant is killed" as the bar. A mutant that fails T-A16 is answered by it. A mutant that passes T-A16 can only re-wire the audited comparisons and Boolean inputs inside audited conditions, and T-A17 must kill it; one that survives is a HIGH finding. `predicate-mutants.test.ts` shows:

- The ten re-wiring mutants in `mutants.json` are exactly the mutants that pass T-A16, and T-A17 kills each one.
- The sixteen mutants the round-5 review found surviving fail T-A16. T-A17 kills each at JS, and the compiled constraints refuse one of its T-A17 cells at ZKIR. They include bands between 2^32 and 2^53 on the cap, counterparty, asset and clock rules, refusals waived strictly past `notAfter` or far past the clock, and waivers gated on a prior spend under deny-all or an off-list counterparty.
- Every other mutant in `mutants.json` is still killed by a named case or a T-A17 cell, and every one that reaches `check_verdict` by its compiled constraints. The domain-assert, amount-floor and validity-window removals are killed by the out-of-domain cases.
- `not_after_inclusive`, `expiry_needs_zero_prior`, `expiry_needs_small_amount` and `expiry_skipped_for_payment_with_egress_ok` change only the 12-argument `evaluate`. They never change `guard_verdict` on any named case or T-A17 cell.

An equivalent mutant is removed from the killed count with recorded evidence (AM-1). The plan's "egress `mode != 1` returns 6" cannot differ from the circuit, because the egress-mode domain assert runs first on every path. It is compiled as `egress_mode_not_one_denies`, and `predicate-mutants.test.ts` shows its ZKIR differs from the predicate's yet `evaluate` and `guard_verdict` match the predicate on every case and on 65,536 inputs: every `egress_mode` byte, action kinds 0, 1, 2 and 255, four action and clock positions, every combination of the three Booleans, and priors of 0 and 2^64−1. `mode_domain_assert_removed` replaces it among the killed mutants.

A discrimination run swaps the predicate unit for a mutant and must fail. The first run fails with "forged verdict accepted"; the second fails T-A16 with its exact message:

```sh
CONDUCT_PREDICATE_UNIT=mutants/unconstrained_verdict pnpm exec vitest run packages/midnight-prover/tests/conduct/predicate-constraints.test.ts
CONDUCT_PREDICATE_UNIT=mutants/cap_rule_skipped_in_amount_band pnpm exec vitest run packages/midnight-prover/tests/conduct/predicate-structure.test.ts
```

## Non-claims

- Authenticity of any input. `counterparty_ok`, `egress_ok`, `prior_spent`, the asset tags and the mandate fields are caller-supplied; the negative controls show a false prior spend or a flipped membership Boolean changes the verdict.
- Cumulative or whole-run compliance, and the authenticity of any root, checkpoint, sequence or epoch.
- Non-membership: an off-list verdict is not a breach.
- Proof validity. No key or proof exists for these circuits, and no JS simulation or ZKIR `check` shows one would verify.
