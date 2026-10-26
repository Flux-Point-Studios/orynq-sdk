# Authenticated checkpoint maintenance

The CTO/repository maintainers own checkpoint acceptance; the CI operator owns the
weekly schedule, credentials and failed-run response. Schedule Woodpecker's
`checkpoint-weekly` cron at `0 4 * * 1` UTC and review its proposal within seven days.
An accepted successor must be published at least every 30 days. Check the last
successful reviewed merge weekly; a missed run is an operational incident.

Each portable artifact records a bounded GRANDPA proof/header transcript. The SDK
replays it against its pinned predecessor and requires the derived authority set,
start hash, network, root identity, sequence and previous-artifact digest to match.
CI also verifies the finalized target's runtime/storage proof and requires a fresh
authenticated timestamp. An RPC hint or CI signature cannot replace this chain.

The original signed checkpoint policy remains the durable follower identity.
Verified descendants are append-only acceleration state, with a renewed bounded
finality allowance at each authenticated step. Intermediate steps remain available
for historical replay. Author-policy serial/revocation checks continue independently.
Root replacement, network bootstrap and edits to the original signed checkpoint list
remain separate trust changes and fail closed. Do not delete state to accept them.

## Activate reviewed CI

1. Review `.woodpecker/checkpoint-maintenance.yaml` and its pinned publisher. The
   repository's existing all-events approval policy remains in place. PR jobs replay
   history without credentials or network writes. Main-branch cron/manual jobs derive
   and replay a candidate before the publication step receives its token.
2. Configure `checkpoint_review_token`: a repository-scoped GitHub token with contents
   and pull-request write permissions, no administration or workflow permission.
   Exclude PR events and restrict its image/context to the reviewed publication step
   as supported by the CI server. That step removes Node preload settings, verifies
   the publisher's source digest and executes the verified byte snapshot with Node
   builtins only. Package install/build code never receives this credential.
3. Enable `checkpoint-weekly` with the UTC schedule above. Run it manually once on
   main and review its candidate-specific PR. The publisher refuses prefix loss
   against current main, uses immutable candidate branches, never force-updates main
   and never merges its proposal. Keep failed runs held and investigate source quota,
   freshness and predecessor evidence. No step needs a wallet, signing key or DUST.

Missing hosted credentials or scheduling is an activation blocker. Committing the
workflow does not establish that the hosted job ran or published.

## Reproduce without publication credentials

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec tsx packages/anchors-midnight/scripts/checkpoint-advance.ts derive \
  --network mainnet \
  --node https://midnight-proofs-a.fluxpointstudios.com/midnight/mainnet/rpc \
  --history docs/checkpoints/mainnet.json --out /private/new-checkpoint-history.json
corepack pnpm exec tsx packages/anchors-midnight/scripts/checkpoint-advance.ts verify \
  --network mainnet --history /private/new-checkpoint-history.json
node --test tools/checkpoint-maintenance/publish.test.mjs
```

`--out` must be new and distinct from the input. Verification needs no endpoint or
credential. Replay from a clean checkout; check the accepted prefix, pinned original
root, consecutive sequence/digest links and a newer target. A network without a
pinned predecessor requires independent root onboarding, not this maintenance path.

## Deploy without discarding retained history

Stop the standing service normally. Take a coherent backup of its entire state root,
wallet checkpoint, journals and retained stores. Use SQLite snapshot/backup tooling
or stop every writer; copying a live DB without its WAL is not coherent. Preserve
permissions and ownership.

Install the reviewed full history as owner-only
`<stateRoot>/checkpoint-history.json`, using a temporary file and atomic rename on
the same filesystem. Restart the v3-capable service. Before controller initialization
it replays each advancement and atomically extends `follower_checkpoints`. It refuses
prefix loss, fork, rollback, changed original scope, missing coverage/attempt/admission
references and inconsistent restore. Every other follower table remains unchanged.
Census storage, journal claims, wallet fee reservations, status scope and monitoring
cap sequence are not rewritten. Startup freshness, restore warmup and admission
checks still apply before any new send.

Check bounded `standing-startup` diagnostics and ordinary progress. Startup has a
distance-sized ceiling of 45 minutes, 760 HTTP requests and 64 MiB. Normal turns stay
at 90 seconds, 256 requests and 64 MiB. Recoverable startup failures enter a five-second
retry hold instead of racing systemd restarts. Policy continuity failures requiring
a process restart remain fatal. SIGINT/SIGTERM cancel/drain requests and use the
existing wallet/journal cleanup.

## Interruption, restore and rollback

The additive schema-v3 upgrade and each extension are SQLite transactions. A crash
before commit retains the prior complete extension and accounting rows. Replaying
the same full history is idempotent. Tests kill a real process immediately before
commit and verify recovery. Never invent missing attempts/admissions or fees from
a journal's or indexer's word.

Disable the cron/token to stop publication while retaining accepted history. Never
revert that prefix or delete databases. A schema-v2-only binary cannot open v3 state;
do not use it as a data downgrade. Roll forward with a v3-compatible fix, or restore
all related stores from one coherent backup and authenticate the missing suffix.
Unknown journal claims or inconsistent policy/admission history stay held for review.

Bounds are explicit: 64 MiB per artifact, 4,096 artifacts and 512 MiB retained history;
the GitHub proposal publisher limits its file to 16 MiB. A bound stops maintenance
without pruning anything. A reviewed archival/format upgrade is required before
raising a bound or retiring evidence.
