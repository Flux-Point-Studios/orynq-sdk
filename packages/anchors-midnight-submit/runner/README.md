# Midnight mainnet runner

Runs the orynq-anchor-registry deploy, and then the anchors into that registry, on Midnight
mainnet without anyone at a terminal, once deci has approved the exact intent in chat. It runs the
reviewed tools, `scripts/deploy-mainnet.ts` and `scripts/anchor-mainnet.ts`, in a
pseudo-terminal, the way the terminal wrappers in `~/orynq-midnight-mainnet-proof` have since
2026-10-16. At each confirmation prompt it types the token only when the tool's summary matches
the approved intent fact by fact and every hard limit below still holds. Otherwise it answers
`NO`, and the tool sends nothing.

The additional `proofs` action runs `scripts/proofs-mainnet.ts` for exactly one immutable proof-presentation deployment and one synthetic presentation per circuit. Its exact pins, public statements and preparation-only intent are in [PROOF-RELEASE.md](PROOF-RELEASE.md). It uses `proof-release.sqlite` beneath the runner root, preserves prepared bytes across retries, and requires all three pinned transactions to be landed before reporting completion. This does not authorize the standing anchor service to publish proofs.

## Threat model

Every agent on Gemtek (Claude Code, Codex) runs as uid `deci`, and `deci` has passwordless sudo.
Nothing on this host can stop a malicious agent from reading the deploy wallet's mnemonic or the
FPS author key, writing an approval, editing `limits.json`, or running the tools itself. The
runner does not change any of that.

It is a guardrail against mistakes and drift:

- an intent nobody approved;
- an approval of another intent, a reused approval, or one that has expired;
- a summary that differs from what was approved;
- a fee over the cap, or more DUST in a day than the daily cap;
- a retry that could send a transaction twice.

The real bound on loss is the deploy wallet's balance. Keep it minimally funded: enough DUST for
the approved transactions, topped up for each approval.

## Approvals

The state root is `~/.local/state/orynq-midnight/runner/`, owner-only (0700, as is each directory
in it):

| Path | Written by | What it holds |
|---|---|---|
| `intents/<id>.json` | the CTO session | The intent object, in the shape the terminal wrappers show deci. Its id is the first 8 hex characters of the sha256 of its compact JSON (`JSON.stringify` of the parsed file, keys in the order written), as the wrappers compute it. |
| `approvals/<id>.json` | the CTO session, only after deci approved that exact intent in chat | `{ "intent_id", "intent_sha256", "approved_at", "expires_at", "approved_via": "chat", "approver": "deci" }`, times in ISO 8601 ending in `Z` or a `±hh:mm` offset |
| `used/<id>.<approval-sha256>` | the runner | The single-use marker for the approval consumed when the tool finished (`done`), or when the runner stopped it by answering `NO` (`refused`). The approval sha256 is its identity (below), not the hash of the file's bytes. |
| `status/<id>.json` | the runner | `state`, `attempt`, `next_attempt_at`, `last_progress` (the tool's last output line), `transactions` (each confirmed transaction hash, its declared fee and the approval it was confirmed under), `refusals` (each with its reason) |
| `audit.jsonl` | the runner | Append-only; see below |
| `logs/<id>.log` | the runner | The tool's output, attempt by attempt |
| `execution.lock` | `flock` | Serializes tool attempts across intents, including wallet access and confirmation accounting. Never remove this file while a runner is active. |

The runner executes an intent only while all of these hold (`gate.ts`). It checks them before
every attempt and again at every prompt, and names the first that fails:

1. `intents/<id>.json` hashes to an sha256 that starts with `<id>`.
2. `approvals/<id>.json` exists, has exactly the six fields, names this intent, and says
   `approver: "deci"` and `approved_via: "chat"`.
3. Its `intent_sha256` is the intent's sha256.
4. Both times end in `Z` or a `±hh:mm` offset. It was given no later than now, lasts at most
   `maxApprovalHours` (24), and has not expired.
5. That approval has no used marker or durable `no`/`done` audit record.
6. The action is allowlisted, and every fact `limits.json` pins matches, with no other field.
7. The intent's fee cap is at or below the per-transaction cap.
8. Other intents' DUST reservations for the rolling 24-hour window, plus this intent's maximum, stay at or
   below the daily cap. The maximum is its fee cap times its transactions.

A refusal at the gate runs nothing and leaves the approval unused. Dispatch does not restart an
intent that finished under the same approval, so a corrected approval runs again.

The full intent and approval digests are pinned for the run. A replacement stops that run;
its refusal consumes only the original approval. A separately approved replacement remains
eligible, with all earlier confirmations still counted and the same fee and journal checks.
Every `no` audit record names the original approval and is flushed before the tool reads the
`NO`, a `NO` to a prompt for the other action included.
Admission and dispatch recover it even if the process stopped before writing a used marker and
the status snapshot was lost. Legacy `used/<id>` markers and terminal audit records without an
approval digest keep the whole intent closed, since their approval identity is unknown.

An approval's identity, its approval sha256, is the sha256 of its six values with each time as
the instant it names, not of the file's bytes. The gate refuses a time without `Z` or a `±hh:mm`
offset (`2026-10-20T17:59:00`, as `date -u` prints it without a `Z` in the format or Python's naive
`isoformat()` does): `Date.parse` reads one in the runner's time zone, America/Denver on Gemtek,
which would move the 24-hour window and, with `TZ`, the identity of an approval already used. The
same approval rewritten with other whitespace, key order or offset for the same instants is still
the approval a used marker or a `no` consumed, in every time zone; a replacement with any other
value is a new approval. The source plan is
checked against its digest while parsing. The execution plan is checked against the approved
entries, and its digest is passed as `--plan-sha256`; the anchor tool checks and parses those
same bytes before connecting or opening a wallet. This also binds the private inputs of kind-2
anchors, which their public summaries do not reveal.

## Hard limits

`limits.json` holds them. Changing one is a code change, reviewed like any other, and the
`limits.json` tests check them against the tools' own pins.

| Limit | Value | What it bounds |
|---|---|---|
| `network` | Midnight Mainnet, genesis `1941ca8e…2854` | Every intent's network, and the network row of every summary |
| `payer` | `mn_addr1hdg7…sq` | The wallet every intent and every summary's `paid from` names |
| `maxFeeDustPerTransaction` | 0.01 | Each intent's fee cap, the wrappers' `--max-fee-dust` default. The deploy declared 2 SPECK on 2026-10-16. |
| `maxDustPer24Hours` | 0.1 | Ten per-transaction caps. Each confirmation reserves its declared fee until 24 hours after the later of confirmation and the transaction's validity deadline, once per transaction hash, whether or not it landed. This covers a transaction that lands after confirmation. |
| `maxApprovalHours` | 24 | How long one approval may last |
| `maxConfirmationsPerTransaction` | 3 | How many sets of bytes the runner confirms for one transaction under one approval. A second set comes only after the journal retired the first: chain time passed its TTL plus five minutes and it never landed. After three sets, the runner stops and reports. |
| `deploy` | `action`, `authority` (`committee [] (0 members), threshold 1, counter 0`), `verifierKeys` (`anchor`, `anchor_hiding`) | Allowlist (a): exactly the registry deploy of intent bf35fa0c |
| `anchors` | `action`, `authorKeys` (the FPS relay author key), `maxEntriesPerApproval` 8 | Allowlist (b): anchors into the registry deploy-mainnet's journal holds landed, through `anchor` (kind 1) and `anchor_hiding` (kind 2), with the commitments the plan's entries derive. One deploy and eight anchors at the cap fit in the daily cap. |
| `proofs` | `proofReleaseIntent()` in `proof-release-intent.ts` | Allowlist (c): the pinned immutable proof contract plus exactly its two fixed synthetic presentations. Three transactions at 0.01 DUST each reserve at most 0.03 DUST initially, within the same 0.1 DUST rolling daily cap. |

For anchors, the intent's plan file must still hash to its `planSha256`, and the plan's entries
must be exactly the intent's. The registry is either 64 hex characters, which must be the registry
the deploy journal holds landed, or the phrase the wrappers use for an intent authorized before the
deploy landed: `the registry <deploy journal> records as landed and read back, written into
~/orynq-midnight-mainnet-plan.json by fill-registry.mjs`. Each anchor summary must show the
planned kind and hashes. For kind 1 it must also show the commitment `entryCommitment` derives
from the entry. For kind 2 it must show the planned attribute: the commitment hides the entry
under a salt only the salt key derives, so the runner cannot recompute it.

## Units

| Unit | What it does |
|---|---|
| `orynq-midnight-runner@<id>.service` | Runs intent `<id>`. Never enabled; dispatch starts it. |
| `orynq-midnight-runner-dispatch.path` | Starts dispatch whenever a file in `approvals/` changes |
| `orynq-midnight-runner-dispatch.timer` | Starts dispatch two minutes after it starts (at boot, once enabled) and every 15 minutes after, so a run that a reboot or a crash ended resumes while its approval holds |
| `orynq-midnight-runner-dispatch.service` | `orynq-midnight-runner dispatch`: starts the unit of every approval that is not used or finished under the same approval, and is not already running. The run records an expired approval's refusal. An approval the gate refuses before it has an identity (one that is not deci's in chat, say) is started once, and again once the gate can name it. |

The units run `runner/orynq-midnight-runner` from
`~/.local/lib/orynq-midnight-runner/checkout`, a symlink to the reviewed checkout, with
`~/.local/lib/orynq-midnight-runner/bin/node` first on `PATH`. `systemd/verify.sh` checks them with
`systemd-analyze --user verify`, laid out that way; CI runs it.

## A run

1. The gate admits the intent.
2. Anchors wait, as `auto-anchor.mjs --after-deploy` does, until the deploy journal
   (`~/.local/state/orynq-midnight/mainnet-deploy.sqlite`) holds FPS's registry deploy landed and
   read back in its block, for at most as long as the approval holds. For the after-deploy phrase, the
   runner then writes `~/orynq-midnight-mainnet-plan.json` from the template with that registry,
   with the checks `fill-registry.mjs` made. The template's registry must be the placeholder,
   anchor-mainnet's parser must accept the plan, and an existing plan must be identical.
3. The tool waits for the shared util-linux `flock` execution lock, then runs under `script`,
   with the runner's environment and the package's default paths. Anchors wait for a landed
   deploy before joining this lock queue. A queued tool remains subject to approval expiry.
4. At each prompt, the runner checks the summary (`confirm.ts`), the approval, the journal and the
   daily cap, then types the token or `NO`.
5. A tool that exits 0 finishes the run (`done`), and the approval is used. The tool's exit
   status is what the shell reports on its own descriptor once the tool exits, never `script`'s:
   `script` exits 0 when a stray `SIGTERM`, `SIGINT` or `SIGQUIT` ends it, having killed the shell
   and the tool. An attempt without that report was interrupted. A `NO` ends the run (`refused`,
   approval used). An interrupted attempt and any other failure, such as a wallet sync that timed
   out or a readback that lost the indexer, are retried after 1, 2, 4, 8, 16, then every 30
   minutes, until the approval expires. The tools save the wallet's sync state every five minutes and when a
   sync fails, so each retry resumes the sync instead of starting from genesis.

**No transaction is sent twice across retries.** The tools journal every transaction in a
write-ahead journal (`anchors-midnight/journal`) before broadcasting it: the row holds the hash of
the exact bytes. A rerun shows the bytes the journal still holds, marked `journal resumed`, and
confirming them sends nothing new: at most the same bytes again, if no send of them ever returned.
The runner confirms these again as the same transaction (`confirm` with `resumed: true` in the
audit log), and they count once against the daily cap. It confirms other bytes for a transaction
only when the journal holds each earlier set `failed`, or holds none of them, which means they were
never sent. `test/mainnet.test.ts` shows this with the real `deploy-mainnet` over the offline
mainnet: a run whose readback fails after the broadcast is retried, and the node is handed the
deploy exactly once.

Each attempt confirms an item at most once. Every `NO`, including a prompt for the wrong action,
ends the run. Confirmation records include the approval digest and are flushed before the
token is written. Status and used markers are flushed too, including their directory entries;
a missing status snapshot is rebuilt from the audit's confirmation history. The shared execution
lock prevents two tools from passing the daily-cap check concurrently. Resumed bytes need fresh
headroom when their earlier reservation has aged out. A missing or invalid validity deadline, or one
without `Z` or an offset, gets `NO` rather than an unbounded, shortened or zone-dependent
reservation; the gate refuses a confirmation record whose times lack one rather than read them in
the runner's zone.

**Expiry.** No attempt starts after the approval expires. A tool that has confirmed nothing is
stopped at expiry. Every prompt after expiry gets `NO`. A tool that already confirmed a
transaction is left to finish, since its bytes may be with the node.

**Agent environments.** `run` and `dispatch` refuse a process carrying `CLAUDECODE`, any
`CLAUDE_CODE_*`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_CI` or any `CODEX_MANAGED_BY_*`
(`agentDriven`, as the tools check). `run` also requires `INVOCATION_ID` to be the one
`systemctl --user show` reports for `orynq-midnight-runner@<id>.service`, so only systemd starts
it. A unit started with `systemctl --user start` gets the user manager's environment, not the
caller's. On Gemtek on 2026-10-20, `systemctl --user show-environment` listed none of those
variables. A process running as deci can still import variables into the manager, or start the
unit itself. This check is a guardrail, and nothing more.

## Status and audit

```
runner/orynq-midnight-runner status [<id>]
bf35fa0c deploy retrying attempt 2 next 2026-10-20T19:00:00.000Z tx - refusals 0 | wallet sync at ...
```

One line per intent: action, state (`admitted`, `waiting-for-deploy`, `running`, `retrying`,
`done`, `refused`, `expired`), attempt, next attempt, the first 16 hex characters of each confirmed
transaction, the number of refusals with the last one's reason, and the tool's last output line.
`orynq-midnight-runner check <id>` prints the intent's sha256 and what the gate says of it now,
and runs nothing.

The audit log records:

- `approval-seen`: every approval a run reads, with its sha256 and the gate's verdict
- `dispatch`: every unit dispatch starts
- `refused-start`: every start refused for an agent environment or outside systemd
- `failed`: every run that broke off on an error; dispatch starts it again while its approval holds
- `deploy-landed` and `plan`: the anchors' registry, and the plan written for it
- `run-start` and `run-end`: every attempt, with the tool's exit code
- `confirm` and `no`: every confirmation, with its transaction hash and declared fee, and every
  `NO`, with its problems
- `retry`, `done`, `refused`, `expired`: how each attempt and each run ended, with the reason

## Install

The CTO session installs it on Gemtek after review, from a checkout of its own at the reviewed
commit, never deci's:

```sh
REVIEWED=<the reviewed commit>
git -C ~/work/orynq-sdk fetch origin
git -C ~/work/orynq-sdk worktree add --detach ~/work/orynq-midnight-runner-live "$REVIEWED"
cd ~/work/orynq-midnight-runner-live
pnpm install --frozen-lockfile --filter "@fluxpointstudios/orynq-sdk-anchors-midnight-submit..."
nice -n 10 pnpm --filter "@fluxpointstudios/orynq-sdk-anchors-midnight-submit^..." build
packages/anchors-midnight-submit/runner/systemd/verify.sh

install -d -m 700 ~/.local/lib/orynq-midnight-runner ~/.local/lib/orynq-midnight-runner/bin
ln -sfn ~/.nvm/versions/node/v24.15.0/bin/node ~/.local/lib/orynq-midnight-runner/bin/node
ln -sfn ~/work/orynq-midnight-runner-live ~/.local/lib/orynq-midnight-runner/checkout
for d in "" intents approvals used status logs; do install -d -m 700 ~/.local/state/orynq-midnight/runner/$d; done

# The user manager starts the units with its own environment: it must hold no agent variable.
systemctl --user show-environment | cut -d= -f1 | grep -E '^(CLAUDECODE$|CLAUDE_CODE_|CODEX_)' && echo STOP || echo clean

install -d ~/.config/systemd/user
install -m 644 packages/anchors-midnight-submit/runner/systemd/orynq-midnight-runner@.service \
  packages/anchors-midnight-submit/runner/systemd/orynq-midnight-runner-dispatch.service \
  packages/anchors-midnight-submit/runner/systemd/orynq-midnight-runner-dispatch.path \
  packages/anchors-midnight-submit/runner/systemd/orynq-midnight-runner-dispatch.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now orynq-midnight-runner-dispatch.path orynq-midnight-runner-dispatch.timer
```

An intent goes into `intents/<id>.json` as the wrapper logged it. `orynq-midnight-runner check
<id>` then prints its sha256 for the approval. Only after deci approves that intent in chat, the
CTO session writes the approval to a temporary name and moves it into place, so dispatch never
reads half a file:

```sh
cd ~/.local/state/orynq-midnight/runner && umask 077
printf '{"intent_id":"%s","intent_sha256":"%s","approved_at":"%s","expires_at":"%s","approved_via":"chat","approver":"deci"}\n' \
  "$id" "$sha256" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ)" > "approvals/.$id.tmp"
mv "approvals/.$id.tmp" "approvals/$id.json"
```

## Terminal wrappers

`confirm.ts` is what `auto-deploy.mjs` and `auto-anchor.mjs` check by hand. `deployIntent` and
`anchorsIntent` build the intent objects they show, from `limits.json`. `checkDeploySummary` and
`checkAnchorSummary` check a summary against an intent. `driveTool` runs a tool under `script`,
answers its prompts, and returns the tool's own exit status, or null when a signal ended `script`
first. A wrapper that keeps its own terminal pre-authorization calls `driveTool` with
`decide` set to the matching check, and keeps a set of confirmed labels.
During installation, replace each proof-directory wrapper's local `checks` function and PTY loop
with imports of these functions from the reviewed checkout. Keep its initial terminal and
agent-environment guards, its `PREAUTHORIZE` prompt, its log, and its after-deploy wait. For
`auto-anchor`, keep the confirmed-label set in the `decide` callback. This migration is performed
by the CTO session; the review does not modify the proof-directory copies.

## First intents

The fixtures' compact intent JSON matches the intent objects on the first `authorized` lines of
the two 2026-10-20 wrapper logs. Installation copies only the intent objects; those historical terminal
authorizations do not create chat approvals.

| Intent | SHA-256 of compact JSON |
|---|---|
| `bf35fa0c` | `bf35fa0c0d16371a78ad26743e9d2691f6fca549571e3fa63816f0010b66a715` |
| `34941c71` | `34941c719ec6bd536b0d5a45fa249ca4135e92bd0ee7fecaa6bbd36ca72604c0` |

From the installed checkout, after review:

```sh
for id in bf35fa0c 34941c71; do
  install -m 600 "packages/anchors-midnight-submit/runner/test/fixtures/$id.json" \
    "$HOME/.local/state/orynq-midnight/runner/intents/$id.json"
done
```

The anchors fixture still refers to `/home/deci/orynq-midnight-mainnet-plan.template.json` and
its existing digest. A changed template requires a new intent and a new chat approval.

## Tests

`pnpm test` runs them with the package's suite:

- `confirm.test.ts` checks the limits against the tools' pins. It rebuilds intents bf35fa0c and
  34941c71 byte for byte. It names every mismatched fact of a deploy or anchor summary. It runs the
  wrappers' fake-tool checks in a pseudo-terminal (`fake-tool.ts` prints the tools' own summaries
  and prompts), hands each `NO` to `onNo` before the tool reads it, and reports no exit status
  for a `script` a stray signal ended. A validity deadline without `Z` or an offset gets `NO`.
- `gate.test.ts` refuses each failing condition at its boundary, approval and confirmation times
  without `Z` or an offset under `TZ=America/Denver` and `TZ=UTC`, and a used approval rewritten
  with other whitespace, key order or offset, or read under another time zone.
- `plan.test.ts` ports `fill-registry.mjs`'s tests.
- `run.test.ts` covers the run over the fake tool: a match, every mismatch, sync retries, a
  resumed transaction, the journal guard (bytes it still holds pending or landed, bytes it
  retired, bytes it never held), three confirmations at most, the daily cap, an approval withdrawn during the sync,
  expiry between attempts, before the next backoff ends and during an attempt, a tool that
  confirmed before expiry left to finish, a gate refusal, anchors waiting for the deploy, a
  mismatched anchor after a confirmed one, a `script` a stray signal ended retried rather than
  finished, a `NO` for the other action recorded before the tool reads it, a used approval
  rewritten with the same values, a finished approval kept used by its `done` record once its used
  marker and status are lost, and an approval whose times name no offset, which runs nothing in
  either zone.
- `state.test.ts` checks that each audit line is synced to disk before its file is closed.
- `review.test.ts` covers reservations held past the validity deadline, one confirmation per item
  per attempt, a wrong-action `NO`, the pinned approval identity, confirmation limits and daily
  headroom recovered from the audit, the shared execution lock, and the plan digest the anchor tool
  is given.
- `recovery.test.ts` covers a replacement approval between attempts and during a run, a `NO` kept
  terminal across an interruption before its used marker, and earlier confirmations counted
  against a replacement's daily cap.
- `cli.test.ts` covers the agent-environment and systemd refusals, a run that broke off,
  dispatch (a rewritten used approval and one the gate cannot name included), status, check and
  argument errors.
- `mainnet.test.ts` runs the real `deploy-mainnet` and `anchor-mainnet` over the offline mainnet:
  a stalled sync retried, a failed readback resumed with one send, a `NO` that sends nothing, and
  anchors written once the deploy journal lands the registry.
