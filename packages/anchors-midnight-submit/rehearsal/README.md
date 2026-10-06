# Preprod rehearsal

The rehearsal runs this package against Midnight preprod with test tokens, and never touches
mainnet: it deploys the registry, writes kind-1 and kind-2 anchors, lands two anchors from two
wallets in one block, has the node refuse three maintenance updates, kills the submitter around
a broadcast, and rotates and revokes an author key. A separate process then verifies every
anchor with the packed verify package, and the evidence gate (`gate.mjs`) decides what the
evidence pack may claim.

It lives here, not under `scripts/`, because it drives this package's own API
(`registryDeployer`, `registryOperator`, `openWallet`, `nodeRefusal`) from `../src`, so a change
to the submitter and to the rehearsal that proves it land in one diff. Its offline tests need
Node 24 for `node:sqlite`, and the Woodpecker `midnight-submit` step already runs on Node 24
with this package's dependencies installed; the repository-wide suite runs on Node 20. The
package publishes only `dist`, so nothing here ships.

## Files

| File | Role |
|---|---|
| `bundles.ts` | Traces the real, read-only processes whose bundles the anchors commit to (`bundles/`, git-ignored), each same-block round's pair included. |
| `endpoints.ts` | Where `run.ts` and `crash.ts` read and write: every broadcast and every read through Blockfrost preprod, the path a mainnet submitter takes, and the wallets' sync alone through Midnight's hosted indexer, whose event ids their saved state names. |
| `run.ts` | The phases `chain funding deploy kind1 kind2 sameblock negatives rotation`. Records everything public in `evidence/raw.json` (git-ignored). `funding` records each wallet's first funding once and waits, every run, until each wallet can spend DUST. `deploy` resumes the deploy its journal still holds (`registryDeployer.journalled`) instead of preparing another, and saves the landing before it reads the wallet's balance. A node negative counts as refused only on the node's own JSON-RPC answer (`nodeRefusal`), and a recorded case is never sent again. |
| `crash.ts` | One crash-window step per process: `kill-before`, `kill-after` (SIGKILL) and `recover`. |
| `docs.ts` | Signs the drill's KNOWN_AUTHORS documents with a preprod-only trust root through `anchors-midnight/scripts/known-authors.ts`. |
| `rehearse.sh` | All of the above in order, at nice 19; the crash drill runs once. |
| `verify-all.mjs` | Verifies every recorded anchor, the rotation matrix, twelve verifier negatives and the absence of every refused maintenance transaction through Blockfrost, and opens the forged KNOWN_AUTHORS documents, from a consumer directory into which npm installed the packed verify package. It exits 1 on any gate failure. |
| `gate.mjs` | The claims the pack may make, from what was recorded and what the verifier returned. Each maintenance update counts as refused only on the node's answer 1010 Invalid Transaction with the maintenance authority's own custom code, and each forged document only on the verify package's answer from the check it targets (below). The deploy the pack describes must be the one that landed: a prepared record whose transaction hash or address differs, such as a prepare a later run abandoned, fails the gate. |
| `compose.ts` | Writes the pack only when the gate passes, every journal's landed transactions match the recorded anchors, every kind-2 opening recomputes the commitment the verifier read, and the privacy scan finds no window of any secret. |
| `finish.sh` | `verify-all.mjs` from `$CONSUMER`, then `compose.ts`. |
| `record-golden.ts` | Records the verifier's reads of three real anchors as a fixture the anchors-midnight suite can replay. |
| `wallets.json` | The public addresses of preprod wallets A and B. `openWallet` refuses a mnemonic that derives anything else. |

## The node's refusals

The registry's maintenance authority has no committee and threshold 1, so midnight-node's ledger
refuses each update with its own custom code, which Substrate's author RPC reports as error 1010
Invalid Transaction with data `Custom error: N`:

| Case (`run.ts`) | The only refusal that counts |
|---|---|
| `ReplaceAuthority, unsigned` | `Custom error: 136` (ThresholdMissed) |
| `VerifierKeyRemove(anchor), signed by a stranger at index 0` | `Custom error: 134` (KeyNotInCommittee) |
| `VerifierKeyInsert(rewrite), signed by a stranger at index 0` | `Custom error: 134` (KeyNotInCommittee) |

Any other answer fails the gate, 1010 included: `Custom error: 110` (VerifierKeyNotSet), `138`
(BalanceCheckOverspend) and `170` (InvalidDustSpendProof) come from other guards, `196`
(DustDoubleSpend) from the application stage, which runs only after the authority check has
passed, and `Transaction is outdated` marks a stale transaction. `run.ts` builds exactly the cases `gate.mjs` names, which the
type check enforces, and the pack prints each code with its name.

A positive control is planned for the preprod run and has not run. Deploy a control contract, the
registry's initial state with threshold 0 instead of 1, through a deploy path of its own (since
`registryDeployer` builds only the registry), then send it the same three updates unsigned, each
with the counter the previous one left. The node should accept and land all three, which shows the
construction, the fee payment and the framing reach the authority check, so the registry's
refusals come from its authority alone. It costs one deploy and three updates in DUST, and the
gate does not require it yet.

## Forged KNOWN_AUTHORS documents

The verify package refuses each failed check on a signed document with its own message:
`the known-authors document carries no signature by a trust root` when no signature names a
trust root, `... signature by a trust root is not 64 bytes of lowercase hex` when every
trust-root signature is malformed, and `... signature by a trust root does not verify` only
after Ed25519 verification failed for every well-formed trust-root signature. `verify-all.mjs`
opens four documents that `gate.mjs` (`forgeKnownAuthors`) builds from serial 3 with every author
window reopened:

| Document | The only answer that counts |
|---|---|
| under the trust root's signature on serial 3 | `does not verify` |
| signed by a fresh stranger key, under the trust root's key | `does not verify` |
| signed by the stranger, under the stranger's key | `carries no signature by a trust root` |
| positive control: the same, with the stranger as trust root | opened |

The control shows the reopened document is well-formed, so the first two fail at the signature
alone. `test/forgeries.test.ts` opens all four with the package's own source, with Ed25519
verification on and, through a mock, skipped: skipped, the first two open. A stranger's key
beside the root's real signature tests nothing of the kind: the allow-list refuses it whether or
not signatures are verified, so the gate never counts that answer for a forgery under the trust
root's key.

## What each statement rests on

`compose.ts` builds every statement from the gate's facts, after its own opening check, and
`test/compose.test.ts` asserts the honest pack's statements word for word. A fact the rehearsal
recorded (`raw.json`, the crash log, the journals) is the writer's own record; a fact from
`verified.json` comes from the packed verify package reading through Blockfrost.

| # | Statement | Fact | Check | Test that fails without it |
|---|---|---|---|---|
| 1 | All N anchors outside the rotation drill, N distinct transactions (kind 1 and kind 2 counts), the crash-drill anchors and the same-block pair among them, valid at consensus-verified, each with the commitment the rehearsal recorded | `raw.anchors`; `verified.anchors[name]` status, assurance, txHash, commitment | `judge`: one name per txHash, kind 1 or 2, `valid` at `consensus-verified`, the verifier's txHash and commitment equal the recorded ones, at least 10 kind 1 and 2 kind 2, each crash window's anchor and the pair among the recorded anchors | gate.test `every anchor the rehearsal wrote is verified` |
| 2 | The verifier ran in `verify-all.mjs`, importing only Node built-ins, `gate.mjs` and the verify package, reading through Blockfrost preprod, with the package npm installed from the named tarball (its sha256), whose integrity still matched npm's record | `verified.package` (resolved, integrity, sha256); `verify-all.mjs` itself | `verify-all.mjs` refuses, before loading the package, one that resolves outside its own `node_modules`, has no entry in its `package-lock.json`, was installed from anything but a `file:*.tgz` beside it, or whose tarball no longer has the recorded sha512; `judge` requires `verified.package` to name such a tarball | verify-all.test `refuses, before loading it, ...`, `records the tarball ...`, `imports nothing but ...`, `... through Blockfrost preprod alone` (the stand-in records the source of every call); gate.test `the verify package` |
| 3 | Every transaction the journals recorded as landed, but the registry deploy, is a recorded anchor, and every recorded anchor is in a journal as landed | landed rows of `~/.secrets/orynq-midnight-preprod/journal-*.sqlite`; `raw.anchors` | `unrecordedAnchors`, run by `compose.ts` | gate.test `closes 'every anchor' over the journals`; compose.test `refuses when a journal saw an anchor land ...` |
| 4 | The rehearsal submitted the pair from wallets A and B in round R, and the verifier places both in block H (hash) | `raw.sameBlock.coLanded` and each anchor's `wallet` (the rehearsal's record: DUST spends are shielded, so no chain read shows the payer); `verified.anchors[name].block` | `judge`: two wallets, both recorded at H, both valid, and the verifier's block for each is H with one hash | gate.test `refuses a same-block pair ...` (both) |
| 5 | The four rotation anchors gave the expected verdict under each document set | `verified.rotation[set][label]`; `raw.rotation.keys`; each anchor's author and height | `judge`: `ROTATION_EXPECTED` per set, valid only at consensus-verified, relay-1 wrote the first two and relay-2 the last two, in increasing blocks | gate.test `the rotation drill` |
| 6 | The verify package answered each forged document as the gate requires; Ed25519 verification refused both forgeries under the trust root's key; the same document opened under the stranger as trust root | `verified.forgedDocuments[name].outcome` | `judge`: each answer exactly as the table above, none missing, none unknown | forgeries.test; gate.test `forged KNOWN_AUTHORS documents ...`; verify-all.test `forges serial 3 three ways ...`; anchors-midnight known-authors.test |
| 7 | Blockfrost's preprod node answered each maintenance transaction with 1010 "Invalid Transaction" and the authority's own code; Blockfrost's indexer, asked by the rehearsal and by the verifier, lists none of them; the registry state Blockfrost's node reported afterwards passes the immutability check | `raw.negatives[name]`: the refusal `nodeRefusal` took from the node's JSON-RPC error, which Blockfrost relays as the node gave it (no one but the submitter sees a refusal), and `onChain` from Blockfrost's indexer; `verified.refusedTransactions[name]`; `raw.negativesAfter`, which `run.ts` writes only after `assertRegistryState` passes | `judge`: code 1010, message `Invalid Transaction`, data the case's own code (`NODE_NEGATIVES`), `onChain` 0, Blockfrost's answer for that txHash `invalid` with `indexer: the indexer knows no transaction ...`, `registryStillImmutable` | gate.test `the node-enforced negatives ...`; compose.test `refuses review2's pack ...`; verify-all.test `asks Blockfrost for every transaction the node refused ...` |
| 8 | The crash drill killed the submitter with SIGKILL (exit 137) before the bytes went to the node and after the node accepted them; each restart landed exactly the journalled transaction | `crash.log` (`crash.ts`), `crash.log.status` (`rehearse.sh`) | `judge`: per `CRASH_WINDOWS`, one kill step in the window's mode logging the window's words (`crash.ts` takes them from the same table and refuses any other label and mode), exits 137 and 0, a pending row at death, one landing of that txHash with one landed row, a resend only for `kill-before`, the anchor among the recorded | gate.test `the journal crash drill` |
| 9 | Each verifier negative returned its expected status from its expected check | `verified.negatives` | `judge`: `VERIFIER_NEGATIVES` status and failing check | gate.test `the verifier negatives` |
| 10 | The private receipts hold an opening for each kind-2 anchor, each recomputing the commitment the verifier read; none is in the pack | `receipts.json` (0600); `verified.anchors[name].commitment` | `compose.ts`: an opening per kind-2 txHash whose `hidingCommitment(hiddenDigest(opening, attribute), salt)` equals the verifier's commitment; the scan finds no 8-byte window of any secret or opening field, and finds salts and root hashes in the receipts and attributes in the pack | compose.test `refuses a kind-2 opening ...`, `writes nothing when the privacy scan finds a secret ...` |
| 11 | The documents are signed by trust root R, not among the trust roots the verify package ships, and each names only preprod | `verified.trustRoot`, `verified.shippedTrustRoots` (the package's `KNOWN_AUTHORS_TRUST_ROOTS`), `verified.knownAuthorsDocuments` | `judge`: R not shipped; three documents, each naming `preprod` alone | gate.test `the drill's trust root` |

The pack claims nothing else, since no check establishes it: not where each write went (the
pack's `chain.blockfrost` records the chain identity of the Blockfrost endpoints `run.ts` and
`crash.ts` write and read through, and `chain.hosted` that of the hosted endpoints whose indexer
the wallets sync from), not which wallet paid beyond the rehearsal's record, not how or when the
drill's trust-root key was made, and not that the tooling that ran was committed (`commit` is the
worktree's HEAD).

## Tests

`pnpm test` in the package runs `test/` (the gate, `verify-all.mjs`, `compose.ts` and `finish.sh`
end to end over a synthetic rehearsal, a stand-in verify package and a fake `HOME` with 0600
secrets and SQLite journals, and `run.ts deploy` in its own processes over `test/offline.ts`, the
submit package with its wallet, prover and chain replaced, failing one run at a chosen step and
checking the next run finishes the same deploy). The synthetic KNOWN_AUTHORS documents carry real
Ed25519 signatures, and the stand-in verify package runs the real KNOWN_AUTHORS code from
`../../anchors-midnight/dist`, so the anchors-midnight build must be current (CI builds it
first). `pnpm typecheck` covers the scripts too. CI never runs a network step. A step that did
not run, or failed, leaves a hole the gate refuses (a missing anchor record, crash log, node
refusal or verifier verdict), and no pack is written.

## Runbook

Everything below runs on the operator host, from this directory, with Node 24 and the workspace
installed and built (`pnpm install && pnpm build` at the root).

### 0. What must already be in place

- `~/.secrets/orynq-midnight-preprod/` (0700) with `wallet-a.mnemonic`, `wallet-b.mnemonic`,
  `author-relay.key` and `salt.key` (0600), made with `../scripts/keys.ts`. The rehearsal adds
  `author-relay-2.key`, `known-authors-root.seed`, `receipts.json`, the journals and the wallet
  state there. None of them is ever printed.
- `~/.secrets/blockfrost-midnight-preprod.project_id` (0600): every broadcast and every read,
  the verifier's included, goes through Blockfrost preprod.
- `tools/compactc/install.sh ~/.cache/orynq-midnight/compactc ~/.cache/orynq-midnight/zk`: the
  compiler and the pinned ZK material the prover reads.
- Saved wallet state in `~/.secrets/orynq-midnight-preprod/state/`. The wallets sync from
  Midnight's hosted indexer, the one their saved state was synced from: restoring it takes about
  four minutes per wallet. Blockfrost's indexer numbers its events differently, so against
  Blockfrost, or without saved state, each wallet resyncs from genesis, about two hours of CPU.

### 1. Faucet

The faucet sits behind a Cloudflare Turnstile captcha, so a person does this step. At
<https://faucet.preprod.midnight.network/>, request tNIGHT for each wallet's unshielded address
(the faucet refuses the shielded and DUST forms):

| Wallet | Role | Unshielded address |
|---|---|---|
| A | registry deployer and anchor fee payer | `mn_addr_preprod18hnkqxax2qyjrkm8ats9dkmr9vlwh0v6mvtfhtt4t5tvzq5t4l7sc2xpu6` |
| B | second fee payer for the same-block test | `mn_addr_preprod1jyy8gesdrewxa9sz6ujm63wx4w390psjtce9ueq5ps3u3hy5077s2859zm` |

These are the preprod addresses in the operator's public record, `orynq-midnight-public.json`,
copied into `wallets.json`.

### 2. Rehearse

```
./rehearse.sh
```

The `funding` phase registers each wallet's NIGHT for DUST generation and waits until each holds
more than 1 DUST it can spend. Every phase resumes from `evidence/raw.json`, so a rerun after an
interruption finishes what is missing. A rerun keeps the first funding record, the registration
the verifier reads among it. A DUST coin spent by bytes that never landed comes back to its
wallet only after the ledger's grace period (about three hours on preprod), so a rerun soon after
such a failure waits in `funding` until then. A registry deploy journalled earlier that the chain
has carried past its TTL unseen is settled as failed, and `deploy` prepares new bytes. One the
chain has not ruled out, landed or still pending, is resumed from the journal's bytes: `deploy`
sends those same bytes again only if no broadcast of them ever returned, waits for them, and
records them as the prepared deploy, so a run that failed between the broadcast and the readback
leaves the next run that deploy to finish, never a second one. The crash drill runs once: a
second pass would add to its log, and the gate would refuse the pack.

### 3. The consumer

The verifier runs from a directory outside the repository into which only the packed verify
package is installed, from the same commit:

```
C=$(mktemp -d "$HOME/.cache/orynq-midnight/consumer.XXXXXX")
pnpm --filter @fluxpointstudios/orynq-sdk-anchors-midnight build
(cd ../../anchors-midnight && pnpm pack --pack-destination "$C")
(cd "$C" && npm init -y >/dev/null && npm install ./fluxpointstudios-orynq-sdk-anchors-midnight-0.1.0.tgz)
sha256sum "$C"/*.tgz
```

Keep the tarball and npm's `package-lock.json` in `$C`. `verify-all.mjs` refuses, before loading
it, a verify package that resolves anywhere but that directory's own `node_modules` (such as a
link to the source tree), one the lock does not record as installed from a tarball in that
directory, and one whose tarball no longer has the integrity npm recorded. The pack records the
tarball's name and sha256.

### 4. Verify and compose

```
CONSUMER=$C ./finish.sh ~/orynq-midnight-preprod-evidence.json
```

`verify-all.mjs` prints one line per verdict and a `GATE:` line per claim it cannot establish;
its full output stays in `evidence/verified.json`. `compose.ts` then judges again, checks the
journals and scans the pack before writing it.

### 5. The evidence pack

`orynq-midnight-evidence/v1`: the commit, the chain, the pins, the wallets' public addresses, the
registry deploy and its readback, every anchor with its verifier verdict, timing and fee, the
same-block pair, the node's refusals with Blockfrost's answer for each, the KNOWN_AUTHORS drill
with its verdict matrix and the forged documents, the crash drill's log, the verifier negatives,
the verify package's install record, the measurements, the statements mapped above, and the
privacy scan. Kind-2 openings and every key stay on the operator host.

After the pack, `node --import tsx record-golden.ts OUT.json` records the golden fixture.
