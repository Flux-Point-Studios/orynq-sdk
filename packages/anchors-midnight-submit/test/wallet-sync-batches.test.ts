import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Stream, Chunk, type Scope } from "effect";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { createWalletMnemonicFile } from "../src/keys.js";
import { openWallet, type OperatorWallet } from "../src/wallet.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-wallet-sync-batches-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const OFFLINE = { operator: "offline", indexer: "http://127.0.0.1:9/graphql", indexerWs: "ws://127.0.0.1:9/graphql/ws", node: "http://127.0.0.1:9", headers: {} };

const opened: OperatorWallet[] = [];
afterEach(async () => {
  for (const wallet of opened.splice(0)) await wallet.close();
  vi.restoreAllMocks();
});

// The batching each sub-wallet's sync reads: the configuration its class was built with.
const batching = (subWallet: object) => (subWallet.constructor as unknown as { configuration: { batchUpdates?: unknown } }).configuration.batchUpdates;

describe("the wallet's sync", () => {
  it.each(["preprod", "mainnet"] as const)("on %s applies the indexer's events to the shielded and DUST wallets 1000 at a time", async (network) => {
    const init = vi.spyOn(WalletFacade, "init");
    const mnemonicFile = join(dir, `${network}.mnemonic`);
    createWalletMnemonicFile(mnemonicFile);
    opened.push(await openWallet({ network, mnemonicFile, endpoints: OFFLINE, source: undefined as never, zkDir: "/nonexistent" }));
    const facade = await init.mock.results[0]!.value;
    expect(batching(facade.shielded)).toEqual({ size: 1000 });
    expect(batching(facade.dust)).toEqual({ size: 1000 });
  });
});

// Resolve the SDK's own indexer dependency so this behavioral regression exercises the
// installed service's real decoder/groupedWithin pipeline with transport stubbed out.
const sdkEntry = import.meta.resolve("@midnight-ntwrk/wallet-sdk-dust-wallet");
const indexer = await import(new URL("../../wallet-sdk-indexer-client/dist/index.js", sdkEntry).href);
const { SyncService: DustSync } = await import("@midnight-ntwrk/wallet-sdk-dust-wallet/v1");
const { Sync: ShieldedSync } = await import("@midnight-ntwrk/wallet-sdk-shielded/v1");
const { NIGHT, dustOnSimulator, run, closeSimulators } = await import("./simulator.js");
const { beforeAll } = await import("vitest");
let rawEvent: string;
beforeAll(async () => {
  const { simulator } = await dustOnSimulator([NIGHT]);
  const state = await run(simulator.getLatestState());
  const event = state.blocks.flatMap(block => block.transactions.flatMap(transaction => transaction.result.events))[0];
  if (!event) throw new Error("simulator did not produce a real ledger event");
  rawEvent = Buffer.from(event.serialize()).toString("hex");
});
afterAll(closeSimulators);

for (const kind of ["dust", "shielded"] as const) describe(`${kind} actual SDK event grouping`, () => {
  const service = (batchUpdates: { size: number; timeout?: number; spacing?: number }) => {
    const config = { networkId: "undeployed" as const, indexerClientConnection: { indexerHttpUrl: "http://127.0.0.1:9/graphql", indexerWsUrl: "ws://127.0.0.1:9/graphql/ws" }, batchUpdates };
    return kind === "dust" ? DustSync.makeDefaultSyncService(config) : ShieldedSync.makeEventsSyncService(config);
  };
  const event = (id: number) => kind === "dust"
    ? { dustLedgerEvents: { id, maxId: 1200, raw: rawEvent } }
    : { zswapLedgerEvents: { id, maxId: 1200, raw: rawEvent, protocolVersion: 1 } };
  const stub = (events: ReturnType<typeof Stream.fromIterable>) => {
    vi.spyOn(kind === "dust" ? indexer.DustLedgerEvents : indexer.ZswapEvents, "runWithBackpressure").mockReturnValue(events);
  };
  const updates = (batchUpdates: { size: number; timeout?: number; spacing?: number }): Stream.Stream<{ updates: ReadonlyArray<{ id: number }> }, unknown, Scope.Scope> =>
    service(batchUpdates).updates({ progress: { appliedIndex: 0n } } as never, {} as never);
  it("caps a queued catch-up stream at 1,000 decoded events per update", async () => {
    stub(Stream.fromIterable(Array.from({ length: 1200 }, (_, i) => event(i + 1))));
    // A generous timeout isolates the count cap; the following test exercises the real 1ms default.
    const chunks = Chunk.toReadonlyArray(await Effect.runPromise(Effect.scoped(Stream.runCollect(updates({ size: 1000, timeout: 60_000, spacing: 0 })))));
    expect(chunks.map(chunk => chunk.updates.length)).toEqual([1000, 200]);
    expect(chunks.flatMap(chunk => chunk.updates.map(update => update.id))).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
  });
  it("flushes a partial group with omitted timeout while the subscription stays open", async () => {
    stub(Stream.concat(Stream.make(event(1)), Stream.never));
    const chunks = Chunk.toReadonlyArray(await Effect.runPromise(Effect.scoped(Stream.runCollect(Stream.take(updates({ size: 1000 }), 1))).pipe(Effect.timeout("2 seconds"))));
    expect(chunks.map(chunk => chunk.updates.map(update => update.id))).toEqual([[1]]);
  });
});
