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
| `run.ts` | The phases `chain funding deploy kind1 kind2 sameblock negatives rotation`. Records everything public in `evidence/raw.json` (git-ignored). A node negative counts as refused only on the node's own JSON-RPC answer (`nodeRefusal`), and a recorded case is never sent again. |
| `crash.ts` | One crash-window step per process: `kill-before`, `kill-after` (SIGKILL) and `recover`. |
| `docs.ts` | Signs the drill's KNOWN_AUTHORS documents with a preprod-only trust root through `anchors-midnight/scripts/known-authors.ts`. |
| `rehearse.sh` | All of the above in order, at nice 19; the crash drill runs once. |
| `verify-all.mjs` | Verifies every recorded anchor, the rotation matrix and twelve verifier negatives through Blockfrost, from a consumer directory that installed only the packed verify package, and exits 1 on any gate failure. |
| `gate.mjs` | The claims the pack may make, from what was recorded and what the verifier returned. Each maintenance update counts as refused only on the node's answer 1010 Invalid Transaction with the maintenance authority's own custom code (below). |
| `compose.ts` | Writes the pack only when the gate passes, every journal's landed transactions match the recorded anchors, and the privacy scan finds no window of any secret. |
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

## Tests

`pnpm test` in the package runs `test/` (the gate, `verify-all.mjs`, `compose.ts` and
`finish.sh` end to end over a synthetic rehearsal, a stand-in verify package and a fake `HOME`
with 0600 secrets and SQLite journals). `pnpm typecheck` covers the scripts too. CI never runs a
network step. A step that did not run, or failed, leaves a hole the gate refuses (a missing
anchor record, crash log, node refusal or verifier verdict), and no pack is written.

## Runbook

Everything below runs on the operator host, from this directory, with Node 24 and the workspace
installed and built (`pnpm install && pnpm build` at the root).

### 0. What must already be in place

- `~/.secrets/orynq-midnight-preprod/` (0700) with `wallet-a.mnemonic`, `wallet-b.mnemonic`,
  `author-relay.key` and `salt.key` (0600), made with `../scripts/keys.ts`. The rehearsal adds
  `author-relay-2.key`, `known-authors-root.seed`, `receipts.json`, the journals and the wallet
  state there. None of them is ever printed.
- `~/.secrets/blockfrost-midnight-preprod.project_id` (0600), for the verifier's reads.
- `tools/compactc/install.sh ~/.cache/orynq-midnight/compactc ~/.cache/orynq-midnight/zk`: the
  compiler and the pinned ZK material the prover reads.
- Saved wallet state in `~/.secrets/orynq-midnight-preprod/state/`. Without it, the first sync of
  each wallet from Midnight's hosted indexer takes about two hours of CPU.

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
more than 1 DUST. Every phase resumes from `evidence/raw.json`, so a rerun after an interruption
finishes what is missing. The crash drill runs once: a second pass would add to its log, and the
gate would refuse the pack.

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

`verify-all.mjs` refuses to load a verify package that resolves anywhere but that directory's own
`node_modules`, such as a link to the source tree.

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
same-block pair, the node's refusals, the KNOWN_AUTHORS drill and its verdict matrix, the crash
drill's log, the verifier negatives, the measurements, statements built only from what the gate
established, and the privacy scan. Kind-2 openings and every key stay on the operator host.

After the pack, `node --import tsx record-golden.ts OUT.json` records the golden fixture.
