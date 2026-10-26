# Hosted standing service

The service composes the authenticated follower, certified census, retained publisher,
session, journal and controller. It compounds existing SDK receipts by retaining their
portable proof objects and anchoring canonical certified batch sets to the approved registry.
Installing it does not establish receipt coverage. Require an authenticated landed set and
fresh public receipt verification before reporting coverage.

Run `node --import tsx runner/standing-service.ts --config CONFIG_FILE` from this package.
The configuration file must be private and owner-controlled. Its exact fields are:

```json
{
  "mode": "observe",
  "network": "mainnet",
  "genesis": "0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf",
  "registry": "438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736",
  "author": "067513ff2f976554098feecb3555197255b71f26a48ad6b1828ade967b746a39",
  "stateRoot": "/home/deci/.local/state/orynq-midnight/standing",
  "materiosRpcUrl": "https://materios.fluxpointstudios.com/rpc",
  "midnightReadRpcUrl": "https://midnight-proofs-a.fluxpointstudios.com/midnight/mainnet/rpc",
  "knownAuthorsFile": "/home/deci/.config/orynq-midnight-standing/known-authors.json",
  "wallet": {
    "mnemonic": "/home/deci/.secrets/orynq-midnight-mainnet/mnemonic.txt",
    "record": "/home/deci/work/orynq-midnight-mainnet-wallet.json",
    "state": "/home/deci/.local/state/orynq-midnight/mainnet-wallet.state.json",
    "blockfrost": "/home/deci/.secrets/blockfrost-midnight-mainnet.project_id",
    "zk": "/home/deci/.cache/orynq-midnight/zk",
    "author": "/home/deci/.secrets/orynq-midnight-hosted/batch-author.hex"
  },
  "stores": [
    {"url": "https://midnight-proofs-a.fluxpointstudios.com", "keyFile": "/home/deci/.secrets/orynq-midnight-hosted/proof-store-a.key"},
    {"url": "https://midnight-proofs-b.fluxpointstudios.com", "keyFile": "/home/deci/.secrets/orynq-midnight-hosted/proof-store-b.key"}
  ]
}
```

Every file the configuration names must also be owner-only (mode 0600) and owned by the
service's user, the public wallet `record` and signed author policy included; only `zk`, whose
public parameters are checked by hash, is exempt. The service refuses any other file and names it
and the reason as it stops.

`genesis` names Materios. The signed author policy supplies Midnight's original finality
checkpoint. Policy and the compiled mainnet batch-author pin must authorize the configured
author. Copy the released signed public policy into `knownAuthorsFile`; updates may append
newer signed documents but must retain checkpoint/accounting continuity.

Observe mode loads no wallet, author secret, policy-root seed or proof-writer credential.
It authenticates a fresh startup point, obtains the complete accounting/author-history floor
and catches up under bounded HTTP work. `midnightReadRpcUrl` is an explicit read-only source;
wallet submission and sync continue to use the existing Blockfrost endpoint selection.
The hosted read proxy keeps the provider credential server-side. Midnight's former public
mainnet RPC is retired; activate the restricted proxy before using this configuration.
Once caught up, the follower waits sixty seconds between idle polls to amortize read quota
over several blocks. Successful catch-up continues immediately; source errors retry after
five seconds. The controller still runs every fifteen seconds and refuses a head older than
the existing two-minute freshness limit. Measure total steady-state provider usage before
activation; a bounded local cap does not establish sufficient shared-project capacity.

Anchor mode remains operator-terminal-only on mainnet. Agent-driven processes refuse before
shared state or credential access. Acquire the canonical shared execution lock before wallet
or database access and retain it through final wallet persistence and close. The historical
intent runner uses the same lock, so neither can open the funded wallet concurrently.

Wallet sync is cancellable and checkpoints its state. Capture the authenticated startup point
after sync, then require strictly more than twenty chain and monotonic minutes before sends.
The follower keeps running while the serial controller prepares proofs. Readiness and admission
retry at most three verified forward-head races using identical bytes; policy, clock, restore
and other errors remain refusals. The final reservation stays synchronous.

SIGTERM/SIGINT cancels sync and follower HTTP work, drains both loops, saves/closes the wallet
and closes databases before releasing the lock. A fatal sibling failure follows the same drain
path. Uncertain journal deliveries keep their claims and fee reservations. The unit's stop
timeout is unlimited so an in-flight proof or publication can finish before final
persistence. Ordinary shutdown must not force-kill that work. Never delete the
follower, census, journal or wallet state to clear a hold; repair from independently retained
consistent history. A cold restart must complete its own restore margin again.

Install the reviewed checkout at `~/.local/lib/orynq-midnight-standing/checkout` and a pinned
Node executable at `bin/node` beside it. The supplied user unit reads the private configuration
at `~/.config/orynq-midnight-standing/config.json`. Validate it with `systemd-analyze --user
verify` after installation. The operator enables/starts anchor mode at their own terminal only
after policy publication, two-store readback, independent restore and monitoring checks pass.
Agents must not start an anchor unit or change environment markers to bypass its gate.

`status.json` and journal progress contain public state only. Holds use bounded reason codes;
raw provider errors and credentials are not logged. A hold does not prove absence or coverage.
An independent watch must verify liveness and cap accounting, and alert on cap hits before
the rollout is declared complete. The hard limits remain 0.01 DUST per transaction, 0.1 DUST
per rolling day and one anchor per batch in the immutable approved registry.

The initial operator-approved custody model uses owner-only software keys on existing hosts.
These controls do not isolate agents or root. Hardware tokens and a dedicated admin device
are deferred hardening, separate from the chain-integrity and accounting checks.

## Independent watch

Run the supplied `orynq-midnight-watch.timer` and system service on Node3. The watch uses
strict-known-host SSH to Gemtek's fixed `standing-watch.py --export` command, which reads only
the private public-state snapshot and the standing unit's activity. Gemtek's exporter also
opens the existing follower SQLite database in read-only mode, starts one consistent snapshot,
checks its exact schema and scope, and streams fee rows ordered by transaction hash. It never
initializes or migrates that database, opens a wallet or reads a signer file. The scan has a
ten-second SQLite/iterator deadline and exports only bounded totals and integrity flags;
failure reports unavailable accounting. Install the exporter with the reviewed service
checkout; install the identical watch script at `~/.local/lib/orynq-midnight-watch/standing-watch.py`
on Node3. The timer uses systemd's monotonic interval scheduling, with one poll at a time.

The owner-only `~/.config/orynq-midnight-watch/config.json` has exactly `scope`, `mode`,
`stateFile` and `rpcUrl`. Copy the scope from the verified service status, choose the expected
`observe` or `anchor` mode, use a new private directory for the absolute SQLite `stateFile`,
and set `rpcUrl` to the explicit read-only Midnight RPC endpoint. Keep the same state file
when switching to anchor mode so cap-event history is retained. The service reads the
existing Node3 watchdog environment file for `DISCORD_WEBHOOK_URL`; never copy or print it.

Status snapshots retain monotonically numbered cap episodes, including across restarts and
missed polls. Follower and controller operation starts, completions and meaningful progress
are separate. The Python accounting reader independently unions fee observations and unresolved
reservations by transaction hash, retaining all unknowns, the rolling boundary and conflicts
even on excluded historical records. Status and accounting heads are reported separately;
the accounting snapshot must retain the status head and may have advanced beyond it. This
monitor trusts the owned local follower database; signed transaction decoding, declared-fee
and serialized-TTL validation remain the sender's admission checks. Lifetime financial rows
never enter the service's bounded liveness file or its hot loop. A
separate finalized-head RPC hint detects follower lag; it authorizes no transaction or history.

The durable SQLite outbox retries failed deliveries on later polls and records recovery
transitions. Delivery is at least once: a crash after HTTP acceptance but before persistence
can duplicate an alert. The watch never restarts the signer or removes a hold. A frozen
controller alerts after thirty minutes even if the follower stays healthy; source/history
holds and a frozen follower alert after five minutes. Wallet sync allows its three-hour
deadline plus ten minutes. Catch-up with incomplete accounting cannot establish send readiness.
Prove a real alert/recovery delivery and review the Node3 timer's active state before launch.
