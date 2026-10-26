# Proof presentation rehearsal — 2026-10-26

Status: **preprod-rehearsed**. The immutable contract was deployed on Midnight PREPROD, both witnesses were proven locally through SDK `post`, and a fresh tarball installation independently verified both calls through authenticated execution and GRANDPA finality. No mainnet proof-contract deployment or runner execution occurred.

Machine-readable receipts, exact statements, verifier outputs, package checksums and provenance: [preprod-rehearsal.json](preprod-rehearsal.json).

## Network and funding

Network genesis: `df831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b`. Runtime spec: 1000300. Authenticated Blockfrost preprod endpoints were selected explicitly; no provider default changed. The supplied project ID was read only in-process from the permitted task file. No `~/.secrets` access, service change, merge, tag or npm publication occurred.

Wallet: `mn_addr_preprod1pju7t5t0lej86fyp6c63gyhy823e5zh2py4m4lkzpjhvf0sv4ylsrzw2pz`. Its 5,000 tNIGHT payment was independently consensus-verified in block 3150901, transaction `bdba9f29be53f71572fb12c4620d6fd6d43d1df41f22c2554a14fd4f45473164`. The faucet identifier `00e16532647cbcc331c19697c9cdd8eaeb1bfe03eabb8843cfba30f80f06668f99` is an intent identifier, distinct from this final transaction hash.

NIGHT registration: `f7544fb5dbef368890c94c10793ce94d3b1101c707b413d89477561f88d76624`, block 3151647, hash `cf248d69325f0a33cb8032f59932226aeee93b999041a65f3ed4e35b5b7ca32d`. The wallet then generated DUST and saved a validated snapshot. The retained wallet and journal remain outside the repository.

## Deployment and calls

Contract address: `9020196694e9738b77d977985f35b05a64aae79346ec87400750b48e38f27de6`. The deployment exactly matches the pinned initial state and immutable maintenance authority (empty committee, threshold 1, counter 0). Both proof calls used SDK `post`, including local circuit proving, the supplied fee wallet and the durable preprod release journal.

| Transaction | Final transaction hash | Block | Block hash |
|---|---|---:|---|
| `deploy` | `d133a44a4978458d7950641f680256e940a809c7b0736090f3ae6193ccd5dc25` | 3151664 | `301f43611c552bf57ec3cb286094800fd957c0184054bd44f0ae104b4c3290b2` |
| `proveCapability` | `62e01625f2159ba9de6cc30b467dcf2c52c518f497148ec089f6f0c87af1ad40` | 3151676 | `ee2e5db28016032578f9e847c7ffbd123958330958976f10d5325bb448fd3b00` |
| `proveRolling1` | `072b650be00ae312605b5217e204cc248ec17e2a7b9e56d04f1d8169e6824425` | 3151703 | `5d937fcfe11c3f34622214c7a669342918c509ef16d258721d7faec1e0abe17a` |

## Fresh-package verification

Both updated packages were packed from the isolated checkout and installed with `npm install --ignore-scripts --no-audit --no-fund` into a new consumer directory. Import realpaths were checked to remain inside that consumer, and each tarball was checked against its npm lockfile SHA-512 integrity plus a recorded SHA-256. No native verifier executable or workspace import was used by this consumer.

The consumer independently replayed 1065 authority-set changes from the committed preprod checkpoint (set 9497 after block 2834399) to block 3151111. That walk used 426 authenticated HTTP requests. Its verified checkpoint was persisted in the same consumer; the final read-only verification rechecked package integrity and used 26 further HTTP requests. Transaction block hints located bytes; body inclusion, execution, block time and GRANDPA finality were authenticated independently.

- `proveCapability` at block 3151676: `valid=true`, `assurance=consensus-verified`; presentation ID `715d448574f27f03755a6f532c4472eaffad2a7396a263816b6dfdb378ad0d46`.
- `proveRolling1` at block 3151703: `valid=true`, `assurance=consensus-verified`; presentation ID `17e5d217e9ccd40698d176628d2537ef958baa94078cacc0c6efbf92a781b1b1`.

## Measured fees

| Transaction | Required fee, SPECK | Declared and burned, SPECK |
|---|---:|---:|
| `deploy` | 1 | 2 |
| `proveCapability` | 1 | 2 |
| `proveRolling1` | 1 | 2 |

Each transaction burned **2 SPECK (0.000000000000002 DUST)**; all three burned **6 SPECK**. The indexer reports the required fee, which was 1 SPECK each. The declared amount was independently decoded from each final transaction and matched the journal. A DUST spend burns its entire declaration, including overhead; see [Midnight fee semantics](https://docs.midnight.network/guides/manage-dust). These preprod measurements are not mainnet price estimates. The prepared 0.01 DUST per-transaction ceiling and 0.1 DUST shared daily ceiling remain unchanged.

## Reproduction and operational notes

The one-off scripts and logs are retained at `/home/deci/work/scratch-midnight-proof-preprod2-20261026/`. `rehearse.mts funds` synchronized the wallet and registered NIGHT. `rehearse.mts` then deployed and posted both proofs. `consumer/verify-fresh.mjs checkpoint` verified the trust-root walk; after copying the final network receipts, `consumer/verify-fresh.mjs` produced both verdicts. `fees.mjs` checked encoded declarations against the indexer's required fees. All execution used low scheduling priority and bounded Node heaps; the one-off scratch-script TDD exception applies. Production code is unchanged from the recorded source commit.

Fresh wallet replay exposed the SDK's 1 ms batch timeout: the 1,000-event limit alone produced mostly one- or two-event batches. This rehearsal supplied a 1,000 ms collection window through the pinned SDK while retaining the size bound, and saved validated progress periodically. A corrected probe confirmed identical serialized DUST state for 936 events grouped together versus two smaller batches. An earlier probe reused consumed WASM events; its state was discarded before the successful replay. Production defaults remain unchanged; follow-up [#199](https://github.com/Flux-Point-Studios/orynq-sdk/issues/199) owns the performance fix.

The submission process retained a background handle after its completion assertion and successful wallet close. A separate process reopened the journal and required all three landed records plus the saved-wallet-close event before stopping only that completed scratch process. The independent read-only verification then passed. No chain node or standing service was signalled.

The compiler reproduced all committed pins, the complete workspace built, and 30 public proof/finality plus 14 private release tests passed. Pipeline 211 passed all workflows on the unchanged implementation. The evidence follow-up requires its own approved green CI status before review; live status is on [PR #194](https://github.com/Flux-Point-Studios/orynq-sdk/pull/194). Prior native local-ledger evidence remains in [VALIDATION.md](VALIDATION.md) and the committed native fixtures.
