# Proof presentation rehearsal — 2026-10-26

Status: **local native ledger passed; PREPROD faucet payment located; wallet sync and deployment awaiting authorized indexer access; MAINNET not attempted**.

The brief forbids reading `~/.secrets`. None was read. The fresh preprod wallet is retained outside that directory. No standing service, node or container was modified.

Read-only requests to the public `https://rpc.preprod.midnight.network` succeeded on 2026-10-26: chain `Midnight Preprod`, genesis `df831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b`, runtime `midnight` spec `1000300`, transaction version `3`. Public chain reads are available and match the supported runtime.

A fresh preprod-only wallet was created with the existing key utility outside the forbidden directory, under `/home/deci/.local/state/codex-tasks/midnight-prover-onchain/preprod-wallet/`. Its directory is 0700 and its mnemonic is 0600; no secret was printed. Its **unshielded** address is:

`mn_addr_preprod1pju7t5t0lej86fyp6c63gyhy823e5zh2py4m4lkzpjhvf0sv4ylsrzw2pz`

deci completed the faucet on 2026-10-26. A bounded scan of the public preprod RPC located the payment, and ledger-8 decoding found a native-token output of **5,000,000,000 STAR (5,000 tNIGHT)** owned by this exact address:

| Funding field | Value |
|---|---|
| Faucet intent identifier | `00e16532647cbcc331c19697c9cdd8eaeb1bfe03eabb8843cfba30f80f06668f99` |
| Final transaction hash | `bdba9f29be53f71572fb12c4620d6fd6d43d1df41f22c2554a14fd4f45473164` |
| Block height | `3150901` |
| Block hash | `9b8bbba8a68ef0fd4f6babc57d0ee8547962d10c89447fbd17c598a1435ccafa` |

The faucet identifier belongs to the final transaction's `identifiers()` set; it is not its `transactionHash()`. The payment's block and output are located from chain bytes, without relying on the retired indexer. This is funding evidence, not proof-contract deployment evidence.

The remaining prerequisite is an authorized indexer. The hosted preprod GraphQL endpoint returned **HTTP 410** and the replacement Blockfrost endpoint returned **HTTP 403** without authentication. Midnight's [environment reference](https://docs.midnight.network/relnotes/network) documents the preprod indexer retirement. No Blockfrost credential is present in the task environment or at the requested allowed path, `/home/deci/.local/state/codex-tasks/midnight-prover-preprod/blockfrost.project_id`. Supply a preprod token there with mode 0600, or an authorized compatible indexer/RPC endpoint. Do not paste a token into a transcript. The existing wallet API then syncs, registers NIGHT for DUST, and pays the rehearsal fees. Retain the wallet through build cleanup.

A checkpoint refresh started from the committed preprod fixture's set 9497 at block 2834399. Successful intermediate checks reached set 10250 after block 3058673. The retired RPC then returned HTTP 403 to historical header reads, including a six-header batch with a 547-byte method/parameter payload. Increasing aggregate response budgets and reducing batches did not complete the walk. No consensus-verified faucet result or proof-contract finality result is claimed. Resume with an authorized supported RPC; the retained checkpoint progress records only completed verifications.

## Local evidence

`tests/onchain.integration.ts --record` generated fresh proofs with compactc 0.31.1's pinned proving keys and local parameters. Each native verifier response was `{"valid":true,"code":"verified"}`. It applied the deployment and both calls to one local ledger; both calls were prepared against the original empty map. The resulting map retained both records. Native Rust replay independently verifies the proofs and reproduces exactly the JavaScript ledger's final state.

| Local artifact | Transaction hash |
|---|---|
| Immutable deploy | `2845b663e357167ce086b8dbc63298ed13395488890f7acff8c0efe051a03659` |
| Capability | `d2bbca3011040a669b32ae16be1423471a35d62c2d0cc89834c50b7d61dd6b6a` |
| Rolling step | `6ae8886910240867c28a522254089240ae4a2ed4e7c1569176aff8e9cba97f10` |

Local address: `84ee1eb21cb7012790de18a23d4d3a3a548ccb565297a4a41d1aa26d7ba3f997`. Block-context timestamp: `1793033506`; proved deadline: `1793037006`. These are **unfunded local transactions**, with balancing enforcement disabled only in the test. They have no network block height, network inclusion or GRANDPA verdict. The committed fixtures live in `native/tests/fixtures/onchain/`; all witnesses are synthetic. The expired-deadline test extends the outer TTL, then proves that the native ledger still refuses each call at the circuit's original deadline.

## Fresh npm consumer check

The updated anchors-midnight and midnight-prover tarballs were installed with `npm install --ignore-scripts --no-audit --no-fund` in a new directory outside the checkout. Both imports resolved inside that directory's own `node_modules`. Both local proof transcripts and the pinned deployment decoded successfully from the installed packages, without a native executable.

The installed generic verifier also replayed the existing recorded registry RPC fixture: transaction `e273d480e57b3315937c8929fbc3c11ab798d42b4ff6c0b88172856dec6b7d58`, block **3113832**, hash `18e31c819837ede6ed536fcd85a8d8f29af6affd87d642793ef9bcbe50ea1008`, with GRANDPA finality and successful execution authenticated. `verifyPosted` rejected that unrelated registry transaction as the new proof contract's deployment. This checks package completeness and the shared finality primitive; it is not a preprod proof-presentation receipt.

The same fresh consumer then verified that existing transaction through the **live** public read-RPC at `https://midnight-proofs-a.fluxpointstudios.com/midnight/mainnet/rpc`, retaining the independently trusted checkpoint from the fixture. Result: GRANDPA finality and successful execution verified, same block height/hash, **4 HTTP requests / 6 RPC subcalls**. The probe was read-only, bounded to 32 HTTP requests, 96 subcalls and 60 seconds, and used no credential. It did not submit any transaction.

## Completion criteria for preprod

Use the private `proofReleaseOperator` with `network: 'preprod'`, an explicit supplied wallet and source, a task-specific journal and a one-hour expiry. Deploy through that operator, then generate each call through the public SDK `post` function. Its supplied wallet journals the final bytes through the release operator before broadcasting them. The journal permits retries of the same bytes and requires the pinned deployment to land before either call. Record every transaction hash, landed height and block hash.

Install the packed updated anchors-midnight and midnight-prover packages in a new consumer directory. Use the public `verifyPosted` example in `ONCHAIN.md`, an independently authenticated preprod checkpoint and RPC-only source with the deployment and both call block hints. Record two `valid: true`, `assurance: 'consensus-verified'` results. Only then change the package status to preprod-rehearsed. Local replay and recorded registry finality tests cannot substitute for this check.
