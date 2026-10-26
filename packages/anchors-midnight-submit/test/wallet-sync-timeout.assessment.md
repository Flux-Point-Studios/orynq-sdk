# Wallet collection timeout assessment (#199)

Production remains unchanged: `openWallet` supplies `size: 1000`, and the pinned SDK uses its
1 ms default timeout. The candidates below are explicit test configuration, not a production
option or recommendation to change the default.

Run without a provider, credentials or funds:

```sh
pnpm --dir packages/anchors-midnight-submit exec vitest run test/wallet-sync-timeout.test.ts --maxWorkers=1
```

The test uses the installed DUST 4.2.0 / shielded SDK decoder and `groupedWithin` pipeline,
retaining default batch spacing. It substitutes transport and generates fresh ledger events
and ephemeral keys with the real SDK simulator. A successful 2026-10-26 run measured:

| Observation | 1 ms | 100 ms | 1,000 ms |
| --- | ---: | ---: | ---: |
| DUST: 12 arrivals, spaced 20 ms apart | 12 batches | 3 batches | 1 batch |
| Shielded: same arrival pattern | 12 batches | 3 batches | 1 batch |
| DUST: single event on an open subscription | — | 108 ms | 1,010 ms |
| Shielded: single event on an open subscription | — | 105 ms | 1,286 ms |
| DUST: final outstanding event through simulator fee completion | — | 278 ms | 1,139 ms |

The last row includes actual patched SDK fee selection/balancing and simulator proving, after
strict progress becomes complete. Its components were 177 + 101 ms and 1,084 + 55 ms. It
excludes hosted node/prover latency and does not invoke a live `payFee`/submit path. These are
single-run observations under shared host load, not latency guarantees or provider benchmarks.

Whole, split and single-event application of eight distinct simulator registration events
produced identical serialized DUST state and progress. Each replay deserializes its own WASM
event values; consumed event handles are never reused.

For each candidate, a slow-consumer replay of 24,000 events used the SDK's real backpressure
wrapper with its actual default 10,000-event queue. The queue paused/resumed three times,
retained at most 12,000 produced-but-unapplied events across the pipeline, and preserved every
ID in order. The test allows at most the queue plus three bounded 1,000-event groups. This
measures retained event count under a cooperative disposed transport, not process RSS, WASM
heap retention, maximum event byte size or ledger-state growth. It does not claim a memory
bound independent of those sizes.

The measurements support testing an explicit `batchUpdates: { size: 1000, timeout: 100 }`
through the SDK in an isolated rehearsal. They do not justify changing production by
themselves: realistic provider bursts, concurrent shielded/DUST application stalls, heap/RSS
behavior over a long replay, and end-to-end steady-state fee latency still need observation.
Keep the size cap and `isStrictlyComplete()` fee gate. #199 remains open for that operational
evidence and a reviewed production configuration decision.
