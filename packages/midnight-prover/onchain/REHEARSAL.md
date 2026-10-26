# Proof presentation rehearsal — 2026-10-26

Status: **local native ledger passed; PREPROD waiting for human faucet funding; MAINNET not attempted**.

The brief forbids reading `~/.secrets`. The W3 runbook places both funded preprod wallet seeds, their saved state and its Blockfrost credential there. None was read, and their current balances remain unknown. An authorized W3 signer outside that directory remains one route to completion. No standing service, node or container was modified.

Read-only requests to the public `https://rpc.preprod.midnight.network` succeeded on 2026-10-26: chain `Midnight Preprod`, genesis `df831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b`, runtime `midnight` spec `1000300`, transaction version `3`. Public chain reads are available and match the supported runtime.

A fresh preprod-only wallet was created with the existing key utility outside the forbidden directory, under `/home/deci/.local/state/codex-tasks/midnight-prover-onchain/preprod-wallet/`. Its directory is 0700 and its mnemonic is 0600; no secret was printed. Fund its **unshielded** address through `https://faucet.preprod.midnight.network/`:

`mn_addr_preprod1pju7t5t0lej86fyp6c63gyhy823e5zh2py4m4lkzpjhvf0sv4ylsrzw2pz`

The faucet's W3 runbook requires a human CAPTCHA, and this session has no browser surface available. Funding was requested from deci. The fresh wallet supplies signing access without relaxing the restriction. After funding, sync it, register its tNIGHT for tDUST using the existing wallet API, and perform the three-transaction rehearsal below. Do not delete this wallet as part of build cleanup.

The W3 unshielded addresses are:

- A: `mn_addr_preprod18hnkqxax2qyjrkm8ats9dkmr9vlwh0v6mvtfhtt4t5tvzq5t4l7sc2xpu6`
- B: `mn_addr_preprod1jyy8gesdrewxa9sz6ujm63wx4w390psjtce9ueq5ps3u3hy5077s2859zm`

Funding the W3 addresses alone does not resolve access to their existing signers; the fresh address above is the immediately usable alternative.

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

Use the private `proofReleaseOperator` with `network: 'preprod'`, an explicit supplied wallet and source, a task-specific journal and a one-hour expiry. Prepare/submit the three `PROOF_RELEASE_LABELS` sequentially. Its journal permits retries of the same bytes and requires the pinned deployment to land before either call. Record every transaction hash, landed height and block hash.

Install the packed updated anchors-midnight and midnight-prover packages in a new consumer directory. Use the public `verifyPosted` example in `ONCHAIN.md`, an independently authenticated preprod checkpoint and RPC-only source with the deployment and both call block hints. Record two `valid: true`, `assurance: 'consensus-verified'` results. Only then change the package status to preprod-rehearsed. Local replay and recorded registry finality tests cannot substitute for this check.
