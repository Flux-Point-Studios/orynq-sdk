# On-chain proof presentations

Status: implementation under review; no preprod or mainnet deployment is recorded. The local native-ledger rehearsal does not establish network inclusion or finality. See [rehearsal evidence](onchain/REHEARSAL.md).

This extends the existing local prover and consumes the anchor package's GRANDPA verifier, authenticated runtime/events proofs, transaction decoder and RPC transport. The original local envelope format and circuits remain available.

## Contract and trust

`onchain/orynq.compact` preserves the capability relation `SHA256(capability32 || context32)`, the exact `poi-trace:roll:v1|` rolling relation, lowercase ASCII hex checks for both rolling digests, and the ledger's `blockTimeLt(notAfter)` assertion. A presentation contains its circuit kind, commitment or genesis/root/anchor, context and deadline. Each circuit inserts that record into a map keyed by `persistentHash<Presentation>(record)`. It never reads the previous map value. The only equality assertion in the public transcript checks the clock predicate. Independently prepared calls can therefore apply successively without sharing an old-state assertion, and different records remain available. Storage grows with distinct presentations; an identical presentation overwrites only its identical key.

The transaction's guaranteed transcript is the receipt. Verification reconstructs the expected record from those bytes, rather than consulting a mutable latest-value slot. A valid receipt proves the relation at its authenticated block time. It does not prove inference correctness, task authorization, or the existence of the supplied Cardano anchor hash. Archival verification remains valid after the presentation deadline; an authorization broker must additionally require its current time to precede that deadline.

The deployment has exactly two provable operations and maintenance authority `committee=[], threshold=1, counter=0`. No admin or maintenance key exists. `onchain/pins.json` records the verifier keys, serialized initial-state digest, generated JavaScript, proving artifacts and source digest. Here **code hash** means SHA-256 of the canonical serialized `proveCapability` operation followed by the canonical serialized `proveRolling1` operation, in that order. The stronger initial-state digest additionally binds the schema, empty map and immutable authority.

The address is **not** the code hash. Ledger 8 derives it as SHA-256 of the tagged serialized `ContractDeploy`, containing that exact initial state and a randomly sampled deployment nonce. A prepared deployment fixes the address; the journal preserves its exact bytes across retries. This follows the [pinned ledger source](https://github.com/midnightntwrk/midnight-ledger/blob/b5d3e965a18e4cac17fac4f38446fc55c524439a/ledger/src/structure.rs).

Capability presentations deliberately have **no on-chain nullifier**. They are public, transferable possession statements, not consumption of a resource owned by this contract. The broker must bind its identity, exact action, subject and unpredictable single-use nonce into `contextDigest`, authenticate the requesting subject separately, verify the issuer's commitment, enforce revocation and current expiry, and atomically consume that nonce before authorizing the action. Merely copying a public proof does not authenticate its presenter; context binding alone cannot prevent front-running. Replaying a presentation or paying its fee gives no new authorization. A future application that needs consensus-wide consumption requires a separate nullifier relation and contract version.

## Post with a supplied wallet

```ts
import { post } from '@fluxpointstudios/orynq-sdk-midnight-prover';

const submitted = await post({
  network: 'preprod',
  address: deployedAddress,
  statement: {
    circuit: 'proveCapability',
    commitment, contextDigest,
    notAfter: Math.floor(Date.now() / 1000) + 3540,
  },
  witness: { capability },
  paramsDir: '/trusted/midnight/zk-params',
  wallet,
});
```

The developer supplies `wallet.network`, `wallet.payFee(provenTransaction, ttl)` and `wallet.submit(finalizedTransaction)`. The existing private submit package's `OperatorWallet` satisfies this interface. `post` generates the contract proof locally with pinned keys and parameters before handing a transaction to the wallet. No witness, unproven transaction, proof-server request or private transcript is passed to the wallet. The wallet is responsible for its own key custody, fee cap, DUST balancing and local proving of its fee spend. `submitted.txHash` identifies the **final** transaction after balancing; submission is not finality. A durable application should journal the final bytes before its wallet broadcasts them, as the private release operator does.

Use `circuit: 'proveRolling1'` with `genesisHash`, `rootHash`, `anchorHash`, `contextDigest`, `notAfter`, and witness `{eventDigest}` for one exact rolling step. Multiple links are separate presentations; a caller verifies their continuity.

## Verify from a fresh install

```ts
import { verifyPosted } from '@fluxpointstudios/orynq-sdk-midnight-prover';
import { rpcOnlySource } from '@fluxpointstudios/orynq-sdk-anchors-midnight';

const source = rpcOnlySource({
  network: 'preprod', node: readRpcUrl, registries: [],
  hints: [deploymentBlockHint, proofBlockHint],
});
const result = await verifyPosted({
  network: 'preprod', address: deployedAddress,
  deployTxHash: deploymentBlockHint.txHash,
  txHash: proofBlockHint.txHash,
  statement: expectedStatement,
}, { source, checkpoints: trustedCheckpoints });
```

Block hints locate bytes and confer no trust. Checkpoints must come from the caller's independently authenticated network configuration, never from an untrusted proof or indexer. The verifier checks canonical transaction bytes and hashes, complete block-body roots, exact bare Midnight extrinsic inclusion, checkpoint-rooted GRANDPA finality, authenticated successful execution and timestamp, the exact pinned immutable deployment, deployment ordering, target contract/circuit, and the expected presentation. It refuses partial success. The finality helper uses the same pinned runtime metadata and storage proofs as anchors-midnight. The mainnet read-RPC supports these reads without a new contract-state allowlist entry because this verifier uses deployment and call bytes, not `midnight_contractState`.

The npm artifact includes the contract, keys, initial state and pins. **Posted-proof verification needs no Rust toolchain or native executable.** Consensus execution establishes cryptographic proof validity. Local off-chain envelope verification and the integration test still use the native verifier; JavaScript ledger WASM alone does not perform cryptographic verification. `assertPostedProof` is only a transcript decoder and is not an authorization verdict.

`ProofPublisher` remains an explicit simulator and says so. Use `post` and `verifyPosted` for real transactions.

## Toolchain and reproduction

Pins match the existing registry deployment: compactc 0.31.1, compact-runtime 0.16.0, ledger-v8 8.1.3, onchain-runtime-v3 3.1.2, zkir-v2 2.1.1 and wallet-sdk 1.2.0's facade 4.1.0. No midnight-js dependency is introduced. [Compiler releases](https://github.com/midnightntwrk/compact/releases) distinguish the ledger-8 0.31 line from newer ledger-9 compilers.

`build:circuits` compiles the existing local circuits and independently reproduces the committed on-chain pins. `build:onchain` intentionally regenerates the deployable artifacts; changing its pins requires a new review. `test:onchain-real` generates both proofs, verifies them with the native verifier, applies both against one local ledger and checks that both records survive. Native tests replay the committed real transactions with proof verification enabled and reject both after their proved deadline even if their transaction TTL is extended.

## FPS fee sponsorship feasibility

Feasible on the **pinned ledger-8 stack**, without receiving the witness. This is a design finding, not an implemented or funded service. The [official sponsorship guide](https://docs.midnight.network/guides/dust-sponsorship) describes finalized-transaction sponsorship. The installed `wallet-sdk-facade@4.1.0` implementation already exposes `balanceFinalizedTransaction(tx, keys, {ttl, tokenKindsToBalance:['dust']})`: it builds a separate DUST balancing transaction; `finalizeRecipe` proves/binds that transaction and calls `originalTransaction.merge(finalizedBalancing)`. Ledger 8 permits merging when only one side has contract interactions.

Proposed flow:

1. The agent builds and proves locally, then binds the fee-less contract transaction.
2. FPS receives only canonical finalized bytes. A native verifier checks the proof before FPS spends proving CPU or reserves DUST; the service checks the pinned deployment/circuit, public statement, deadline, action count and absence of unrelated token operations.
3. The service authenticates the caller, deduplicates the original call identifier, reserves a policy-authorized quota, balances DUST only, signs/proves its fee transaction and merges it with the untouched contract transaction.
4. It journals the merged bytes and declared fee before submission, returns the final transaction hash and later its block hint. The caller independently runs `verifyPosted`.

The sponsor learns public statements, timestamps and network metadata, but no capability or event witness. It can censor, delay or replay a public presentation; the broker nonce still prevents repeated authorization. The binding does not authenticate the transaction TTL, so policy must check the **proved deadline**. Proof screening, budgets, crash recovery, fee-spend expiry and replay accounting make this more than a trivial hosted endpoint. The existing standing anchor approval authorizes anchors only and cannot fund this proposed relay. Hosting and spending policy require deci's decision.
