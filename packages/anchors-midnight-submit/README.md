# @fluxpointstudios/orynq-sdk-anchors-midnight-submit

Deploys the immutable `orynq-anchor-registry` on Midnight and writes anchors to it. The verify
side, the contract and the journal live in `@fluxpointstudios/orynq-sdk-anchors-midnight`; this
package holds everything that spends DUST or touches a key. It is private until the mainnet
registry exists.

## Pieces

| Module | What it does |
|---|---|
| `keys` | `createWalletMnemonicFile` writes a fresh 24-word mnemonic to a new 0600 file; `walletAddresses` derives the public addresses (HD account 0, index 0, Midnight's published test vector) and nothing else; `ensurePrivateDir` creates or accepts a 0700 directory. |
| `zk` | `keyMaterial(zkDir)` serves the registry circuits from the committed build (each file checked against `contract/HASHES.txt`) and the DUST spend circuit and k=13/14 parameters from `zkDir`, each checked against the sha256 midnight-ledger 8.1.3 pins. `provingService(zkDir)` proves with zkir-v2 in a worker thread of this process. Nothing is fetched. |
| `relay` | `credentialRelay(endpoints)`: the wallet SDK's indexer clients take a bare URL and echo it into errors, so a Blockfrost project id cannot ride in the URL. A loopback relay adds the credential header instead; its URLs carry only a random path prefix. |
| `wallet` | `openWallet` runs a `WalletFacade` (wallet-sdk 1.2.0) over the network's indexer, refuses a mnemonic that does not derive the recorded addresses, pays fees from DUST only, and submits through the source's node. |
| `broadcast` | Sends the exact final bytes as the bare extrinsic `Midnight.send_mn_transaction` over JSON-RPC (`author_submitExtrinsic`), the same framing the verifier's strict inclusion check reads. `nodeRefusal(error)` gives the node's own JSON-RPC refusal (code, message, data) and is null for anything else, such as a transport failure, after which the bytes may still have been delivered. |
| `deployer` | `registryDeployer`: `prepare()` builds, proves, pays and binds a deploy and refuses it unless the final bytes deploy exactly the registry's initial state; `submit(prepared)` checks the bytes again, refusing any that do not deploy exactly the registry or do not hash to the confirmed transaction hash and address, then, once the journal has settled any earlier deploy from the chain, sends them through the write-ahead journal at most once per network and reads the address back from the landed transaction. An earlier deploy that never landed blocks new bytes until the chain, as the node confirms it, is past that deploy's TTL plus the journal's margin and, at the block whose time shows that, the node holds no contract at the address that deploy's bytes deploy. If the node holds the registry there, the deploy is landed and blocks new bytes for good, however far the indexer's lookup lags or whatever it reports. The journal itself keeps that rule, so it holds for every reconcile of the journal, including an operator's sharing its file, and it settles a row only from a chain view of the row's own network, so a deployer or operator of another network sharing the file never settles the deploy. `journalled()` settles the journal from the chain and returns the deploy it still holds, rebuilt from its journalled bytes and marked with how the journal holds it (`journal`: its state and how many broadcasts returned), or null when none is live: a caller that lost its own record of a deploy, after a failure between the broadcast and the readback, submits that one, which the journal resumes (resending the same bytes only if no broadcast of them ever returned), instead of preparing bytes the journal would refuse. |
| `submission` | `registryStateOnNode(source, address)` reads `midnight_contractState`, returns null when no contract is there (the node answers with an empty string), and refuses a contract that is not the immutable registry. `submitJournalled` sends through the journal and returns the landed transaction with its block as the indexer lists it. |
| `operator` | `registryOperator`: `anchor(entry)` (kind 1) and `anchorHiding(entry, attribute)` (kind 2, salt derived from a salt key so every opening is recoverable) under the FPS author key, through the journal; the final bytes must decode to exactly the intended anchor before they leave. |
| `preflight` | Chain identity (system_chain, genesis, runtime), the exact deploy summary (a deploy resumed from the journal says so first, with what confirming then does with its bytes), and the terminal-only confirmation `scripts/deploy-mainnet.ts` uses. |

## Endpoints

`networkEndpoints(network, { blockfrostProjectIdFile })` chooses where a submitter reads and
writes: Blockfrost, on mainnet and preprod alike, with the project id read from an owner-only
file, and without one it refuses to start. Midnight retired its hosted mainnet endpoints on
2026-09-30, and its hosted preprod node's HTTPS JSON-RPC (`rpc.preprod.midnight.network`) answers
any request body over about 7 KB with HTTP 403, so it cannot take a registry deploy (about 8 KB of
final bytes, twice that as hex) or an anchor.

## Custody

Under deci's "ship now, harden after" decision these checks are accident guards. The key files'
owner and mode keep other users out; nothing in this package stops code running as deci, which
can read every key file and drive a terminal. The custody boundary is the planned separate-uid
or FIDO2 signer.

- The FPS author key is a 32-byte random secret in a 0600 file, never derived from a wallet seed.
  `registryOperator` takes its path; nothing accepts the key itself, and no environment variable
  carries it. On mainnet it refuses to load the key in a process that carries Claude Code's
  environment (`CLAUDECODE` or any `CLAUDE_CODE_*` variable), which stops an agent session that
  loads it as it is, not code that drops those variables.
- Off mainnet, the FPS mainnet keys are refused by identity and by place. `registryOperator`
  refuses an author key file holding the mainnet relay's author key (`MAINNET_AUTHOR_KEYS`) and a
  salt key file whose `saltKeyId` is the mainnet salt key's (`MAINNET_SALT_KEY_IDS`), wherever the
  file lives, so a copy or a hard link is refused like the original. It and `openWallet` refuse
  any author key, salt key or mnemonic path inside `~/.secrets/orynq-midnight-mainnet`, however
  the path reaches it (a symlinked directory, `..`), before opening it.
- `scripts/deploy-mainnet.ts` sends a mainnet deploy only after the token it prints (`DEPLOY` and
  the first 16 hex characters of the final bytes' transaction hash) is typed at an interactive
  terminal, in a process without Claude Code's environment. That stops an agent session running
  the script as it is, a pipe, a file, a flag or an environment variable, and bytes other than
  the ones summarized. A run that failed between the broadcast and the readback leaves the next
  run the journalled deploy (`journalled()`), never a second one: it shows that deploy, marked as
  resumed, and sends nothing before the same token is typed again; declining it releases no DUST,
  since its bytes may already be with the node. The gates do not stop a process running as deci
  that drops Claude Code's variables, drives a pseudo-terminal and types back the token it reads:
  the preflight suite does exactly that, once with inputs that do not exist, so it stops at its
  first read, and over an offline mainnet (`test/offline.ts` in place of the submit package),
  where it deploys, declines, and resumes a deploy whose run failed after its broadcast. The
  protection is procedural: deci runs the deploy himself, at his own terminal.

## Keys

```
node --import tsx scripts/keys.ts private-dir ~/.secrets/orynq-midnight-preprod
node --import tsx scripts/keys.ts new-wallet ~/.secrets/orynq-midnight-preprod/wallet-a.mnemonic preprod
node --import tsx scripts/keys.ts new-author ~/.secrets/orynq-midnight-preprod/author-relay.key
node --import tsx scripts/keys.ts new-salt ~/.secrets/orynq-midnight-preprod/salt.key
node --import tsx scripts/keys.ts addresses MNEMONIC_FILE mainnet --equals RECORD.json
```

Each prints only public derivations (addresses, an author key, a salt key id, a boolean).

## Tests

`MIDNIGHT_PP=<the ZK directory tools/compactc/install.sh filled> pnpm test` (Node 22.13 or later,
for `node:sqlite`). The operator and deployer suites run the real circuits through zkir's check
with the one recorded registry proof, so the bytes they judge decode and hash exactly as
submitted bytes do. `MIDNIGHT_PP=... nice -n 19 pnpm test:slow` proves a registry anchor for real
through `provingService`, in the wallet SDK's worker thread, in about half a minute.

## Preprod rehearsal

`rehearsal/` deploys the registry and writes anchors on Midnight preprod with test tokens,
verifies every anchor from a separate process with the packed verify package, and writes an
evidence pack only for what its gate establishes. Its offline tests run with `pnpm test`; the
runbook is `rehearsal/README.md`.
