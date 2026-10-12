# Midnight proofs

As of 2026-10-12 this package generates local Compact proofs and verifies them with the native Midnight ledger. It publishes no transactions and has no deployed contract. The supported stack is Compact 0.31.1, compact-runtime 0.16.0, onchain-runtime 3.0.0, ledger-v8 8.1.3 and zkir-v2 2.1.1 ([official support matrix](https://docs.midnight.network/relnotes/support-matrix)).

`RealMidnightProver` implements two statements:

| Statement | Private witness | Public outputs |
| --- | --- | --- |
| `lease-capability-v1` | Random 32-byte capability | `SHA256(capability32 \|\| contextDigest32) = commitment32` |
| `rolling-hash-chain-v1` | Event digests as lowercase ASCII hex | Genesis, rolling root, count, anchor hash and context digest |

The rolling relation preserves Orynq's existing algorithm: `SHA256(UTF8('poi-trace:roll:v1|' + previousHex + '|' + eventHex))`. Each proof covers one link; a bundle checks the continuity and shared context of 1–128 links. It proves linkage of digests. Event-body canonicalization, policy evaluation, inference correctness and chain inclusion require separate evidence. An anchor hash supplied as a public input does not prove that an anchor exists on Cardano. Intermediate roots remain visible, and commitments to guessable data permit guessing attacks.

For broker authorization, a trusted issuer separately signs the commitment and exact task context. The broker still checks identity, scope, deadlines, revocation and replay. The capability is a possession witness; it contains no password. Credential custody comes from a trusted executor consuming the password internally and returning a restricted receipt. A proof neither hides a remote AI prompt nor guarantees that a model stops requesting confirmation.

## Build

Use Node >=22.12.0 and Rust 1.99.0. Install the workspace dependencies with the committed pnpm lockfile. Install Compact 0.31.1 from its official release and supply its absolute executable path:

```sh
pnpm install --frozen-lockfile
COMPACTC=/absolute/path/to/compactc pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover build:circuits
pnpm build
pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover build:native
```

Circuit compilation generates `managed/contract`, proving and verifying keys, a trusted initial ledger template, and `managed/registry.json`. Never accept a registry, circuit path, compiled JavaScript module or verifier executable selected by an untrusted proof caller. Keep these artifacts outside caller write access. The native binary must be installed alongside the built JavaScript; it is built separately rather than embedded in the npm package. Rust dependencies are pinned by `native/Cargo.lock` and an exact official ledger commit.

The compiler downloads the public SRS parameters to `$XDG_CACHE_HOME/midnight/zk-params`, or the platform's default cache. Point `paramsDir` at that directory. Both proof generation and native verification run locally. The prover sees the private witness and belongs inside the trusted worker.

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

`verify` checks genuine proof validity and the envelope's claimed public outputs. Authorization code must also compare those outputs against its independently computed expected task. Proofs are transferable statements, so identity binding and nonce consumption remain application controls. Proof creation time is informational; native verification uses the verifier's actual clock, and application expiry remains mandatory.

Version 1 envelopes are local transactions with a one-hour validity window starting at each link's generation. An expired envelope is rejected even when its underlying contract proof remains sound. These envelopes are suited to immediate verification. A long sequential bundle can outlive its earliest link and must be verified before use; 128 links is an input bound, not a runtime guarantee. Durable archival verification needs a separate predicate-verification design. Supplying an old verification timestamp cannot extend validity. The broker's signed task deadline can be much shorter and always governs credential use.

The published JavaScript ledger WASM omits native proof verification. Its `verifyContractProofs` setting cannot enable omitted code. This package requires the native `proof-verifying` feature; WASM is used to decode public state only after native acceptance. See [native verifier](native/README.md) for its request contract and adversarial tests.

The broker CLI accepts `{proof, expected: {contextDigest, commitment}}` on stdin. `proof` is base64 JSON of a capability envelope. Configure `MIDNIGHT_ARTIFACT_REGISTRY` and invoke `node dist/verify-cli.js --native-verifier /trusted/bin/orynq-midnight-verifier`. Success emits only `{valid:true,contextDigest,commitment}`; missing configuration or failed verification returns `{valid:false}` and a nonzero exit. No proof, witness or verifier stderr is printed.

## Legacy APIs

`DefaultMidnightProver`, `HashChainProver`, `PolicyComplianceProver`, `SelectiveDisclosureProver`, `ProofServerClient` and `ProofPublisher` retain test fixtures behind explicit `mode: 'simulation'`. Their default mode refuses unsupported proof generation and publication. Simulation artifacts carry `simulation: true` and cannot enter the real verifier. Production callers must migrate to `RealMidnightProver` for the two implemented statements. No live policy, attestation, disclosure, inference or network-publication implementation is claimed.

## Validation

```sh
pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover lint
pnpm typecheck
pnpm test
cargo test --release --locked --manifest-path packages/midnight-prover/native/Cargo.toml
ORYNQ_MIDNIGHT_PARAMS_DIR=/absolute/path/to/zk-params \
  pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover test:real
```

The real integration command requires compiled artifacts and the native release binary; missing tooling fails rather than skips. It generates genuine capability and rolling proofs, checks the original private witness is absent from the serialized transaction, and rejects altered context, commitment, count, anchor, proof bytes and reordered links. The native tests additionally reject altered public inputs with a refreshed transaction binding. Tests use synthetic values only. Production Entra authentication, Key Vault provisioning, actual carrier adapters and mainnet publication have not been exercised by these local tests.

Woodpecker compiles the pinned circuits, runs the native verifier tests and generates real proofs on every pull request. Release packaging depends on those checks and the blocking dependency audit. Only the existing publisher plugin receives the npm token.
