# Validation record

## Completed preprod rehearsal — 2026-10-26

The unchanged implementation at `a87db7e683ec60773bf29ea85c73cfb74d713e78` passed Woodpecker pipeline **211**, all three workflows. This isolated follow-up reproduced all compiler pins, built the complete workspace, passed **30 public proof/finality tests** and **14 private release tests**, and installed fresh tarballs in an independent consumer. No production implementation changed in this follow-up.

The funded wallet synchronized, registered NIGHT for DUST, deployed the pinned immutable contract at **3151664**, and posted `proveCapability` at **3151676** and `proveRolling1` at **3151703** through the SDK with local witnesses. Fresh-installed `verifyPosted` returned **valid=true, assurance=consensus-verified** for both. Required fees were **1 SPECK** each; encoded declarations burned **2 SPECK** each. The independently replayed checkpoint path contains **1,065 authority-set changes**. Exact hashes, statements, package checksums and verifier outputs are in [REHEARSAL.md](REHEARSAL.md) and [preprod-rehearsal.json](preprod-rehearsal.json).

The one-off scratch scripts use the stated scratch-script TDD exception and were exercised against the real preprod runtime. The batching investigation is tracked in [#199](https://github.com/Flux-Point-Studios/orynq-sdk/issues/199); production defaults are unchanged. The mainnet authorization pins and spending ceilings were rechecked against these results; only the measured preprod evidence was added. No mainnet action, runner approval file, service change, merge, tag or npm publication occurred. The evidence commit has its own CI gate, reported on PR #194.

All local builds and tests run at `nice -n 10` in the task's isolated checkout, with Node's heap bounded to 2–4 GiB. Native builds use two jobs; the native on-chain replay command also ran under an 8 GiB virtual-memory limit. No funded wallet, service or container is used by these tests.

## RED → GREEN

Commands below run from the repository root unless a package directory is named.

| Behavior | Command | RED evidence | GREEN evidence |
|---|---|---|---|
| Immutable state, exact capability and rolling relations, canonical hex, deadline | `pnpm exec vitest run packages/midnight-prover/src/__tests__/onchain.test.ts --maxWorkers=1` | Missing `../onchain.js` before implementation | 8 tests pass |
| Authenticated transaction primitive | `pnpm exec vitest run packages/anchors-midnight/src/__tests__/finalized-transaction.test.ts --maxWorkers=1` | Missing finalized-transaction module | 5 tests pass, including genuine recorded GRANDPA/execution proofs and altered-body/finality/execution negatives |
| Expected transcript, contract, circuit, public inputs and deadline | `pnpm exec vitest run packages/midnight-prover/src/__tests__/posted.test.ts --maxWorkers=1` | Missing posted module | 8 tests pass |
| Local proof before wallet access; witness isolation | `pnpm exec vitest run packages/midnight-prover/src/__tests__/post.test.ts --maxWorkers=1` | Missing post module | 3 tests pass |
| Exact private release intent | From `packages/anchors-midnight-submit`: `pnpm exec vitest run runner/test/proof-release.test.ts --maxWorkers=1` | Missing intent module; subsequently the completion regression returned `done` on an empty journal | Gate/summary tests pass; empty-journal completion is refused |
| Bounded, durable release | From `packages/anchors-midnight-submit`: `pnpm exec vitest run test/proof-release.test.ts --maxWorkers=1` | Invalid prepare label was not rejected; missing `proofReleaseComplete`; invalid submit label actually broadcast a synthetic transaction; wallet bytes with a two-hour TTL extension were accepted; the deploy summary also accepted a deadline beyond the next hour | Prepare/resume/submit reject unknown labels; actual intent TTLs must match the summary and all three labels must fit the next hour; three exact journalled transactions survive reopen without another broadcast; completion requires all three |
| Native proof application and deadline | `cargo +1.99.0 test --release --locked --manifest-path packages/midnight-prover/native/Cargo.toml --test onchain` | Both tests failed before the real-proof fixtures existed | 2 tests pass with cryptographic verification enabled |

Decoder and wallet-ordering tests use fixture proof bytes through `tests/fixture-prover.ts`; they make no cryptographic-validity claim. The integration test generates fresh proofs with pinned local key material and asks the native verifier to verify them. Rust replay independently verifies and applies those recorded transactions. Its only relaxed rule is fee balancing, because the local rehearsal has no funded DUST inputs.

The simulator's comment/log wording uses the observability-only TDD exception. One-off fresh-consumer probes live outside production code and use the scratch-script exception. The publisher's existing 56-test suite passes after the wording changes.

## Reproduction

```sh
export COMPACTC=/home/deci/.cache/orynq-midnight/compactc/compactc
export MIDNIGHT_PP=/home/deci/.cache/orynq-midnight/zk
export NODE_OPTIONS=--max-old-space-size=4096
export CARGO_BUILD_JOBS=2
export CARGO_TARGET_DIR=/home/deci/work/scratch-midnight-prover-onchain-20261026/native-target
export ORYNQ_MIDNIGHT_PARAMS_DIR="$MIDNIGHT_PP"
export ORYNQ_MIDNIGHT_NATIVE_VERIFIER="$CARGO_TARGET_DIR/release/orynq-midnight-verifier"

nice -n 10 pnpm install --frozen-lockfile
nice -n 10 pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover build:circuits
nice -n 10 pnpm -r --workspace-concurrency=1 build
nice -n 10 pnpm -r --workspace-concurrency=1 typecheck
nice -n 10 pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover lint
nice -n 10 pnpm exec vitest run --maxWorkers=1
nice -n 10 pnpm -C packages/anchors-midnight-submit exec vitest run --maxWorkers=1
nice -n 10 pnpm -C packages/anchors-midnight exec vitest run test-journal --maxWorkers=1
nice -n 10 pnpm -C packages/anchors-midnight exec vitest run --config vitest.slow.config.ts --maxWorkers=1
nice -n 10 pnpm -C packages/anchors-midnight-submit exec vitest run --config vitest.slow.config.ts --maxWorkers=1
nice -n 10 cargo +1.99.0 fmt --manifest-path packages/midnight-prover/native/Cargo.toml -- --check
nice -n 10 cargo +1.99.0 clippy --release --locked --manifest-path packages/midnight-prover/native/Cargo.toml --all-targets -- -D warnings
nice -n 10 cargo +1.99.0 test --release --locked --manifest-path packages/midnight-prover/native/Cargo.toml
nice -n 10 pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover test:real
```

For a fresh native build on Gemtek, set `ulimit -v 8388608` in the native-build shell. `check:onchain` independently reproduced the committed compiler outputs and pins. The initial full repository run passed **2,775 tests**, with **45 existing skips** in legacy credential-gated Cardano/EVM/live tests. No newly added test is skipped. The additional proof-verifier composition suite passed **6 tests** against real local transaction bytes, with authenticated-transaction results supplied at the seam; it does not simulate GRANDPA signatures. Workspace build/typecheck, prover lint, dependency-security tests (14) and dependency audit (no known vulnerabilities) passed.

Fresh-package and live read-RPC evidence, and the distinction between local and network rehearsal, are in [REHEARSAL.md](REHEARSAL.md). The private runner's exact proposed authorization is in [PROOF-RELEASE.md](../../anchors-midnight-submit/runner/PROOF-RELEASE.md).

The private full run passed 799 tests; its key-material suite failed to load because that invocation omitted `MIDNIGHT_PP`. Rerunning `test/zk.test.ts` with the pinned parameter directory passed its 5 tests. The journal suite passed 38 tests, the registry slow suite passed 5, and the submitter slow suite passed 2. After the TTL and deploy-window regressions, the final focused release run passed **14 tests** and private type checking passed. The final focused public run passed **30 tests**, with prover build and lint green. Native Clippy completed without warnings. The reproduction block exports `MIDNIGHT_PP` before the full private command, matching CI.

Full native tests passed **17/17**, with no ignored tests. `PYTHONPATH=python python3 -m pytest python/tests/` passed **262**, with **2 existing skips**. The watch and accounting Python suites passed **15** and **9** respectively. TypeScript and Python hash vectors passed; this host has `python3` but no `python` alias, so the Python vector leg was run explicitly as `python3 scripts/verify-hash-vectors.py` after the aggregate script could not find `python`.

The combined `test:real` command passed: genuine capability, two-link rolling chain, cryptographic tampering rejection, proved expiry and witness privacy; then fresh on-chain capability and rolling proofs independently verified by the native executable and applied to one local ledger retaining both records.
