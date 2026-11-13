# @fluxpointstudios/orynq-sdk-anchors-midnight-submit

Deploys the immutable `orynq-anchor-registry` on Midnight and writes anchors to it. The verify
side, the contract and the journal live in `@fluxpointstudios/orynq-sdk-anchors-midnight`; this
package holds everything that spends DUST or touches a key. It is private: it is not published
to npm.

## Pieces

| Module | What it does |
|---|---|
| `keys` | `createWalletMnemonicFile` writes a fresh 24-word mnemonic to a new 0600 file; `walletAddresses` derives the public addresses (HD account 0, index 0, Midnight's published test vector) and nothing else; `ensurePrivateDir` creates or accepts a 0700 directory. |
| `zk` | `keyMaterial(zkDir, ledger)` serves the registry circuits from the committed build (each file checked against `contract/HASHES.txt`), and the k=13/14 parameters and the ledger's DUST spend circuit from `zkDir`, each checked against its sha256 pin: ledger 8's spend as circuit generation 9 (`dust/9`, as midnight-ledger 8.1.3 pins it) and ledger 9's as generation 10 (`dust/10`, as ledger 9.1.0.0 pins it). `provingBackends(zkDir)` gives the wallet both ledgers' in-process provers, and `provingService(zkDir)` proves a transaction of either ledger with zkir-v2 2.2.0 in a worker thread of this process. Nothing is fetched. |
| `relay` | `credentialRelay(endpoints)`: the wallet SDK's indexer clients take a bare URL and echo it into errors, so a Blockfrost project id cannot ride in the URL. A loopback relay adds the credential header instead; its URLs carry only a random path prefix. |
| `wallet` | `openWallet` runs a wallet-sdk 2.0.0 `WalletFacade` (wallet-sdk-facade 5.0.0) over the network's indexer. It refuses a mnemonic that does not derive the recorded addresses, pays fees from DUST only, and submits through the source's node. Its sub-wallets follow `ProtocolVersion.V9NativeForkSchedule` (`MIDNIGHT_FORKS`): each one runs its ledger 8 variant below protocol version 2000000 and its ledger 9 variant from there. `payFee` refuses a transaction of another ledger than the one the wallet acts at, and pays nothing. **Connections:** every wallet connection goes through the credential relay. The SDK is given no `relayURL` and no `nodeClientConnection`, so it dials no node and runs no liveness probe of its own (`test/wallet-custody.test.ts` records the destination port of each TCP connection opened through `net.Socket`'s `connect`, only during the watched calls: while a wallet opens, syncs, pays a fee and submits it, and while a DUST wallet registers, balances, proves and submits on the SDK's simulator. It records destination ports only, not hosts, and does not watch worker threads, Unix sockets, DNS lookups or child processes. `test-slow/wallet-prove.test.ts` proves a ledger 9 call through the facade's own prover in this process). `openWallet` refuses an indexer whose genesis block is not the node's. Before each fee, `payFee` checks liveness itself, through the source's credentialed transport (`assertIndexerLive`). The indexer's head must be within 10 blocks of the node's finalized block. The two must also hold the same block at the lower of their heads: when the indexer is behind, the node's block at the indexer's head; when it is ahead, the indexer's block at the node's finalized head. Otherwise no fee is paid. **DUST custody:** the journal decides when DUST is freed. The facade's lifecycle service frees DUST on its own clock once a TTL passes or once it is told a transaction failed. It is replaced by `journalCustodyLifecycle`, which records nothing and frees nothing. The DUST a fee spends is therefore freed only when the node refuses the first delivery of the bytes, or when `discard` is called for bytes never handed to a node; those bytes are then never sent. In every other case the DUST is held until the bytes land or the ledger's grace period (three hours) ends. Every fee carries at least 1 SPECK of overhead (`DEFAULT_COST_PARAMETERS`; `openWallet` refuses less), so a fee computed as 0 still carries a DUST spend. **Coin order:** both variants take DUST coins largest first (`largestCoinFirst`), not in the SDK's default smallest-first order. The SDK dates a fee's DUST spend at a block whose DUST roots the wallet's trees hold, and refuses a spend whose date plus the grace period would not outlast the transaction's TTL. `payFee` balances only once the DUST sync has applied every event the indexer's last message announced; it waits up to two minutes, then fails with the sync's progress and pays nothing. **Sync:** the shielded and DUST wallets apply the indexer's events in groups of up to 1000, flushing partial groups after 1 ms, instead of the SDK's default of 10. **State file:** `saveState()` writes the three sub-wallets' state, tagged `orynq-midnight-wallet-state/wallet-sdk-2`, to a new owner-only file of that save's own (named for its process and a random suffix). It renames that file over the state file only once all three serialized and the whole file is written and flushed to disk. A save that fails returns `{ saved: false, failures }` and leaves the last good save in place. An open refuses a state file that a sub-wallet does not read back, naming the file, the sub-wallet and what the SDK said, never the state. A state file saved by wallet-sdk 1.x carries no format tag. On open it is moved aside to `<file>.wallet-sdk-1`, never over an earlier one, and the wallet syncs from genesis. The move waits while any journal named in `journals` holds a pending fee of this wallet (or one naming no payer) within its TTL plus the journal's margin: a sync from genesis would offer that fee's DUST again, and spending it twice is refused by the node. An open that names no journal leaves a 1.x file where it is. The mainnet scripts and the standing service share one wallet and state file, and each opens it with `MAINNET_WALLET_JOURNALS` (`src/mainnet-state.ts`): the deploy, anchors, proof-release and standing journals. A mainnet standing state root whose journal is not among them is refused, and so is a mainnet standing `wallet.state` other than that shared state file (`MAINNET_WALLET_STATE`). `close()` saves a synced wallet's state first and returns that outcome. `progress()` reports, for the shielded and DUST sync, the newest event the indexer announced. |
| `broadcast` | Sends the exact final bytes as the bare extrinsic `Midnight.send_mn_transaction` over JSON-RPC (`author_submitExtrinsic`), the same framing the verifier's strict inclusion check reads. `nodeRefusal(error)` gives the node's own JSON-RPC refusal (code, message, data) and is null for anything else, such as a transport failure, after which the bytes may still have been delivered. |
| `sync` | `syncWithCheckpoints(wallet, { timeoutMs, progressMs, checkpointMs, write })` waits for the wallet's sync. It writes `wallet sync at <time>, <seconds> s in: shielded applied <n> of <highest>, connected; unshielded ...; dust ...; not synced` (indices and flags only) as the wait starts, every `progressMs` and once synced, and saves the sync state every `checkpointMs`, once synced and once more when the wait times out or fails; that failure then says whether a rerun resumes from that save or from the last good one. A save reads the DUST state back, which holds the event loop for tens of seconds once that state runs to megabytes (2.5 MB on preprod), so saves are spaced to take at most a tenth of the wait. |
| `deployer` | `registryDeployer`: `prepare()` builds, proves, pays and binds a deploy and refuses it unless the final bytes deploy exactly the registry's initial state; `submit(prepared)` checks the bytes again, refusing any that do not deploy exactly the registry or do not hash to the confirmed transaction hash and address, then, once the journal has settled any earlier deploy from the chain, sends them through the write-ahead journal at most once per network and reads the address back from the landed transaction. An earlier deploy that never landed blocks new bytes until the chain, as the node confirms it, is past that deploy's TTL plus the journal's margin and, at the block whose time shows that, the node holds no contract at the address that deploy's bytes deploy. If the node holds the registry there, the deploy is landed and blocks new bytes for good, however far the indexer's lookup lags or whatever it reports. The journal itself keeps that rule, so it holds for every reconcile of the journal, including an operator's sharing its file, and it settles a row only from a chain view of the row's own network, so a deployer or operator of another network sharing the file never settles the deploy. `landedRegistryDeploy(network, deployJournal)` returns the registry deploy the journal at `deployJournal` holds landed, with the address read from its journalled bytes, or null (the journal is only read; where none is, none is created). `assertFpsRegistry(network, address, deployJournal)` refuses a registry that is not FPS's on the network: one `MIDNIGHT_REGISTRIES` pins, or that landed deploy's. `journalled()` settles the journal from the chain and returns the deploy it still holds, rebuilt from its journalled bytes, naming the wallet that paid it (`payer`, as the journal recorded it) and marked with how the journal holds it (`journal`: its state, how many broadcasts returned, and whether chain time is past its TTL), or null when none is live: a caller that lost its own record of a deploy, after a failure between the broadcast and the readback, submits that one, which the journal resumes (resending the same bytes only if no broadcast of them ever returned and chain time is known and not past their TTL), instead of preparing bytes the journal would refuse. Bytes past their TTL are never sent again: submit waits until the chain lands or retires them, and a resumed deploy the chain has retired is refused ("the journalled deploy expired without landing; rerun to prepare new bytes"). A deploy `journalled()` marked expired is waited for in the same way whatever chain time submit reads, and while the node lacks the indexer's newest block, so that chain time is unknown, submit refuses bytes no send of which returned, sending nothing. New bytes leave only while chain time is known and short of their TTL, however long the human took to confirm them: past it, or while it is unknown, submit discards them and sends nothing ("chain time passed the prepared deploy's TTL ... while it awaited confirmation"). When another deployer's row reached the journal first, submit refuses and discards its own bytes at once, sending nothing: the journal hands that row back unsent, so its bytes never leave through this deployer's wallet, and submit never returns the other's deployment. |
| `submission` | `registryStateOnNode(source, address)` reads the node's best block through `contractStateOnNode`, returns null when no contract is there (however the node's version answers for one), and refuses a contract that is not the immutable registry. `submitJournalled` sends through the journal, which records the wallet's unshielded address as the payer, and returns the landed transaction with its block as the indexer lists it (`landedRow`, which waits for a journalled row without sending anything). Its first step, `journalOnce`, returns the key's live row as the journal answered; given the hash of the final bytes its caller holds, it hands back another attempt's row unsent. `confirmedSends(journalling, key, ...)` is the deployer's and the operator's send of bytes a human confirmed: `held()` settles the journal and returns the key's live attempt marked expired once chain time is past its TTL, and `submit(prepared)` sends at most once under the key, as the `deployer` row describes for a deploy. |
| `operator` | `registryOperator`: `anchor(entry)` (kind 1) and `anchorHiding(entry, attribute)` (kind 2, salt derived from a salt key, read once when the operator is made, so every opening is recoverable) under the FPS author key, through the journal; the final bytes must decode to exactly the intended anchor before they leave. The same anchors in two steps, so a human confirms their exact bytes: `prepare(request)` builds, proves, pays and binds them and sends nothing; `journalled(request)` returns the attempt the journal still holds for that anchor, rebuilt from its bytes and marked as the journal holds it, or null; `submit(prepared)` refuses bytes that do not carry exactly the confirmed anchor or do not hash to the confirmed transaction, then sends them through `confirmedSends`, so an anchor is sent at most once, a journalled attempt resumes, bytes past their TTL are never sent again, and another attempt's bytes are discarded unsent; `relocate(prepared)` settles a confirmed anchor afresh once the node's finalized chain holds another block where its journal row places it, and returns it as `submit` does: where it landed since, or refused as expired once the chain carried it past its TTL unseen; `discard(prepared)` releases the DUST of bytes nobody confirmed. |
| `anchor-plan` | `readAnchorPlan(path)` reads the plan `scripts/anchor-mainnet.ts` takes, the anchors it writes: `{ "registry": "<64 hex>", "entries": [{ "label", "kind": 1 or 2, "rootHash", "manifestHash", "merkleRoot"?, "attribute" (kind 2 only) }] }`, hashes as 64 hex characters, optionally prefixed `sha256:` or `0x`. It refuses unknown fields, a kind the registry does not write, an attribute on kind 1 or none on kind 2, a hash that is not 32 bytes, a label a terminal could misprint (1 to 64 of letters, digits, `.`, `_`, `-`), and a label or an anchor that repeats. |
| `preflight` | `parseDust` and `formatDust` (DUST text to SPECK and back), chain identity (system_chain, genesis, runtime), the exact deploy and anchor summaries (bytes resumed from the journal say so first, with what confirming then does with them; an anchor shows its label, kind, registry, commitment, kind 2's attribute, author key and transaction, never what opens a kind-2 commitment), the token that names the bytes' transaction hash (`DEPLOY` or `ANCHOR` and its first 16 hex characters), and the terminal-only gate and confirmation the mainnet scripts use (`assertHumanTerminal`, `confirmOnTerminal`). |

## Fees on ledger 9

Fees are paid by wallet-sdk-dust-wallet 5.0.0 as the SDK ships it: no patch, and no fee
transacting of this package's own. On the SDK's ledger 9 simulator, `test/dust-fees.test.ts` checks
that reverting a fee that never landed frees exactly the coin it spent, even after the wallet
applied a newer block or restarted, and never frees a coin that an earlier, still-in-flight fee
spends. It also checks that a large coin pays a fee alone and leaves a smaller one untouched,
where the SDK's default order would spend the small coin first.

Every DUST spend adds to a fee, so coins are taken largest first. Measured on wallet-sdk 1.x's
simulator at its initial prices, smallest first spent every coin too small to pay alone before a
larger one, and did so again on each later fee once that coin had regenerated a little: 1.7 to 3.3
times the fee, without paying more fees back to back.

`test/fixtures/mainnet-ledger9-prices.json` records mainnet's ledger 9 parameters at block
3,350,170 (runtime 2001100, ledger 9.1.0.1). They were read from the public node through the
read-only `MidnightRuntimeApi_get_ledger_parameters` runtime API, together with the request, the
header and the SHA-256 of the serialized parameters. At those prices a real registry `anchor()`
call is balanced with one DUST spend, passes ledger 9's time-to-dismiss check, and is accepted by
the simulator. Its fee is about 0.15 DUST before its own DUST spend and about 0.23 DUST with it.
Under ledger 8, mainnet charged the same call 2 SPECK (`test/fixtures/mainnet-ledger-prices.json`,
block 3,186,875). One anchor therefore costs more than the standing service's approved caps,
0.01 DUST a transaction and 0.1 DUST a day (`runner/limits.json`), and the service holds every
batch on its fee cap until the caps are raised. These are node-reported parameters, pinned to the
observed header rather than authenticated with a new consensus proof, and fees change with block
activity. The simulator mock-proves and erases proofs, so this measures fees and ledger acceptance
only. It makes no claim of a live broadcast or a new mainnet measurement.

Historical sync review measurements under load observed event-loop stalls up to 5.5 seconds for a full DUST group and 5.2–6.9 seconds for a full shielded group. These are measurements from the reviewed SDK path, not latency bounds or guarantees. The 1000 setting is a maximum group size; a partial group flushes after 1 ms.

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
  carries it. On mainnet it refuses to load the key in a process that carries Claude Code or Codex
  environment (`CLAUDECODE`, any `CLAUDE_CODE_*`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`,
  `CODEX_CI`, or any `CODEX_MANAGED_BY_*`, including empty values), which stops an agent session that
  loads it as it is, not code that drops those variables.
- On mainnet, `registryOperator` writes under the FPS mainnet keys and no others: it refuses an
  author key file whose key is not in `MAINNET_AUTHOR_KEYS` and a salt key file whose `saltKeyId`
  is not in `MAINNET_SALT_KEY_IDS` as it loads them, when it is made, before anything is prepared,
  so a wrong key file never authors an FPS anchor.
- Off mainnet, the FPS mainnet keys are refused by identity and by place. `registryOperator`
  refuses an author key file holding the mainnet relay's author key (`MAINNET_AUTHOR_KEYS`) and a
  salt key file whose `saltKeyId` is the mainnet salt key's (`MAINNET_SALT_KEY_IDS`), wherever the
  file lives, so a copy or a hard link is refused like the original. It and `openWallet` refuse
  any author key, salt key or mnemonic path inside `~/.secrets/orynq-midnight-mainnet`, however
  the path reaches it (a symlinked directory, `..`), before opening it.
- `scripts/deploy-mainnet.ts` sends a mainnet deploy only after the token it prints (`DEPLOY` and
  the first 16 hex characters of the final bytes' transaction hash) is typed at an interactive
  terminal, in a process without Claude Code or Codex environment. That stops an agent session running
  the script as it is, a pipe, a file, a flag or an environment variable, and bytes other than
  the ones summarized. A run that failed between the broadcast and the readback leaves the next
  run the journalled deploy (`journalled()`), never a second one: it shows that deploy, marked as
  resumed (expired once its TTL has passed) with the wallet that paid it, and sends nothing before
  the same token is typed again; declining it releases no DUST, since its bytes may already be with
  the node. The DUST floor applies before preparing new bytes. Journalled deploys and anchors
  already carry their fee, so resuming them does not require a second balance of available DUST,
  including when no broadcast returned. A floor refusal explains that held coins become available
  after wallet sync passes the spend's ctime plus the ledger DUST grace period (3 hours on mainnet),
  if still unspent. The gates do not stop a process running as deci
  that drops the agent variables, drives a pseudo-terminal and types back the token it reads:
  the preflight suite does exactly that, once with inputs that do not exist, so it stops at its
  first read, and over an offline mainnet (`test/offline.ts` in place of the submit package),
  where it deploys, declines, resumes a deploy whose run failed after its broadcast, and refuses
  an expired one and journalled bytes that deploy anything but the registry, and where every way
  out, declined, refused or failed, closes the journal and the wallet before the process exits; a
  wallet that fails to close is reported after the run's own failure, never in its place. The
  protection is procedural: deci runs the deploy himself, at his own terminal, or, since
  2026-10-20, approves its exact intent in chat and the runner (`runner/`) runs it under hard
  limits.
- `scripts/anchor-mainnet.ts` writes a plan's anchors behind the same gates, through the same code
  (`scripts/mainnet-session.ts`): it refuses a Claude Code or Codex environment and a pipe before reading
  anything, an unknown flag, a flag given twice or followed by another flag instead of its value,
  and a plan with any field it does not define before reading the chain.
  It writes only to FPS's registry (`assertFpsRegistry`): one `MIDNIGHT_REGISTRIES` pins, or the
  one whose deploy deploy-mainnet's journal (`--deploy-journal`, by default deploy-mainnet's own)
  holds landed, read from the journalled bytes; the same immutable registry deployed by anyone else
  is refused before the chain is read, and a registry address where the node does not hold exactly
  the immutable registry before opening the wallet or loading a key. Each anchor is sent only
  after `ANCHOR` and the first 16 hex characters of its final bytes' transaction hash are typed,
  resumes from the journal like a deploy (never sent twice, never sent past its TTL, however long
  the prompt waited), and is recorded only once the node shows its block final and carrying
  exactly those bytes. That block is the one the node's finalized chain holds at the anchor's
  height, never only the one the journal cached: where that chain holds another block, a reorg
  orphaned the cached one, and the journal settles the anchor afresh from the chain, into the
  block it landed in since or, once the chain carried it past its TTL unseen, out of the journal,
  so a rerun anchors new bytes. Each anchor is added to the results file as the file stands then,
  so a row another run recorded meanwhile is kept. A label already recorded with the same
  transaction is not appended again; a different transaction for that label is refused.
  Kind-1 summaries show normalized root, manifest and Merkle hashes; kind 2 keeps its opening
  private. Plan, results and wallet-record JSON errors never include file contents.
  The results file holds public data only; nothing that opens a kind-2 commitment is printed or written. The preflight suite drives it over the offline mainnet
  too: kind 1 and kind 2 anchors, a decline, a token typed after the bytes' TTL, a resume after a
  failure between the broadcast and the readback, a block not final in time, a block that does not
  carry the bytes or whose body the node lacks, an indexer placing the anchor in a block the node
  did not finalize, an orphaned block whose anchor landed again elsewhere or never, an expired
  attempt, a registry that is not FPS's, not the immutable one or no contract at all, an author or
  salt key that is not an FPS mainnet key, an unknown plan field, and every way out closing the
  journal and the wallet.

## Mainnet proof runbook

deci runs both commands himself, in his OWN terminal on Gemtek, never through Claude Code's `!`
prefix or any agent session: the scripts refuse a process that carries Claude Code or Codex environment.
Both read the FPS mainnet keys from their default paths (`~/.secrets/orynq-midnight-mainnet`), the
Blockfrost project id from `~/.secrets/blockfrost-midnight-mainnet.project_id`, the recorded wallet
from `~/work/orynq-midnight-mainnet-wallet.json` and the ZK material from
`~/.cache/orynq-midnight/zk`. Both run from this package's directory
(`packages/anchors-midnight-submit`). Once, before the first command, at the checkout's root:
`pnpm install --frozen-lockfile --filter @fluxpointstudios/orynq-sdk-anchors-midnight-submit...`
and `pnpm --filter "@fluxpointstudios/orynq-sdk-anchors-midnight-submit^..." build`.

1. Deploy the registry:

   ```
   node --import tsx scripts/deploy-mainnet.ts
   ```

   It prints the chain (`Midnight Mainnet, runtime 1000300, ledger ...`), syncs the deploy wallet
   (it refuses a mnemonic that does not derive the recorded addresses, and a wallet under 20 DUST),
   prints the deploy summary (contract address, deploy transaction hash, the two verifier keys'
   sha256, `committee [] (0 members), threshold 1, counter 0`, the fee) and asks:
   `Type exactly "DEPLOY <16 hex>" to confirm these bytes for mainnet`. Type that token to send;
   anything else sends nothing. It ends with `deployed and read back from the node: {...}`, whose
   `address` is the registry. A run that fails after its broadcast is finished by running the same
   command again: it shows the journalled deploy and asks for the same token.

   The wallet syncs from `~/.local/state/orynq-midnight/mainnet-wallet.state.json` (owner-only, in
   a directory only deci can enter; `--wallet-state` names another), which both commands share.
   The sync prints a `wallet sync at ...` line as it starts and every minute, and saves the state
   every five minutes (less often when a save takes over half a minute), once synced, and once
   more when it fails or has not finished within three hours. Running the command again then
   resumes from that save instead of from genesis.

2. Put that `address` into the plan as `"registry"`, then write the anchors:

   ```
   node --import tsx scripts/anchor-mainnet.ts --plan ~/orynq-midnight-mainnet-plan.json
   ```

   The plan is written beforehand with the entries FPS anchors first, in order (see `anchor-plan`
   above); only its `registry` comes from step 1. For example:

   ```json
   { "registry": "<address from step 1>",
     "entries": [
       { "label": "git-head", "kind": 1, "rootHash": "sha256:...", "manifestHash": "sha256:...", "merkleRoot": "sha256:..." },
       { "label": "model-manifest", "kind": 2, "rootHash": "...", "manifestHash": "...", "merkleRoot": "...", "attribute": "..." } ] }
   ```

   It refuses a `registry` other than the one whose deploy step 1 journalled as landed, then
   checks the chain and that the registry on the node is exactly the immutable one, syncs the
   same wallet, then for each entry prints its summary (label, kind, registry, commitment, the
   attribute for kind 2, the FPS author key, the anchor transaction hash, the fee) and asks:
   `Type exactly "ANCHOR <16 hex>" to confirm these bytes for mainnet`. After each confirmed anchor
   it waits until the node shows its block final and carrying exactly those bytes, then records it.
   Anything but the token stops the run with nothing sent; running the same command again skips
   what is recorded and resumes what the journal holds, asking for each token again.

3. Send back `~/.local/state/orynq-midnight/mainnet-anchors.json` (label, kind, transaction hash,
   block, block hash, commitment, kind 2's attribute, registry, author key: public data only) and
   the `deployed and read back from the node` line from step 1. Every anchor in it is then verified
   from a separate process with `verifyMidnightAnchor`.

## Unattended mainnet runs

`runner/` runs the deploy and the anchors without anyone at a terminal once deci has approved
the exact intent in chat: systemd user units start it, it runs these same scripts in a
pseudo-terminal, and it types each token only when the summary matches the approved intent and
the hard limits in `runner/limits.json` hold (allowlisted actions, a per-transaction fee cap, a
daily DUST cap, a 24-hour single-use approval). `runner/README.md` has its threat model, approval
files, units and install.

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
through `provingService`, in the wallet SDK's worker thread, in about half a minute. `pnpm test`
also runs the runner's suite (`runner/test`), which drives these scripts over the offline mainnet.

## Preprod rehearsal

`rehearsal/` deploys the registry and writes anchors on Midnight preprod with test tokens,
verifies every anchor from a separate process with the packed verify package, and writes an
evidence pack only for what its gate establishes. Its offline tests run with `pnpm test`; the
runbook is `rehearsal/README.md`.

Batch plans use kind3 with `materiosGenesis` and1–1,024 strictly ascending `batches`, each containing `anchorId`, `rootHash` and `manifestHash`. Every member ID must derive from its root and manifest; the plan label must equal the batch-set commitment. A homogeneous kind3 mainnet plan selects the batch role and does not load a salt key. Plans mixing batch and relay entries are refused before wallet synchronization.

`registryOperator({authorRole: "batch", ...})` prepares/submits kind3 through the existing write-ahead journal and exact-byte checks. The default relay role permits kinds1/2. Mainnet batch public-key pins are initially empty, so this writer cannot send a batch there until a reviewed key is pinned. Retired author identities cannot write on any network. Existing agent and secret-path gates remain in force. Legacy per-intent runner approvals refuse batch plans; standing admission is a separate integration.

The operator binds each network/author public key to one canonical journal in the OS account's
owner-only `~/.orynq-midnight-journals` namespace (OS account home, independent of `HOME`).
Copied key files and different wallets must reuse that journal. A missing or replaced bound
journal is refused. The typed `bindingRoot` option is for a custom signer custody namespace or
isolated tests; production CLIs expose no flag or environment override. Binding metadata is
flushed before an operation can send. Same-UID code can deliberately edit this local custody
state; an independent signer is required to exclude that accepted ship-now threat boundary.

Node inclusion remains internal evidence. Every operator completion, including direct
`anchor`, `anchorHiding`, `anchorBatch`, confirmed `submit`, and `relocate`, requires a full
`valid`, `consensus-verified`, known signed-author report matching the exact call and canonical
block. A verification outage retains the landed journal row, so retries verify the same attempt.
Custom verifier integrations return a typed full report and pass the same field checks. The
accepted report is returned as `receipt.verification` and reused before CLI result recording.

Result updates use a persistent owner-only lock inode and Linux `/usr/bin/flock`; the kernel
releases the descriptor lock after a crashed writer. No stale-PID check deletes a lock file.
Do not remove these lock files while writers are running.

The configured node must answer the root and contract-state batch from one coherent backend;
a load balancer must keep that batch on one backend. A validated ledger root is required
before a missing-contract response can retire a deploy. These node observations do not replace
the separate consensus-verification gate before reporting anchor success.
