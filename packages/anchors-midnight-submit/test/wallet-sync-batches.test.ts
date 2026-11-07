import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Chunk, Effect, Scope, Stream } from "effect";
import * as L8 from "@midnightntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";
import { SyncService as DustSyncV1 } from "@midnightntwrk/wallet-sdk-dust-wallet/v1";
import { SyncService as DustSyncV2 } from "@midnightntwrk/wallet-sdk-dust-wallet/v2";
import { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { Sync as ShieldedSyncV1 } from "@midnightntwrk/wallet-sdk-shielded/v1";
import { Sync as ShieldedSyncV2 } from "@midnightntwrk/wallet-sdk-shielded/v2";
import { createWalletMnemonicFile } from "../src/keys.js";
import { openWallet, type OperatorWallet } from "../src/wallet.js";
import { liveSource } from "./fakes.js";

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
  it.each(["preprod", "mainnet"] as const)("on %s applies the indexer's events to the shielded and DUST wallets 1000 at a time, under either ledger", async (network) => {
    const init = vi.spyOn(WalletFacade, "init");
    const mnemonicFile = join(dir, `${network}.mnemonic`);
    createWalletMnemonicFile(mnemonicFile);
    opened.push(await openWallet({ network, mnemonicFile, endpoints: OFFLINE, source: liveSource(), zkDir: "/nonexistent" }));
    const facade = await init.mock.results[0]!.value;
    expect(batching(facade.shielded)).toEqual({ size: 1000 });
    expect(batching(facade.dust)).toEqual({ size: 1000 });
  });
});

// Resolve the SDK's own indexer dependency so this behavioral regression exercises the
// installed service's real decoder/groupedWithin pipeline with transport stubbed out.
const sdkEntry = import.meta.resolve("@midnightntwrk/wallet-sdk-dust-wallet");
const indexer = await import(new URL("../../wallet-sdk-indexer-client/dist/index.js", sdkEntry).href);

// A real ledger event of each ledger: the one a contract deploy emits, applied by that ledger.
const eventOf = (L: typeof L8 | typeof L9) => {
  const now = new Date();
  const strictness = new L.WellFormedStrictness();
  strictness.enforceBalancing = false;
  strictness.verifyNativeProofs = false;
  strictness.verifyContractProofs = false;
  const state = L.LedgerState.blank("undeployed");
  const deploy = L.Transaction.fromParts("undeployed", undefined, undefined, L.Intent.new(new Date(now.getTime() + 600e3)).addDeploy(new L.ContractDeploy(new L.ContractState() as never) as never) as never);
  const seconds = BigInt(Math.floor(now.getTime() / 1000));
  const context = new L.TransactionContext(state as never, { secondsSinceEpoch: seconds, secondsSinceEpochErr: 30, parentBlockHash: "00".repeat(32), lastBlockTime: seconds - 6n } as never);
  const [, result] = (state as L9.LedgerState).apply(deploy.eraseProofs().wellFormed(state as never, strictness as never, now) as never, context as never);
  const [event] = result.events;
  if (!event) throw new Error("the deploy emitted no ledger event");
  return Buffer.from(event.serialize()).toString("hex");
};
const raw: Record<8 | 9, string> = { 8: "", 9: "" };
beforeAll(() => {
  raw[8] = eventOf(L8);
  raw[9] = eventOf(L9);
});

type Kind = "dust" | "shielded";
const SERVICES = {
  dust: { 8: DustSyncV1.makeDefaultSyncService, 9: DustSyncV2.makeDefaultSyncService },
  shielded: { 8: ShieldedSyncV1.makeEventsSyncService, 9: ShieldedSyncV2.makeEventsSyncService },
} as const;
for (const kind of ["dust", "shielded"] as const satisfies Kind[]) for (const ledger of [8, 9] as const) describe(`${kind} SDK event grouping under ledger ${ledger}`, () => {
  const service = (batchUpdates: { size: number; timeout?: number; spacing?: number }) => {
    const config = { networkId: "undeployed" as const, indexerClientConnection: { indexerHttpUrl: "http://127.0.0.1:9/graphql", indexerWsUrl: "ws://127.0.0.1:9/graphql/ws" }, batchUpdates };
    return (SERVICES[kind][ledger] as (c: typeof config) => { updates(state: never, keys: never): Stream.Stream<{ updates: ReadonlyArray<{ id: number }> }, unknown, Scope.Scope> })(config);
  };
  const event = (id: number) => kind === "dust"
    ? { dustLedgerEvents: { id, maxId: 1200, raw: raw[ledger], protocolVersion: ledger === 8 ? 1000300 : 2001100 } }
    : { zswapLedgerEvents: { id, maxId: 1200, raw: raw[ledger], protocolVersion: ledger === 8 ? 1000300 : 2001100 } };
  const stub = (events: ReturnType<typeof Stream.fromIterable>) => {
    vi.spyOn(kind === "dust" ? indexer.DustLedgerEvents : indexer.ZswapEvents, "runWithBackpressure").mockReturnValue(events);
  };
  const updates = (batchUpdates: { size: number; timeout?: number; spacing?: number }) =>
    service(batchUpdates).updates({ progress: { appliedIndex: 0n }, protocolVersion: ledger === 8 ? 1000300n : 2001100n } as never, {} as never).pipe(
      Stream.filter((update) => Array.isArray((update as { updates?: unknown }).updates)),
    );
  it("caps a queued catch-up stream at 1,000 decoded events per update", async () => {
    stub(Stream.fromIterable(Array.from({ length: 1200 }, (_, i) => event(i + 1))));
    // A generous timeout isolates the count cap; the following test exercises the real 1ms default.
    const chunks = Chunk.toReadonlyArray(await Effect.runPromise(Effect.scoped(Stream.runCollect(Stream.take(updates({ size: 1000, timeout: 60_000, spacing: 0 }), 2))).pipe(Effect.timeout("20 seconds"))));
    expect(chunks.map((chunk) => chunk.updates.length)).toEqual([1000, 200]);
    expect(chunks.flatMap((chunk) => chunk.updates.map((update) => update.id))).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
  });
  it("flushes a partial group with omitted timeout while the subscription stays open", async () => {
    stub(Stream.concat(Stream.make(event(1)), Stream.never));
    const chunks = Chunk.toReadonlyArray(await Effect.runPromise(Effect.scoped(Stream.runCollect(Stream.take(updates({ size: 1000 }), 1))).pipe(Effect.timeout("5 seconds"))));
    expect(chunks.map((chunk) => chunk.updates.map((update) => update.id))).toEqual([[1]]);
  });
});
