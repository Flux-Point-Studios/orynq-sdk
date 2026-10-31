# Conduct circuits (prototype)

Prototype: not deployed, ABI not frozen. These Compact 0.31.1 sources ship under `circuits/conduct` but nothing in the package entry exports or loads them. They port the conduct verdict of `@fluxpointstudios/orynq-sdk-conduct`'s runtime guard into compiled circuits so its behavior can be compared with the runtime before any proof statement is frozen.

## Files

| File | Content |
| --- | --- |
| `verdict_core.compact` | `module ConductVerdict`: `evaluate` (11 inputs, `asset_ok` as a Boolean) and `decide`, which adds the guard clock |
| `predicate.compact` | pure `evaluate` over the slice-1 12-slot `PREDICATE_LAYOUT`, pure `guard_verdict(enforced_at, ...12)`, and the provable `check_verdict(enforced_at, ...12, claimed)` that writes `verdictOut` to the ledger |
| `mutants.json` | one-edit discrimination mutants, compiled to `conduct-managed/mutants/<id>/` |
| `pins.json` | toolchain, source hashes, and the ZKIR hash, k, rows and op histogram of every provable circuit |

`node scripts/compile-conduct.mjs --check` (run by `build:circuits`) compiles every unit into the gitignored `conduct-managed/`, mock-compiles the ZKIR, checks that demoting the exported pure circuits leaves the ZKIR unchanged (`pureExportInvariant`), and requires the rebuilt pins to equal `pins.json` byte for byte. `--write` rewrites the pins.

## Statement

| Statement | Disclosed (ledger) | Tied in-circuit to hashed bytes | Assumed | Refused |
| --- | --- | --- | --- | --- |
| S-PRED (`evaluate`, `guard_verdict`; `check_verdict` for ZKIR) | `check_verdict`: `verdictOut` | none; this is the verdict logic only | every input | action kind or egress mode outside {0, 1}; an action later than `enforced_at` |

## Claim

C1. On the inputs below, the compiled verdict agrees with the runtime guard. Its inputs are not authenticated at this layer.

- Generated JS (`pureCircuits`): `evaluate` equals `MandateGuard.evaluate` and `guard_verdict` equals `MandateGuard.enforce` on all 17 predicate-vector cases (23 steps), all 24 guard-vector sequences (31 steps), the clock cases, the 112 feasible matrix combinations, the uint64 boundary and widened-sum cases, the Unicode and asset cases, the invariance cases, the out-of-domain refusals, and 400 generated two-step guard histories.
- ZKIR (`check_verdict`, which is `guard_verdict`): on every one of those listed cases except the generated histories, `check` accepts exactly the runtime's verdict, the transcript discloses that verdict as `verdictOut`, every other claimed code is refused, and out-of-domain and later-than-clock inputs have no verdict that checks. On the fixture steps, the honest input under another claim's ledger write is refused.
- The 12-argument `evaluate` is a pure circuit and has no ZKIR. Its explicit-time expiry (`action_timestamp >= not_after`) is evidenced only at the JS layer: inside `check_verdict` the clock rule already returns 2 whenever the action is at or past `notAfter`.

ZKIR `check` executes the compiled IR on the supplied input. It shows the compiled constraints reject a forgery; it is not proof verification.

## Declared divergences and preconditions

The circuits agree with the runtime only on inputs the runtime accepts, and differ from it exactly here:

- Action kind and egress mode are asserted to be 0 or 1. The runtime schema admits nothing else; PoAC interpreted any non-zero value.
- The 12-argument `evaluate` has no clock. With a guard clock at or past `notAfter` and an earlier action time, the runtime denies `MANDATE_EXPIRED` and `evaluate` judges the action time. `guard_verdict` follows the runtime.
- `guard_verdict` sees one step. The runtime also refuses a clock in a different spend window from the action, a clock that runs backward and an action time that moves backward; the circuit has no input for any of them and returns a verdict. A step circuit must enforce the window itself.
- The runtime and `buildArgs` refuse a payment of 0 before any circuit runs; the circuit has no amount floor.

## Evidence

The verdict of every check comes from the test process comparing circuit output with the runtime, never from a file the circuit code writes. `tests/conduct/` holds the parity, matrix, boundary, domain, negative-control and constraint tests. Every mutant in `mutants.json` is killed: the VerdictCore mutants by a JS case, and every mutant that reaches `check_verdict` by its compiled constraints. `not_after_inclusive` changes only the 12-argument `evaluate`, which the tests pin. A discrimination run swaps the predicate unit for a mutant and must fail:

```sh
CONDUCT_PREDICATE_UNIT=mutants/unconstrained_verdict pnpm exec vitest run packages/midnight-prover/tests/conduct/predicate-constraints.test.ts
```

## Non-claims

- Authenticity of any input. `counterparty_ok`, `egress_ok`, `prior_spent`, the asset tags and the mandate fields are caller-supplied; the negative controls show a false prior spend or a flipped membership Boolean changes the verdict.
- Cumulative or whole-run compliance, and the authenticity of any root, checkpoint, sequence or epoch.
- Non-membership: an off-list verdict is not a breach.
- Proof validity. No key or proof exists for these circuits, and no JS simulation or ZKIR `check` shows one would verify.
