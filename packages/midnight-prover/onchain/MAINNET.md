# Mainnet proof-contract release — 2026-10-27

The immutable proof-presentation contract was deployed on Midnight MAINNET, followed by one synthetic presentation per circuit. Both presentations passed independent fresh-consumer verification with `valid=true, assurance=consensus-verified`.

The canonical SDK export is `PROOF_DEPLOYMENTS.mainnet`. Address: `f44d99b014af2c21c3bb4db4ba727470c006181a3ede24074db1541a2c319cc5`.

| Item | Transaction hash | Block | Block hash |
|---|---|---:|---|
| deploy | `d6aa6a541a297128ad4560743f712c397a6027c677985500076839cef9aecdfb` | 3201845 | `8d88d873f85482cf2249d68809bb996fa3942e6cf42216c9630994ecec236779` |
| proveCapability | `2fed636b6a1970e54c5d655c2f881a41655c2e45996a00c390dea2389040507e` | 3201858 | `b288f597c92d1f91c89450b8d7807c1e16a7a621eca6dd9e42378373d42f810f` |
| proveRolling1 | `361d4bd540dd2775c224df95eb0e43ce151545f764a2b32f7de9861de40f1a17` | 3201886 | `6ac68218534567f737ef70c81a7a4756d71005bb97f9bf40749bd2f5c743f4f8` |

| Presentation | Authenticated timestamp (ms) | Presentation ID | Verdict |
|---|---:|---|---|
| proveCapability | 1793132106000 | `f581dfe0d666e7d60ddbf60c3fe042637717da867bbee84956ae5654619de07b` | `valid=true, assurance=consensus-verified` |
| proveRolling1 | 1793132274001 | `6959d93ecead4db315435d19104e93862c48c55c4b0961850d969f466f9241c5` | `valid=true, assurance=consensus-verified` |

Runner commit: [`b158969c6afd8e5cabdfeae1a39aeccfd8af0882`](https://github.com/Flux-Point-Studios/orynq-sdk/commit/b158969c6afd8e5cabdfeae1a39aeccfd8af0882), the [PR #194](https://github.com/Flux-Point-Studios/orynq-sdk/pull/194) merge. Intent `9ae07920` completed on attempt 1 with no refusals, three confirmations and state `done`. Each transaction declared and burned 2 SPECK (0.000000000000002 DUST), 6 SPECK total. Payer: `mn_addr1hdg7gg557cwmd9v67jv37z38zvprt7d46xqhk7c4a7hfask6jwrs7qesvq`.

Network genesis: `1941ca8e2bb88146c14dea084d3be7eb6e96ca7135429c543848b628124f2854`; runtime 1000300, reported ledger 8.1.1. Code hash: `bd518847ed1c6800d129bdac57a1d595a0912afd74406a07d7838ae1ab060361`. Initial-state SHA-256: `55041c6c05f64fb1cf3aa974aba8e27a83206506bc40a6d21c540d8d294f01b2`. Maintenance authority: empty committee, threshold 1, counter 0. The SDK dependency remains ledger-v8 8.1.3; the network's reported ledger version is separate.

The [machine-readable release record](mainnet-release.json) preserves the exact proved statements and deadlines, pins, fees, package checksums and verification results. The synthetic rolling anchor field claims no Cardano inclusion. These are historical relation proofs at their authenticated block times; current authorization also requires an unexpired deadline and the application checks described in [ONCHAIN.md](../ONCHAIN.md).

Independent verification installed tarballs packed from the runner commit into a new consumer with `npm install --ignore-scripts`; both imports resolved inside that consumer. Its trust root was the genesis above plus the one shipped mainnet checkpoint from `knownAuthors().checkpoints("mainnet")`. The [read RPC](https://midnight-proofs-a.fluxpointstudios.com/midnight/mainnet/rpc) supplied untrusted transport and hints only. Verification authenticated execution, timestamp, transaction inclusion and GRANDPA finality.

Provenance: the supplied release evidence bundle `proof-release-mainnet-20261027`, including `fresh-consumer-verify.mjs`, `fresh-consumer-verifyPosted.out`, its lockfile, `tarballs.sha256`, journal rows, audit lines and runner summary. Their SHA-256 digests are recorded in the JSON. This record cites the completed release; it does not request another deployment or presentation. The earlier [preprod rehearsal](REHEARSAL.md) remains available separately.
