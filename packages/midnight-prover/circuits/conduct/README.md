# Conduct circuits (prototype)

Prototype: not deployed, ABI not frozen. These Compact 0.31.1 sources ship under `circuits/conduct` but nothing in the package entry exports or loads them. They port the conduct verdict of `@fluxpointstudios/orynq-sdk-conduct`'s runtime guard into compiled circuits so its behavior can be compared with the runtime before any proof statement is frozen.

## Files

| File | Content |
| --- | --- |
| `verdict_core.compact` | `module ConductVerdict`: `evaluate` (11 inputs, `asset_ok` as a Boolean) and `decide`, which adds the guard clock |
| `predicate.compact` | pure `evaluate` over the slice-1 12-slot `PREDICATE_LAYOUT`, pure `guard_verdict(enforced_at, ...12)`, and the provable `check_verdict(enforced_at, ...12, claimed)` that writes `verdictOut` to the ledger |
| `mutants.json` | one-edit discrimination mutants, and one recorded equivalent mutant, compiled to `conduct-managed/mutants/<id>/` |
| `reference/poac_verdict_core.compact` | PoAC's verdict core wrapped as a 12-argument contract. It ships in the package only as the explicit-time test oracle of the mutant tests, is built as its own `reference` unit, pins nothing and is never deployed |
| `pins.json` | toolchain, source hashes, and for every provable circuit its ZKIR hash, k, rows and an op histogram |

`node scripts/compile-conduct.mjs --check` (run by `build:circuits`) compiles the `predicate`, `mutants` and `reference` units into the gitignored `conduct-managed/` and mock-compiles the ZKIR. It recompiles `predicate.compact` with every pure circuit unexported and refuses any difference in the provable circuits' ZKIR; `pureExportInvariant: true` is written only after that comparison passed, so the assurance is the refusal, which the tests exercise with a compiler that perturbs the unexported compile. It then requires the rebuilt pins to equal `pins.json` byte for byte. `--write` rewrites the pins. The script takes only `--check` or `--write` and one optional `--units` list, and reads only files the npm package ships.

## Statement

| Statement | Disclosed (ledger) | Tied in-circuit to hashed bytes | Assumed | Refused |
| --- | --- | --- | --- | --- |
| S-PRED (`evaluate`, `guard_verdict`; `check_verdict` for ZKIR) | `check_verdict`: `verdictOut` | none; this is the verdict logic only | every input; for `guard_verdict`, the D12 guard-state preconditions below | action kind or egress mode outside {0, 1}; a payment of 0; an action later than `enforced_at` |

## Claim

C1. On the inputs below, the compiled verdict agrees with the runtime guard. Its inputs are not authenticated at this layer. `guard_verdict`'s agreement is conditional on the D12 preconditions: the runtime refuses a step that breaks one of them, and `guard_verdict` cannot see them.

- Generated JS (`pureCircuits`): `evaluate` equals `MandateGuard.evaluate` and `guard_verdict` equals `MandateGuard.enforce` on all 17 predicate-vector cases (23 steps), all 24 guard-vector sequences (31 steps), the clock cases, all 144 matrix combinations, the uint64 boundary and widened-sum cases, the Unicode and asset cases, 43 spend-window cases (41 of them follow an allowed payment in the same spend window), 103 range steps, 1,000 generated two-step guard histories with small values, and 2,000 generated two-step histories drawn across uint64. Before every step the harness's per-window spend model equals `guard.spentInWindow`.
  - The range steps put every verdict and the later-than-clock refusal, for a payment and an egress at every validity and clock position, at the bottom of uint64, at Unix times around 1.7e9 in one day's spend window, and at the top, where the cap, the amount and the prior spend reach 2^64−1 and the guard clock reaches 2^64−1 under a spend window of 2^63.
  - The histories drawn across uint64 take every numeric slot from its edges, both sides of 2^32, Unix times around 1.7e9, small values and the whole range, with the validity window placed around the action times and the cap around the amounts.
  - A coverage test requires every verdict and refusal, at every action and clock position it reaches, to meet each numeric slot (guard clock, `notBefore`, `notAfter`, cap, action time, amount, prior spend) within 3 of both ends of uint64, and each Boolean slot it leaves free (egress mode, asset match, counterparty membership, egress membership) at both values. So a verdict rule or refusal that applies only on one side of a threshold between 3 and 2^64−4 in one of those slots, or only at one value of a free Boolean, disagrees with its judge on one of those cases.
  - The steps after a spend put a prior spend above 0 against every clock-decided expiry (clock at and past `notAfter`, with action-time verdicts 0, 4, 0 and 7), every action-time expiry, a clock ahead inside validity where the prior decides 0 or 4, and an action later than the clock.
  - The generated histories put a first payment inside validity under a cap with room for it three times in four. A coverage test requires at least 10 steps with a prior spend above 0 for each of a clock-decided expiry, an action-time expiry, a payment over the cap and an allowed payment.
  - 67 actions are later than the guard clock, and the runtime and `guard_verdict` both refuse them: a payment and a listed and an unlisted egress one second after a clock at each of four positions, the 32 late matrix actions behind a clock inside validity, and 23 spend-window cases, which also meet priors of 1, the whole cap and 2^64−1, caps of 0 and 2^64−1, and payments of 1 and 2^64−1.
- Three more sets hold inputs the runtime cannot take, so each names its own judge:
  - Invariance cases change an argument the verdict must ignore and expect the unmodified action's runtime decision. An egress ignores prior spend, counterparty membership, action asset and action amount, and also egress membership once deny-all or the validity window decides; a payment ignores egress membership, and also the asset, membership, prior spend and amount once the validity window decides, the slots after the asset once the asset decides, and the prior spend and amount once membership decides. Every range step the runtime decides has each slot its decisions ignore moved to the other end of its range.
  - Over-cap prior cases set `prior_spent` above the cap, which the runtime never holds, and expect the runtime's decision on a fresh payment of the same total.
  - Out-of-domain cases set the action kind or egress mode outside {0, 1}, or a payment amount to 0. The runtime schema refuses or cannot express these, so there is no runtime decision to compare; both circuits must refuse, before any validity check decides. The 226 cases are built on every validity position, a base after a spend, and, inside validity, priors of 1, the cap and 2^64−1, caps of 0 and 2^64−1 and amounts of 1 and 2^64−1; and on every range step the runtime decides, at all three scales, with each top step also taken with its ignored slots moved to the other end. So each refusal meets deny-all and allowlist mandates, an asset mismatch, an off-list counterparty, a payment with egress membership set, an action time of 0, and a prior spend of 2^64−1 at every validity and clock position.
- ZKIR (`check_verdict`, which is `guard_verdict`): on every listed case except the generated histories, `check` accepts exactly the expected verdict and the transcript discloses it as `verdictOut`. Every other claim among the codes 0–7 and the out-of-table values 8, 128 and 255 is refused, and for one case of each verdict code every other `Uint<8>` value is refused. An input the circuits refuse has no claimed value that checks. On the fixture steps, the honest input under another claim's ledger write is refused. Of the histories drawn across uint64, every 50th step (80 steps) is checked the same way against every claim.
- The 12-argument `evaluate` is a pure circuit and has no ZKIR. Its explicit-time expiry (`action_timestamp >= not_after`) is evidenced only at the JS layer: inside `check_verdict` the clock rule already returns 2 whenever the action is at or past `notAfter`.

ZKIR `check` executes the compiled IR on the supplied input. It shows the compiled constraints reject a forgery; it is not proof verification.

## Divergences

The slice plan and the decision owner's rulings declare these differences from the runtime:

- Action kind and egress mode are asserted to be 0 or 1 (D2), and a payment amount to be at least 1 (AM-2). The runtime schema admits nothing else and refuses a zero payment (`SCHEMA_BAD_AMOUNT`); PoAC interpreted any non-zero kind or mode. An egress, whose amount slot is 0, still evaluates.
- The 12-argument `evaluate` has no clock. With a guard clock at or past `notAfter` and an earlier action time, the runtime denies `MANDATE_EXPIRED` and `evaluate` judges the action time. `guard_verdict` follows the runtime.
- Asset equality is tag equality. The circuits compare `assetTag` values, bytes 1–31 of an undomained SHA-256 of the asset (248 bits), where the runtime compares strings. The two agree only while that truncated hash resists collisions.
- D12 (AM-3): three runtime refusals are preconditions on guard state. A pure verdict over one step cannot see prior calls or the window width. `guard_verdict`'s statement is conditional on them, and the tests pin that it returns a verdict where the runtime refuses:
  - a guard clock that moves backward;
  - an action time that moves backward;
  - a guard clock in a different spend window from the action.

  They become circuit obligations later: the same-window check in the slice 2c step circuit, through its window witness, and monotonicity in slice 3's committed predecessor state.

## Evidence

The verdict of every check comes from the test process comparing circuit output with its judge, never from a file the circuit code writes. `tests/conduct/` holds the parity, matrix, boundary, domain, negative-control and constraint tests. Every mutant in `mutants.json` except the one equivalent mutant below is killed: the VerdictCore mutants by a JS case, and every mutant that reaches `check_verdict` by its compiled constraints. The domain-assert and amount-floor removals are killed by the out-of-domain cases. The listed mutants that gate a verdict rule on the size of the guard clock, `notBefore`, `notAfter`, the action time, the cap, the amount or the prior spend, or on egress membership for a payment, and those that waive a refusal on such a size, on a Boolean, or on a prior spend together with a time, cap or amount, are killed by the range steps, their invariance flips and the refusals built on them. `not_after_inclusive`, `expiry_needs_zero_prior`, `expiry_needs_small_amount` and `expiry_skipped_for_payment_with_egress_ok` change only the 12-argument `evaluate`, which the tests pin. The claim covers the listed mutants, not every possible edit; the coverage test keeps the cases that kill any single-slot gate of that kind.

An equivalent mutant is removed from the killed count with recorded evidence (AM-1). The plan's "egress `mode != 1` returns 6" cannot differ from the circuit, because the egress-mode domain assert runs first on every path. It is compiled as `egress_mode_not_one_denies`, and `predicate-mutants.test.ts` shows its ZKIR differs from the predicate's yet `evaluate` and `guard_verdict` match the predicate on every case and on 65,536 inputs: every `egress_mode` byte, action kinds 0, 1, 2 and 255, four action and clock positions, every combination of the three Booleans, and priors of 0 and 2^64−1. `mode_domain_assert_removed` replaces it among the killed mutants.

A discrimination run swaps the predicate unit for a mutant and must fail:

```sh
CONDUCT_PREDICATE_UNIT=mutants/unconstrained_verdict pnpm exec vitest run packages/midnight-prover/tests/conduct/predicate-constraints.test.ts
```

## Non-claims

- Authenticity of any input. `counterparty_ok`, `egress_ok`, `prior_spent`, the asset tags and the mandate fields are caller-supplied; the negative controls show a false prior spend or a flipped membership Boolean changes the verdict.
- Cumulative or whole-run compliance, and the authenticity of any root, checkpoint, sequence or epoch.
- Non-membership: an off-list verdict is not a breach.
- Proof validity. No key or proof exists for these circuits, and no JS simulation or ZKIR `check` shows one would verify.
