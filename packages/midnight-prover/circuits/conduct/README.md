# Conduct circuits (prototype)

Prototype: not deployed, ABI not frozen. These Compact 0.31.1 sources ship under `circuits/conduct` but nothing in the package entry exports or loads them. They port the conduct verdict of `@fluxpointstudios/orynq-sdk-conduct`'s runtime guard into compiled circuits so its behavior can be compared with the runtime before any proof statement is frozen.

## Files

| File | Content |
| --- | --- |
| `verdict_core.compact` | `module ConductVerdict`: `evaluate` (11 inputs, `asset_ok` as a Boolean) and `decide`, which adds the guard clock |
| `predicate.compact` | pure `evaluate` over the slice-1 12-slot `PREDICATE_LAYOUT`, pure `guard_verdict(enforced_at, ...12)`, and the provable `check_verdict(enforced_at, ...12, claimed)` that writes `verdictOut` to the ledger |
| `mutants.json` | one-edit discrimination mutants, compiled to `conduct-managed/mutants/<id>/` |
| `reference/poac_verdict_core.compact` | PoAC's verdict core wrapped as a 12-argument contract: the explicit-time reference of the mutant tests |
| `pins.json` | toolchain, source hashes, and for every provable circuit its ZKIR hash, the ZKIR hash of a recompile with every pure circuit unexported, k, rows and an op histogram |

`node scripts/compile-conduct.mjs --check` (run by `build:circuits`) compiles every unit into the gitignored `conduct-managed/` and mock-compiles the ZKIR. It recompiles `predicate.compact` with every pure circuit unexported and refuses any ZKIR difference; both hashes are pinned and `pureExportInvariant` records that they agree. It then requires the rebuilt pins to equal `pins.json` byte for byte. `--write` rewrites the pins. The script reads only files the npm package ships.

## Statement

| Statement | Disclosed (ledger) | Tied in-circuit to hashed bytes | Assumed | Refused |
| --- | --- | --- | --- | --- |
| S-PRED (`evaluate`, `guard_verdict`; `check_verdict` for ZKIR) | `check_verdict`: `verdictOut` | none; this is the verdict logic only | every input | action kind or egress mode outside {0, 1}; an action later than `enforced_at` |

## Claim

C1. On the inputs below, the compiled verdict agrees with the runtime guard. Its inputs are not authenticated at this layer.

- Generated JS (`pureCircuits`): `evaluate` equals `MandateGuard.evaluate` and `guard_verdict` equals `MandateGuard.enforce` on all 17 predicate-vector cases (23 steps), all 24 guard-vector sequences (31 steps), the clock cases, all 144 matrix combinations, the uint64 boundary and widened-sum cases, the Unicode and asset cases, and 400 generated two-step guard histories. These include 44 actions later than the guard clock, which the runtime and `guard_verdict` both refuse: a payment and a listed and an unlisted egress one second after a clock at each of four positions, and the 32 late matrix actions behind a clock inside validity. Before every step the harness's per-window spend model equals `guard.spentInWindow`.
- Three more sets hold inputs the runtime cannot take, so each names its own judge:
  - Invariance cases change an argument the verdict must ignore and expect the unmodified action's runtime decision. An egress ignores prior spend, counterparty membership, action asset and action amount, and also egress membership once deny-all or the validity window decides; a payment ignores egress membership.
  - Over-cap prior cases set `prior_spent` above the cap, which the runtime never holds, and expect the runtime's decision on a fresh payment of the same total.
  - Out-of-domain cases set the action kind or egress mode outside {0, 1}. The runtime schema has no such input, so there is no runtime decision to compare; both circuits must refuse, before any validity check decides.
- ZKIR (`check_verdict`, which is `guard_verdict`): on every listed case except the generated histories, `check` accepts exactly the expected verdict and the transcript discloses it as `verdictOut`. Every other claim among the codes 0–7 and the out-of-table values 8, 128 and 255 is refused, and for one case of each verdict code every other `Uint<8>` value is refused. An input the circuits refuse has no claimed value that checks. On the fixture steps, the honest input under another claim's ledger write is refused.
- The 12-argument `evaluate` is a pure circuit and has no ZKIR. Its explicit-time expiry (`action_timestamp >= not_after`) is evidenced only at the JS layer: inside `check_verdict` the clock rule already returns 2 whenever the action is at or past `notAfter`.

ZKIR `check` executes the compiled IR on the supplied input. It shows the compiled constraints reject a forgery; it is not proof verification.

## Divergences

The slice plan declares these differences from the runtime:

- Action kind and egress mode are asserted to be 0 or 1. The runtime schema admits nothing else; PoAC interpreted any non-zero value.
- The 12-argument `evaluate` has no clock. With a guard clock at or past `notAfter` and an earlier action time, the runtime denies `MANDATE_EXPIRED` and `evaluate` judges the action time. `guard_verdict` follows the runtime.
- Asset equality is tag equality. The circuits compare `assetTag` values, bytes 1–31 of an undomained SHA-256 of the asset (248 bits), where the runtime compares strings. The two agree only while that truncated hash resists collisions.

Three runtime refusals have no predicate input, and the plan does not declare them. They await the decision owner's ruling and stand outside C1 until then. The tests pin that `guard_verdict` returns a verdict where the runtime refuses:

- a guard clock in a different spend window from the action: the window width is not a predicate input;
- a guard clock that runs backward, or an action time that moves backward: the predicate sees one step;
- a payment of 0, which the runtime and `buildArgs` refuse before any circuit runs: the predicate has no amount floor.

## Evidence

The verdict of every check comes from the test process comparing circuit output with its judge, never from a file the circuit code writes. `tests/conduct/` holds the parity, matrix, boundary, domain, negative-control and constraint tests. Every mutant in `mutants.json` is killed: the VerdictCore mutants by a JS case, and every mutant that reaches `check_verdict` by its compiled constraints. `not_after_inclusive` changes only the 12-argument `evaluate`, which the tests pin. The claim covers the listed mutants, not every possible edit. A discrimination run swaps the predicate unit for a mutant and must fail:

```sh
CONDUCT_PREDICATE_UNIT=mutants/unconstrained_verdict pnpm exec vitest run packages/midnight-prover/tests/conduct/predicate-constraints.test.ts
```

## Non-claims

- Authenticity of any input. `counterparty_ok`, `egress_ok`, `prior_spent`, the asset tags and the mandate fields are caller-supplied; the negative controls show a false prior spend or a flipped membership Boolean changes the verdict.
- Cumulative or whole-run compliance, and the authenticity of any root, checkpoint, sequence or epoch.
- Non-membership: an off-list verdict is not a breach.
- Proof validity. No key or proof exists for these circuits, and no JS simulation or ZKIR `check` shows one would verify.
