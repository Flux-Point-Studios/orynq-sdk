# Claude Code orynq hook — reference example

A thin Claude Code `PostToolUse` hook + systemd drain daemon that anchors
**every completed task** to Materios preprod as a certified receipt.
Reference consumer of `@fluxpointstudios/orynq-sdk-anchors-materios`.
Survives session crashes, reboots, and multi-day Claude Code sessions.

Throughout this README, `<INSTALL_DIR>` refers to wherever you place a
copy of this directory on the operator's machine — e.g.
`/home/alice/orynq-sdk/examples/claude-code-hook` or
`/opt/materios-orynq-hook` after a manual copy.

## Architecture (per-task drain — current)

```
PostToolUse(TaskUpdate, completed)
        |
        v
   hook.mjs                                queue/<ts>-task-<id>.json
   (atomic write, <10ms)            ----> (one bundle per task)
                                            |
                                            v
                                       drain.mjs (systemd unit)
                                            |
                                       submitCertifiedReceipt
                                            |
                            success: queue/ -> done/
                            failure: queue/ -> failed/ + .error.txt
```

The hook does NOT import the orynq SDK and does NOT touch the network — it
just drops one self-contained bundle in `queue/` and exits. The drain daemon
runs separately under systemd, watches `queue/` via `fs.watch` (with a 5 s
poll fallback), and submits one receipt per file.

`SessionEnd` is now a **no-op** — the per-task drain replaces the old
session-end batching that was vulnerable to lost work on crash.

## Components

| File | Role |
|---|---|
| `hook.mjs` | Claude Code hook entrypoint. Writes one queue file per `TaskUpdate(completed)`. |
| `drain.mjs` | Long-running daemon. Watches `queue/`, submits each entry to Materios. |
| `flush-session.mjs` | One-shot recovery script for legacy `<sessionId>.json` event accumulators. |
| `materios-orynq-drain.service` | systemd unit (copied to `/etc/systemd/system/`). |

## State layout

```
~/.local/state/materios-orynq-hook/
  queue/                    pending bundles (drain reads these)
  done/                     successfully submitted (annotated with receipt info)
  failed/                   submit failures (with sibling .error.txt)
  <sessionId>.json          legacy event accumulator (flush-session.mjs reads)
  <sessionId>.flushed       marker; flush-session refuses to re-run
~/materios-orynq-hook/drain.log    daemon stdout+stderr (systemd-managed)
```

## Queue entry shape

```json
{
  "schemaVersion": "queue/1.0",
  "contentHash": "<sha256-hex>",
  "rootHash":    "<sha256-hex>",
  "manifestHash":"<sha256-hex>",
  "publicView": {
    "taskId": "...", "subject": "...", "sessionId": "...",
    "timestamp": "...", "summary": "...", "cwd": "...", "hostname": "..."
  },
  "raw": { /* original PostToolUse payload */ }
}
```

`rootHash` is `sha256({sessionId, taskId, timestamp, subject, summary})` —
deterministic, so retries land the same anchor (idempotent at chain level).

## Install / restart sequence

1. **Install systemd unit** (one-time):
   ```bash
   sudo cp <INSTALL_DIR>/materios-orynq-drain.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now materios-orynq-drain
   ```
2. **Tail the log**:
   ```bash
   tail -f <INSTALL_DIR>/drain.log
   ```
3. **Recover legacy session events** (one-time, for the 6-day session that
   accumulated 54 events in memory before the drain landed):
   ```bash
   # dry-run first
   node <INSTALL_DIR>/flush-session.mjs --dry-run
   # then write
   node <INSTALL_DIR>/flush-session.mjs
   ```
   The drain daemon will pick up the queue files automatically.

## Config (`~/.materios-orynq-hook.env`, 0600)

| Var | Default | Purpose |
|---|---|---|
| `MATERIOS_RPC_URL` | (unset) | Substrate WS RPC. Drain refuses to start without this. |
| `MATERIOS_SIGNER_URI` | (unset) | `//Alice` or 12/15/24-word mnemonic. |
| `MATERIOS_BLOB_GATEWAY_URL` | `https://materios.fluxpointstudios.com/preprod-blobs` | Blob upload endpoint. |
| `MATERIOS_BLOB_GATEWAY_API_KEY` | (unset) | Gateway auth; falls back to sr25519-sig when absent. |
| `ORYNQ_NO_AUTO_TRACE` | (unset) | `1` disables the hook entirely. |
| `ORYNQ_HOOK_ENV` | `~/.materios-orynq-hook.env` | Override env-file path. |
| `ORYNQ_SDK_PATH` | `/tmp/orynq-sdk` | Override orynq-sdk repo location. |
| `ORYNQ_DRAIN_DRY_RUN` | (unset) | Drain daemon: `1` skips network call, just moves files. |
| `ORYNQ_DRAIN_POLL_MS` | `5000` | Drain daemon: poll-fallback interval. |
| `ORYNQ_FLUSH_DRY_RUN` | (unset) | flush-session: `1` counts events without writing. |

## Backoff / failure modes

- `submitCertifiedReceipt` timeout is 90 s per attempt (was 180 s in the old
  hook — drain retries on next-loop iteration so a single tight timeout is
  fine).
- After **3 consecutive submit failures** the daemon disconnects the
  Materios provider and sleeps 60 s (catches WS-wedge cases like the
  RPC-cap exhaustion we saw 2026-04-25).
- Failed entries land in `failed/` with `.error.txt`; you can move them
  back to `queue/` after a fix to retry.

## Redaction (hook-side)

Before bundles hit the queue, these shapes are stripped from the summary:

- `xpub…` BIP32 extended keys
- `(mnemonic|seed phrase|private key|api key|signer uri) <value>` labels
- Bare 64-char hex (likely seeds / root hashes)
- 12+ consecutive 3–8-char lowercase word chunks (BIP39-shaped)

Summaries are truncated to 1800 chars; subjects to 200.

## Smoke tests

```bash
# 1. Hook writes a queue file
echo '{"hook_event_name":"PostToolUse","session_id":"smoke","tool_name":"TaskUpdate","tool_input":{"taskId":"1","status":"completed","subject":"test"}}' \
  | node <INSTALL_DIR>/hook.mjs
ls ~/.local/state/materios-orynq-hook/queue/

# 2. Drain processes without network (dry-run)
ORYNQ_DRAIN_DRY_RUN=1 node <INSTALL_DIR>/drain.mjs &
DRAIN=$!
sleep 3
kill $DRAIN
ls ~/.local/state/materios-orynq-hook/done/   # smoke-* should appear here
```

## Opt-out

- Per-launch: `ORYNQ_NO_AUTO_TRACE=1 claude`
- Permanent: remove the `hooks` block from `~/.claude/settings.json`.
- Anchor-only: `sudo systemctl stop materios-orynq-drain` — the hook keeps
  queueing locally, nothing hits chain.

## Why per-task instead of per-session

The pre-2026-05-04 hook batched a session's spans into one finalize-on-end
receipt. That's vulnerable: this very Gemtek session ran 6 days with 54
unanchored task closures. A SIGKILL would have lost them all.

Per-task means:
- One anchor per closure → no batching latency.
- File-system durability → survives crash, reboot, daemon restart.
- Idempotent rootHash → re-running flush is safe.

The cost is more chain receipts (54 vs 1 for that session), which is
acceptable given current preprod throughput.

## Known limits

- Redaction is heuristic. For high-sensitivity repos, set
  `ORYNQ_NO_AUTO_TRACE=1` or stop the drain daemon.
- `orynq-sdk` must be built locally at `/tmp/orynq-sdk`. Rebuild with
  `pnpm -r build` if `dist/` is stale.
- Drain is sequential by design. With cert-daemon throttling this is fine
  even at 100 task closures/hour.

## Upstream plan

Still aimed at `@orynq/claude-hook`. The drain daemon shape is the
prototype for the SDK package — see
`~/.claude/projects/-home-deci/memory/project_orynq_auto_trace_plan.md`.
