import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Chunk, Effect, Stream, type Scope } from "effect";
import * as L from "@midnightntwrk/ledger-v9";
import { ProtocolVersion } from "@midnightntwrk/wallet-sdk-abstractions";
import { CoreWallet, SyncService as DustSync, Serialization } from "@midnightntwrk/wallet-sdk-dust-wallet/v2";
import { Sync as ShieldedSync } from "@midnightntwrk/wallet-sdk-shielded/v2";
import { NIGHT, dustOnSimulator, run, closeSimulators } from "./simulator.js";

// #199: exercise the installed SDK rather than inferring grouping from its configuration.
// Only transport is substituted; the SDK's default batch spacing is retained. Explicit
// 100/1000ms candidates here do not change openWallet's production timeout. These synthetic
// arrivals and simulator fees establish neither hosted throughput nor a production latency SLA.
const sdkEntry = import.meta.resolve("@midnightntwrk/wallet-sdk-dust-wallet");
const indexer = await import(new URL("../../wallet-sdk-indexer-client/dist/index.js", sdkEntry).href);
const { withBackpressure } = await import(new URL("../../wallet-sdk-indexer-client/dist/effect/Backpressure.js", sdkEntry).href);
type Kind = "dust" | "shielded";
type Row = { dustLedgerEvents: { id: number; maxId: number; raw: string; protocolVersion: number } } | { zswapLedgerEvents: { id: number; maxId: number; raw: string; protocolVersion: number } };
type Update = { updates: ReadonlyArray<{ id: number; maxId: number }> };
let rawEvents: string[], secretKey: L.DustSecretKey, timestamp: Date;
let fixture: Awaited<ReturnType<typeof dustOnSimulator>>;
const metrics: object[] = [];
beforeAll(async () => {
  fixture = await dustOnSimulator(Array.from({ length: 8 }, () => NIGHT));
  const state = await run(fixture.simulator.getLatestState());
  // Serialize once before the first replay: ledger event WASM values are consumed by replay.
  rawEvents = state.blocks.flatMap(block => block.transactions.flatMap(transaction => transaction.result.events.map(event => Buffer.from(event.serialize()).toString("hex"))));
  if (rawEvents.length < 2) throw new Error("simulator did not produce distinct replay events");
  secretKey = fixture.secretKey; timestamp = state.currentTime;
});
afterAll(async () => {
  await closeSimulators();
  process.stdout.write(`wallet timeout measurements ${JSON.stringify(metrics)}\n`);
});
afterEach(() => vi.restoreAllMocks());

// Ledger 9's protocol version on mainnet, which every event below carries.
const LEDGER9 = 2001100;
const ACTIVE = [ProtocolVersion.MinSupportedVersion, ProtocolVersion.MaxSupportedVersion] as never;
const events = (updates: ReadonlyArray<{ id: number; maxId: number; raw: string; protocolVersion: number }>) => ({ _tag: "Events" as const, updates: [...updates], secretKey, timestamp });
const service = (kind: Kind, timeout: number) => {
  const config = { networkId: "undeployed" as const, indexerClientConnection: { indexerHttpUrl: "http://127.0.0.1:9/graphql", indexerWsUrl: "ws://127.0.0.1:9/graphql/ws" }, batchUpdates: { size: 1000, timeout } };
  return kind === "dust" ? DustSync.makeDefaultSyncService(config) : ShieldedSync.makeEventsSyncService(config);
};
const row = (kind: Kind, id: number, maxId: number): Row => kind === "dust"
  ? { dustLedgerEvents: { id, maxId, raw: rawEvents[0]!, protocolVersion: LEDGER9 } }
  : { zswapLedgerEvents: { id, maxId, raw: rawEvents[0]!, protocolVersion: LEDGER9 } };
const stub = (kind: Kind, stream: Stream.Stream<Row>) => {
  vi.spyOn(kind === "dust" ? indexer.DustLedgerEvents : indexer.ZswapEvents, "runWithBackpressure").mockReturnValue(stream);
};
// The event batches of a service's updates; the SDK merges in its chain-version watch, whose
// signals carry no events.
const eventsOf = (stream: Stream.Stream<unknown, unknown, Scope.Scope>) => stream.pipe(Stream.filter((update): update is Update => Array.isArray((update as { updates?: unknown }).updates)));
const updates = (kind: Kind, timeout: number): Stream.Stream<Update, unknown, Scope.Scope> =>
  eventsOf((service(kind, timeout) as { updates(state: never, keys: never): Stream.Stream<unknown, unknown, Scope.Scope> }).updates({ progress: { appliedIndex: 0n }, protocolVersion: BigInt(LEDGER9) } as never, secretKey as never));
const collect = <A, E>(stream: Stream.Stream<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(Stream.runCollect(stream)).pipe(Effect.timeout("10 seconds"))).then(Chunk.toReadonlyArray);

for (const kind of ["dust", "shielded"] as const) describe(`${kind} staggered SDK batching`, () => {
  it("coalesces staggered arrivals with 100ms/1000ms while preserving every event and the size cap", async () => {
    const counts = new Map<number, number>();
    for (const timeout of [1, 100, 1000]) {
      const source = Stream.fromIterable(Array.from({ length: 12 }, (_, i) => i + 1)).pipe(
        Stream.mapEffect(id => Effect.sleep("20 millis").pipe(Effect.as(row(kind, id, 12)))),
        Stream.concat(Stream.never),
      );
      stub(kind, source);
      const groups = await collect(updates(kind, timeout).pipe(Stream.takeUntil(update => update.updates.at(-1)?.id === 12)));
      expect(groups.flatMap(group => group.updates.map(update => update.id))).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect(groups.every(group => group.updates.length <= 1000)).toBe(true);
      counts.set(timeout, groups.length); vi.restoreAllMocks();
    }
    expect(counts.get(100)!).toBeLessThan(counts.get(1)!);
    expect(counts.get(1000)).toBe(1);
    metrics.push({ scenario: `${kind}-12-events-20ms`, batches: Object.fromEntries(counts) });
  });

  it.each([100, 1000])("flushes a lone event on an open subscription with a bounded %ims sync-gate delay", async timeout => {
    let arrival = 0;
    stub(kind, Stream.make(row(kind, 1, 1)).pipe(Stream.tap(() => Effect.sync(() => { arrival = performance.now(); })), Stream.concat(Stream.never)));
    const [group] = await collect(updates(kind, timeout).pipe(Stream.take(1)));
    const latency = performance.now() - arrival;
    expect(group!.updates.map(update => update.id)).toEqual([1]);
    expect(latency).toBeGreaterThanOrEqual(timeout / 2);
    // Broad scheduler allowance: this detects a missing timeout without being a CPU benchmark.
    expect(latency).toBeLessThan(timeout + 2000);
    metrics.push({ scenario: `${kind}-steady-state-sync-gate`, timeout, latencyMs: Math.round(latency) });
  });
});

describe("DUST replay and backlog bounds", () => {
  it("produces byte-identical serialized state and progress after whole, split, and single-event replays", () => {
    const apply = (sizes: number[]) => {
      let wallet = CoreWallet.initEmpty(L.LedgerParameters.initialParameters().dust, secretKey, "undeployed");
      const capability = DustSync.makeDefaultSyncCapability();
      let offset = 0;
      for (const size of sizes) {
        const chunk = rawEvents.slice(offset, offset + size).map((raw, i) => ({ id: offset + i + 1, maxId: rawEvents.length, raw, protocolVersion: LEDGER9 }));
        [wallet] = capability.applyUpdate(wallet, events(chunk), ACTIVE); offset += size;
      }
      expect(offset).toBe(rawEvents.length);
      return { bytes: Buffer.from(wallet.state.serialize()).toString("hex"), applied: wallet.progress.appliedIndex, highest: wallet.progress.highestRelevantWalletIndex, connected: wallet.progress.isConnected };
    };
    const whole = apply([rawEvents.length]);
    expect(apply([1, rawEvents.length - 1])).toEqual(whole);
    expect(apply(rawEvents.map(() => 1))).toEqual(whole);
    expect(whole.applied).toBe(BigInt(rawEvents.length));
  });

  it.each([100, 1000])("measures an offline fee after the last outstanding event flushes at %ims", async timeout => {
    const capability = DustSync.makeDefaultSyncCapability();
    let state = CoreWallet.initEmpty(L.LedgerParameters.initialParameters().dust, secretKey, "undeployed");
    const prefix = rawEvents.slice(0, -1).map((raw, i) => ({ id: i + 1, maxId: rawEvents.length, raw, protocolVersion: LEDGER9 }));
    [state] = capability.applyUpdate(state, events(prefix), ACTIVE);
    expect(state.progress.isStrictlyComplete()).toBe(false);
    let arrival = 0;
    stub("dust", Stream.make({ dustLedgerEvents: { id: rawEvents.length, maxId: rawEvents.length, raw: rawEvents.at(-1)!, protocolVersion: LEDGER9 } }).pipe(Stream.tap(() => Effect.sync(() => { arrival = performance.now(); })), Stream.concat(Stream.never)));
    const stream = eventsOf(DustSync.makeDefaultSyncService({ networkId: "undeployed", indexerClientConnection: { indexerHttpUrl: "http://127.0.0.1:9/graphql", indexerWsUrl: "ws://127.0.0.1:9/graphql/ws" }, batchUpdates: { size: 1000, timeout } }).updates(state, secretKey));
    const [last] = await collect(stream.pipe(Stream.take(1)));
    [state] = capability.applyUpdate(state, { ...(last as object), timestamp } as never, ACTIVE);
    expect(state.progress.isStrictlyComplete()).toBe(true);
    const synchronized = performance.now();
    // Real SDK fee selection/balancing and simulator proving, with fresh ephemeral keys.
    // This excludes hosted transport/prover latency and does not send to any external chain.
    const wallet = await fixture.restored(Serialization.makeDefaultV2SerializationCapability().serialize(state));
    const fee = await fixture.balanced(wallet);
    expect([...fee.intents!.values()].some(intent => (intent.dustActions?.spends.length ?? 0) > 0)).toBe(true);
    metrics.push({ scenario: "dust-steady-state-simulator-fee", timeout, gateMs: Math.round(synchronized - arrival), balanceAndProveMs: Math.round(performance.now() - synchronized), totalMs: Math.round(performance.now() - arrival) });
  });

  it.each([100, 1000])("retains a bounded backlog during slow catch-up with the real SDK backpressure and %ims timeout", async timeout => {
    const total = 24_000, bufferSize = 10_000;
    let applied = 0, produced = 0, highWater = 0, sessions = 0;
    const source = ({ variables, onItem, onComplete }: { variables: { id: number | null }; onItem(value: Row): void; onComplete(): void }) => {
      sessions++; let disposed = false, next = Math.max(variables.id ?? 0, 0) + 1;
      const push = () => {
        if (disposed) return;
        for (let count = 0; count < bufferSize + 1000 && next <= total && !disposed; count++, next++) {
          produced++; highWater = Math.max(highWater, produced - applied); onItem(row("dust", next, total));
        }
        if (next > total && !disposed) onComplete();
        else if (!disposed) setImmediate(push);
      };
      setImmediate(push);
      return () => { disposed = true; };
    };
    // Exercise the real installed push queue and pause/resume state machine, not a pull-only fake.
    vi.spyOn(indexer.DustLedgerEvents, "runWithBackpressure").mockImplementation((options: unknown) => {
      const limits = options as { bufferSize: number; resumeThreshold: number };
      expect(limits.bufferSize).toBe(bufferSize); expect(limits.resumeThreshold).toBe(100);
      return withBackpressure(source, options);
    });
    const seen: number[] = [];
    // Allow CPU contention headroom for the full 24,000-event backlog check.
    await Effect.runPromise(Effect.scoped(Stream.runForEach(updates("dust", timeout), group => Effect.gen(function* () {
      yield* Effect.sleep("2 millis");
      seen.push(...group.updates.map(update => update.id)); applied += group.updates.length;
    }))).pipe(Effect.timeout("60 seconds")));
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(sessions).toBeGreaterThan(1);
    // One paused push queue plus bounded current/prefetched groups. This is a retained-event
    // bound for this SDK pipeline; it is not a bound on ledger-state size or transport bytes.
    expect(highWater).toBeLessThanOrEqual(bufferSize + 3 * 1000);
    metrics.push({ scenario: "dust-slow-catch-up", timeout, total, bufferSize, highWater, sessions });
  });
});
