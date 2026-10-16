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
| `wallet` | `openWallet` runs a `WalletFacade` (wallet-sdk-facade 4.1.0) over the network's indexer, refuses a mnemonic that does not derive the recorded addresses, pays fees from DUST only, and submits through the source's node. Every fee carries at least 1 SPECK of overhead (`DEFAULT_COST_PARAMETERS`; `openWallet` refuses less), so every fee is paid with a DUST spend: unpatched, wallet-sdk-dust-wallet 4.2.0 never finishes paying a fee it computes as 0 (its fee loop selects no DUST, round after round, until the ledger's wasm heap is exhausted), and with the workspace's patch (below) such a fee would be balanced with no DUST spend at all. `saveState()` writes the three sub-wallets' sync state to a new owner-only file of that save's own (named for its process and a random suffix) and renames it over the state file only once all three serialized and the whole file is written and flushed to disk; a write a full disk or a quota cuts short fails the save instead of installing a truncated file, and two processes saving one state file never install or remove each other's unfinished write. Opening the wallet removes the file of a save whose process died before renaming it. A save that fails returns `{ saved: false, failures }`, each failure naming the sub-wallet (or `file`) and its error, logs one line saying so, and leaves the last good save, which the next open restores before replaying the events since. `close()` saves a synced wallet's state first and returns that outcome. The DUST a fee spends is held until its bytes land or are ruled out. The node's refusal of the first delivery of bytes the wallet balanced frees exactly the coins they spent, and so does `discard` of bytes never handed to a node; those bytes are then never sent. A failure that is not the node's answer, or a refusal of bytes an earlier delivery may have left with a node, keeps the coins held until the bytes land or the ledger's grace period (three hours) ends. The wallet takes DUST coins largest first (`payingFees` in `fee-transacting.ts`; the measurements are in the patch section below), and its fee transactions are wallet-sdk-dust-wallet 4.2.0's with two changes (`feeTransacting`). A fee's DUST spend is dated at the newest DUST event the wallet applied, not at the indexer's newest block: the node checks the spend's proof against the DUST trees as they stood at that date, and on preprod a DUST event in the newest block that the wallet had not applied yet made the node refuse a fee (`Custom error: 170`, InvalidDustSpendProof). The node accepts the spend only in blocks up to that date plus the grace period, and the coin stays held until then, so a fee whose date is too old for the transaction's TTL plus the journal's margin (`TTL_MARGIN_MILLIS`, five minutes) is refused before anything is spent. And reverting a fee frees exactly the coins it spent: the SDK's own revert frees nothing once the wallet has applied a newer sync update or restarted, and frees too much otherwise. `payFee` balances only once the DUST sync has applied every event the indexer's last message announced, since with part of a block's events applied the wallet's DUST trees match no state the chain held; it waits up to two minutes, then fails with the sync's progress and pays nothing. `progress()` reports, for the shielded and DUST sync, the newest event the indexer announced. The facade's default pending-transactions service, which reverts bytes once their TTL passes by the local clock while the indexer does not list them, is not run. |
| `broadcast` | Sends the exact final bytes as the bare extrinsic `Midnight.send_mn_transaction` over JSON-RPC (`author_submitExtrinsic`), the same framing the verifier's strict inclusion check reads. `nodeRefusal(error)` gives the node's own JSON-RPC refusal (code, message, data) and is null for anything else, such as a transport failure, after which the bytes may still have been delivered. |
| `deployer` | `registryDeployer`: `prepare()` builds, proves, pays and binds a deploy and refuses it unless the final bytes deploy exactly the registry's initial state; `submit(prepared)` checks the bytes again, refusing any that do not deploy exactly the registry or do not hash to the confirmed transaction hash and address, then, once the journal has settled any earlier deploy from the chain, sends them through the write-ahead journal at most once per network and reads the address back from the landed transaction. An earlier deploy that never landed blocks new bytes until the chain, as the node confirms it, is past that deploy's TTL plus the journal's margin and, at the block whose time shows that, the node holds no contract at the address that deploy's bytes deploy. If the node holds the registry there, the deploy is landed and blocks new bytes for good, however far the indexer's lookup lags or whatever it reports. The journal itself keeps that rule, so it holds for every reconcile of the journal, including an operator's sharing its file, and it settles a row only from a chain view of the row's own network, so a deployer or operator of another network sharing the file never settles the deploy. `journalled()` settles the journal from the chain and returns the deploy it still holds, rebuilt from its journalled bytes, naming the wallet that paid it (`payer`, as the journal recorded it) and marked with how the journal holds it (`journal`: its state, how many broadcasts returned, and whether chain time is past its TTL), or null when none is live: a caller that lost its own record of a deploy, after a failure between the broadcast and the readback, submits that one, which the journal resumes (resending the same bytes only if no broadcast of them ever returned and chain time is known and not past their TTL), instead of preparing bytes the journal would refuse. Bytes past their TTL are never sent again: submit waits until the chain lands or retires them, and a resumed deploy the chain has retired is refused ("the journalled deploy expired without landing; rerun to prepare new bytes"). A deploy `journalled()` marked expired is waited for in the same way whatever chain time submit reads, and while the node lacks the indexer's newest block, so that chain time is unknown, submit refuses bytes no send of which returned, sending nothing. When another deployer's row reached the journal first, submit refuses and discards its own bytes at once, sending nothing: the journal hands that row back unsent, so its bytes never leave through this deployer's wallet, and submit never returns the other's deployment. |
| `submission` | `registryStateOnNode(source, address)` reads the node's best block through `contractStateOnNode`, returns null when no contract is there (however the node's version answers for one), and refuses a contract that is not the immutable registry. `submitJournalled` sends through the journal, which records the wallet's unshielded address as the payer, and returns the landed transaction with its block as the indexer lists it (`landedRow`, which waits for a journalled row without sending anything). Its first step, `journalOnce`, returns the key's live row as the journal answered; given the hash of the final bytes its caller holds, it hands back another attempt's row unsent. |
| `operator` | `registryOperator`: `anchor(entry)` (kind 1) and `anchorHiding(entry, attribute)` (kind 2, salt derived from a salt key so every opening is recoverable) under the FPS author key, through the journal; the final bytes must decode to exactly the intended anchor before they leave. |
| `preflight` | Chain identity (system_chain, genesis, runtime), the exact deploy summary (a deploy resumed from the journal says so first, with what confirming then does with its bytes), and the terminal-only confirmation `scripts/deploy-mainnet.ts` uses. |

## The wallet-sdk-dust-wallet patch

The workspace installs `@midnight-ntwrk/wallet-sdk-dust-wallet` 4.2.0 with midnight-wallet#741
("terminate computeBalancingRecipe instead of looping forever", merged as `aae483d`), applied to
the package's shipped `dist/v1/Transacting.js` and `.d.ts` as a pnpm patch
(`patches/@midnight-ntwrk__wallet-sdk-dust-wallet@4.2.0.patch`, `pnpm.patchedDependencies` in the
root `package.json`). The patch is the upstream build's own change: the diff between the
published 5.0.0 canaries built at `1583a02` and at `aae483d`, whose `Transacting.js` before the
change is 4.2.0's.

4.2.0 balances a fee in a loop that seeds every round after the first with the fee its last dry
run computed, which the balancer reads as a surplus: once the first round falls short, no round
selects anything again and the loop never ends (midnight-wallet#438, #700). The 1 SPECK overhead
removes only the trigger of a fee computed as 0. The other remains: first coins that cover the fee
of the transaction as it is but not that fee plus their own DUST spends. With coins taken largest
first, that is a wallet whose largest coin cannot pay a fee together with its own spend (a coin of
2.3e14 SPECK against a fee of 6.7e13 with no spend and 4.3e14 with one, at the simulator's
initial prices): unpatched 4.2.0 balanced one such coin, and two, past 50 dry runs without
ending. With #741 each round selects against the outstanding deficit, a round that selects
nothing fails, and a configured order that runs out of coins is retried once largest first, so
balancing ends with a fee paid or `InsufficientFundsError`. A transaction that
already covers its fee gets no balancing intent rather than one with empty `DustActions`, which
a node refused (#700). `test/fee-transacting.test.ts` balances both cases on the SDK's simulator,
each in a process of its own that is killed if its balancing does not return.

The wallet takes coins largest first (`largestFirst` through `payingFees`), not in the SDK's
default order, smallest first. Every DUST spend adds about 3.1e14 SPECK to a fee at the
simulator's initial prices, and smallest first spends every coin too small to pay alone before a
larger one, and again on each later fee once that coin has regenerated a little. Measured on the
SDK's simulator with the patch, five fees for an empty transaction, each landing before the next:
with one coin of 2.4e14 and one large coin, smallest first paid 7.4e14 to 7.5e14 per fee (two
spends) and largest first 4.3e14 (one); with coins of 2.4e14, 4.1e14, 7.1e14 and a large one,
smallest first paid 1.06e15 and then 1.38e15 to 1.41e15 per fee (three, then four spends), 6.6e15
in all against 2.2e15; with coins of 2.4e14, 4.1e14 and 1.9e15 it paid two fees of 1.06e15 and
ran out, where largest first paid four of 4.3e14. For a registry deploy the gap is smaller: 2.4e15
to 2.6e15 per fee against 2.7e15 to 2.9e15 with one small and one large coin. A fee cannot spend a
coin an earlier fee still holds until that fee's bytes land or are reverted, so fees balanced back
to back while earlier ones are in flight depend on how many coins can pay: on every wallet
measured (one to four coins, large and small) both orders paid the same number of such fees, one
per coin able to pay alone and the small coins together last, and largest first paid no more in
total (8.6e14 against 1.49e15 for the four-coin wallet). `test/fee-transacting.test.ts` checks
that a large coin pays alone and leaves a smaller one untouched.

The 1 SPECK overhead stays: with the patch it only puts a DUST spend on a fee that would otherwise
compute as 0, so the transaction still pays once the node prices it above 0, and it still guards
any install of 4.2.0 without the patch. Drop the patch once a stable wallet-sdk-dust-wallet release
contains `aae483d` (none does as of 2026-10-06: 4.2.0 is the newest stable, 5.0.0 is at rc.0) and
the package moves to it.

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
  resumed (expired once its TTL has passed) with the wallet that paid it, and sends nothing before
  the same token is typed again; declining it releases no DUST, since its bytes may already be with
  the node. The DUST floor applies only when confirming may send bytes, so a landed deploy whose
  readback failed is finished however little DUST the wallet holds. The gates do not stop a process running as deci
  that drops Claude Code's variables, drives a pseudo-terminal and types back the token it reads:
  the preflight suite does exactly that, once with inputs that do not exist, so it stops at its
  first read, and over an offline mainnet (`test/offline.ts` in place of the submit package),
  where it deploys, declines, resumes a deploy whose run failed after its broadcast, and refuses
  an expired one and journalled bytes that deploy anything but the registry, and where every way
  out, declined, refused or failed, closes the journal and the wallet before the process exits. The
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
