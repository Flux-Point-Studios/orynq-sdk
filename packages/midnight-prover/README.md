# Midnight proofs

This package generates local Compact proofs and supplies an immutable on-chain presentation contract, `post` with a caller-supplied wallet, and `verifyPosted` from transaction bytes to authenticated GRANDPA-final execution. Status: **preprod-rehearsed**. The immutable contract is deployed on PREPROD; both SDK post calls were locally proven and independently verified from fresh tarballs to GRANDPA-final execution. No mainnet proof-contract deployment is recorded. See [on-chain API, replay policy, relay design and rehearsal state](ONCHAIN.md). The supported stack is Compact 0.31.1, compact-runtime 0.16.0, onchain-runtime-v3 3.1.2, ledger-v8 8.1.3 and zkir-v2 2.1.1; the native verifier is built from the same ledger 8.1.3 and onchain-runtime 3.1.2 release ([official support matrix](https://docs.midnight.network/relnotes/support-matrix)).

`RealMidnightProver` implements two statements:

| Statement | Private witness | Public outputs |
| --- | --- | --- |
| `lease-capability-v1` | Random 32-byte capability | `SHA256(capability32 \|\| contextDigest32) = commitment32`, and the deadline `notAfter` |
| `rolling-hash-chain-v1` | Event digests as lowercase ASCII hex | Genesis, rolling root, count, anchor hash, context digest and the deadline `notAfter` |

The rolling relation preserves Orynq's existing algorithm: `SHA256(UTF8('poi-trace:roll:v1|' + previousHex + '|' + eventHex))`. Each proof covers one link; a bundle checks the continuity and shared context of 1–128 links. It proves linkage of digests. Event-body canonicalization, policy evaluation, inference correctness and chain inclusion require separate evidence. An anchor hash supplied as a public input does not prove that an anchor exists on Cardano. Intermediate roots remain visible, and commitments to guessable data permit guessing attacks.

For broker authorization, a trusted issuer separately signs the commitment and exact task context. The broker still checks identity, scope, revocation and replay. Passing the broker's task deadline as `notAfter` binds it into the proof. The capability is a possession witness; it contains no password. Credential custody comes from a trusted executor consuming the password internally and returning a restricted receipt. A proof neither hides a remote AI prompt nor guarantees that a model stops requesting confirmation.

## Build

Use Node >=22.12.0 and Rust 1.99.0. Install the workspace dependencies with the committed pnpm lockfile. `tools/compactc/install.sh` installs Compact 0.31.1 and the ZK parameters the circuits need (k=13, 14 and 16), refusing any file whose sha256 differs from its pin:

```sh
pnpm install --frozen-lockfile
tools/compactc/install.sh ~/.cache/midnight/compactc ~/.cache/midnight/zk-params
COMPACTC=~/.cache/midnight/compactc/compactc MIDNIGHT_PP=~/.cache/midnight/zk-params \
  pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover build:circuits
pnpm build
pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover build:native
```

Circuit compilation generates `managed/contract`, proving and verifying keys, a trusted initial ledger template, and `managed/registry.json`. Never accept a registry, circuit path, compiled JavaScript module or verifier executable selected by an untrusted proof caller. Keep these artifacts outside caller write access. The native binary must be installed alongside the built JavaScript; it is built separately rather than embedded in the npm package. Rust dependencies are pinned by `native/Cargo.lock` and an exact official ledger commit.

With `MIDNIGHT_PP` naming the installer's parameter directory, the compiler fetches nothing. Point `paramsDir` at that directory. Both proof generation and native verification run locally. The prover sees the private witness and belongs inside the trusted worker.

## Generate and verify

```ts
import { createHash, randomBytes } from 'node:crypto';
import { RealMidnightProver } from '@fluxpointstudios/orynq-sdk-midnight-prover';

const prover = new RealMidnightProver({
  artifactsDir: '/trusted/midnight/managed',
  nativeVerifierPath: '/trusted/bin/orynq-midnight-verifier',
  paramsDir: '/trusted/midnight/zk-params',
});
const capability = randomBytes(32);
const contextDigest = createHash('sha256').update('synthetic task context').digest('hex');
const commitment = createHash('sha256')
  .update(capability).update(Buffer.from(contextDigest, 'hex')).digest('hex');
try {
  const proof = await prover.proveCapability({ capability, contextDigest, commitment });
  if (!await prover.verify(proof)) throw new Error('Invalid proof');
} finally {
  capability.fill(0);
}
```

`verify` checks genuine proof validity, the envelope's claimed public outputs and its proved deadline. Authorization code must also compare those outputs against its independently computed expected task. Proofs are transferable statements, so identity binding and nonce consumption remain application controls. The envelope's `verificationTimeUnixSeconds` is informational.

Version 2 envelopes prove their own deadline. Each circuit discloses `notAfter`, a Unix time in seconds, and asserts `blockTimeLt(notAfter)`, which Midnight's ledger evaluates against its own block time whenever it applies the call. Provers pass `notAfter` or take the default of 59 minutes after proving starts, and it may be at most one hour ahead. `verify` accepts an envelope only while the verifier's clock is before `notAfter` and `notAfter` is at most one hour ahead, and only when the proved deadline equals the claimed one. The transaction TTL is no freshness control: the binding signature does not cover it, so anyone holding an envelope can rewrite it, and a rewritten TTL cannot move the proved deadline. All links of a rolling bundle share one deadline, so the whole bundle must be proved before it passes; 128 links is an input bound, not a runtime guarantee. Within its window an envelope can be replayed by whoever holds it, so bind a broker nonce into `contextDigest` and consume it. For on-chain presentations, `verifyPosted` authenticates the historical block time and supports archival verification. Off-chain envelopes have no authenticated historical inclusion time.

The published JavaScript ledger WASM omits native proof verification. Its `verifyContractProofs` setting cannot enable omitted code. This package requires the native `proof-verifying` feature; WASM is used to decode public state only after native acceptance. See [native verifier](native/README.md) for its request contract and adversarial tests.

The broker CLI accepts `{proof, expected: {contextDigest, commitment}}` on stdin. `proof` is base64 JSON of a capability envelope. Configure `MIDNIGHT_ARTIFACT_REGISTRY` and invoke `node dist/verify-cli.js --native-verifier /trusted/bin/orynq-midnight-verifier`. Success emits only `{valid:true,contextDigest,commitment}`; missing configuration or failed verification returns `{valid:false}` and a nonzero exit. No proof, witness or verifier stderr is printed.

## Legacy APIs

`DefaultMidnightProver`, `HashChainProver`, `PolicyComplianceProver`, `SelectiveDisclosureProver`, `ProofServerClient` and `ProofPublisher` retain test fixtures behind explicit `mode: 'simulation'`. Their default mode refuses unsupported proof generation and publication. Simulation artifacts carry `simulation: true` and cannot enter the real verifier. Use `RealMidnightProver` for local envelopes and `post` / `verifyPosted` for on-chain presentations of the two implemented statements. No live policy, attestation, disclosure or inference implementation is claimed.

## Validation

```sh
pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover lint
pnpm typecheck
pnpm test
cargo test --release --locked --manifest-path packages/midnight-prover/native/Cargo.toml
ORYNQ_MIDNIGHT_PARAMS_DIR=~/.cache/midnight/zk-params \
  pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover test:real
```

The real integration command requires compiled artifacts and the native release binary; missing tooling fails rather than skips. It generates genuine capability and rolling proofs, checks the original private witness is absent from the serialized transaction, and rejects altered context, commitment, count, anchor, deadline, proof bytes and reordered links. It also waits out a short deadline and checks that the expired proof is rejected, with its TTL refreshed or not, and that a reference state with altered ledger parameters is refused. `tests/native-gate.test.ts` replays a recorded envelope against stand-in native verdicts and a fixed clock, so the unit suite fails if the native gate or the deadline check is removed. The native tests additionally reject altered public inputs with a refreshed transaction binding. Tests use synthetic values only. Production Entra authentication, Key Vault provisioning, actual carrier adapters and mainnet publication have not been exercised by these local tests.

Woodpecker compiles the pinned circuits, runs the native verifier tests and generates real proofs on every pull request. Release packaging depends on those checks and the blocking dependency audit. Only the existing publisher plugin receives the npm token.
