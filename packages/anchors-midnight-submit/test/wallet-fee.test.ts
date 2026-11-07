import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as L from "@midnightntwrk/ledger-v8";
import { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { BehaviorSubject } from "rxjs";
import { createWalletMnemonicFile } from "../src/keys.js";
import { DEFAULT_COST_PARAMETERS, costParametersOf, largestCoinFirst, openWallet, type OperatorWallet } from "../src/wallet.js";
import { V1Builder } from "@midnightntwrk/wallet-sdk-dust-wallet/v1";
import { V2Builder } from "@midnightntwrk/wallet-sdk-dust-wallet/v2";
import { facadeSyncedTo, liveSource } from "./fakes.js";
import type { MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import * as L9 from "@midnightntwrk/ledger-v9";
import { ProtocolVersion, WalletTransaction } from "@midnightntwrk/wallet-sdk-abstractions";
import { Either } from "effect";

const dir = mkdtempSync(join(tmpdir(), "orynq-wallet-fee-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const OFFLINE = { operator: "offline", indexer: "http://127.0.0.1:9/graphql", indexerWs: "ws://127.0.0.1:9/graphql/ws", node: "http://127.0.0.1:9", headers: {} };

const opened: OperatorWallet[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const wallet of opened.splice(0)) await wallet.close();
  vi.restoreAllMocks();
});

// test/dust-fees.test.ts measures the order on the SDK's ledger 9 simulator.
describe("the wallet's DUST coin order", () => {
  it("is largest first under either ledger", async () => {
    const v1 = vi.spyOn(V1Builder.prototype, "withCoinSelection");
    const v2 = vi.spyOn(V2Builder.prototype, "withCoinSelection");
    const mnemonicFile = join(dir, "coin-order.mnemonic");
    createWalletMnemonicFile(mnemonicFile);
    opened.push(await openWallet({ network: "preprod", mnemonicFile, endpoints: OFFLINE, source: liveSource(), zkDir: "/nonexistent" }));
    for (const spy of [v1, v2]) {
      const selections = spy.mock.calls.map(([coinSelection]) => (coinSelection as (config: never, context: never) => unknown)({} as never, (() => ({})) as never));
      expect(selections.at(-1)).toBe(largestCoinFirst);
    }
  });

  it("picks the largest coin with any value", () => {
    const coin = (value: bigint) => ({ value }) as never;
    const [small, large, empty] = [coin(5n), coin(9n), coin(0n)];
    expect(largestCoinFirst([small, large, empty])).toBe(large);
    expect(largestCoinFirst([empty])).toBeUndefined();
  });
});

// A fee computed as 0 is balanced with no DUST spend, which pays nothing once the node prices the
// transaction above 0; 1 SPECK of overhead keeps a DUST spend on every fee.
describe("the wallet's fee overhead", () => {
  it("is 1 SPECK unless the caller sets more", () => {
    expect(DEFAULT_COST_PARAMETERS.additionalFeeOverhead).toBe(1n);
    expect(costParametersOf(undefined)).toEqual(DEFAULT_COST_PARAMETERS);
    expect(costParametersOf({ additionalFeeOverhead: 5n, feeBlocksMargin: 3 })).toEqual({ additionalFeeOverhead: 5n, feeBlocksMargin: 3 });
  });

  it("is refused at 0, before the wallet reads its mnemonic", async () => {
    expect(() => costParametersOf({ additionalFeeOverhead: 0n, feeBlocksMargin: 5 })).toThrow(/additionalFeeOverhead must be at least 1 SPECK, not 0: a fee computed as 0 carries no DUST spend and pays nothing/);
    await expect(
      openWallet({ network: "preprod", mnemonicFile: "/nonexistent/wallet.mnemonic", endpoints: undefined as never, source: liveSource(), zkDir: "/nonexistent", costParameters: { additionalFeeOverhead: 0n, feeBlocksMargin: 5 } }),
    ).rejects.toThrow(/additionalFeeOverhead must be at least 1 SPECK/);
  });
});

// A wallet over no indexer whose facade reports `states` and balances every fee as nothing.
async function walletSyncedTo(initial: ReturnType<typeof facadeSyncedTo>, source: MidnightSource = liveSource()) {
  const mnemonicFile = join(dir, `${opened.length}-${Math.random().toString(16).slice(2)}.mnemonic`);
  createWalletMnemonicFile(mnemonicFile);
  const states = new BehaviorSubject(initial);
  vi.spyOn(WalletFacade.prototype, "state").mockReturnValue(states as never);
  const balanced = vi.spyOn(WalletFacade.prototype, "balanceUnboundTransaction").mockImplementation(async (tx) => ({ type: "UNBOUND_TRANSACTION", protocolVersion: tx.protocolVersion, baseTransaction: tx, balancingTransaction: undefined }));
  const wallet = await openWallet({ network: "preprod", mnemonicFile, endpoints: OFFLINE, source, zkDir: "/nonexistent" });
  opened.push(wallet);
  const pay = () => {
    const ttl = new Date(Date.now() + 15 * 60_000);
    return wallet.payFee(L.Transaction.fromParts("preprod", undefined, undefined, L.Intent.new(ttl)).mockProve() as never, ttl);
  };
  const pay9 = () => {
    const ttl = new Date(Date.now() + 15 * 60_000);
    return wallet.payFee(L9.Transaction.fromParts("preprod", undefined, undefined, L9.Intent.new(ttl)).mockProve() as never, ttl);
  };
  return { wallet, states, balanced, pay, pay9 };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// A fee's DUST spend is dated at the newest DUST event the wallet applied: with only part of that
// block's events applied, the wallet's DUST trees match no state the chain ever held.
describe("paying a fee", () => {
  it("waits until the wallet has applied every DUST event the indexer announced", async () => {
    // Restored from its state file, before the indexer's first message.
    const { states, balanced, pay } = await walletSyncedTo(facadeSyncedTo(7n, 0n, false));
    const paid = pay();
    await settle();
    states.next(facadeSyncedTo(5n, 7n));
    await settle();
    expect(balanced).not.toHaveBeenCalled();
    states.next(facadeSyncedTo(7n, 7n));
    await expect(paid).resolves.toBeInstanceOf(L.Transaction);
    expect(balanced).toHaveBeenCalledTimes(1);
  });

  it("gives up after two minutes with the DUST sync's progress, and balances nothing", async () => {
    const { states, balanced, pay } = await walletSyncedTo(facadeSyncedTo(5n, 7n));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let settled = false;
    const paid = pay().finally(() => (settled = true));
    const refused = expect(paid).rejects.toThrow("the preprod wallet's DUST sync had applied 6 of the 9 events the indexer announced after 120 s; no fee was paid");
    states.next(facadeSyncedTo(6n, 9n));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await refused;
    expect(balanced).not.toHaveBeenCalled();
  });
});

// The wallet SDK's own liveness check would dial a node without the credential, so the wallet
// names none to it and checks the indexer itself, through the credentialed reads, before a fee.
describe("paying a fee against the indexer", () => {
  it("pays while the indexer's head stands within 10 blocks of the node's finalized head", async () => {
    const { balanced, pay } = await walletSyncedTo(facadeSyncedTo(7n, 7n), liveSource({ indexed: 110, finalized: 100 }));
    await expect(pay()).resolves.toBeInstanceOf(L.Transaction);
    expect(balanced).toHaveBeenCalledTimes(1);
  });

  it.each([[89, 100], [111, 100]])("refuses, paying nothing, an indexer at block %i against a finalized head at %i", async (indexed, finalized) => {
    const { balanced, pay } = await walletSyncedTo(facadeSyncedTo(7n, 7n), liveSource({ indexed, finalized }));
    await expect(pay()).rejects.toThrow(`the preprod indexer stands at block ${indexed} and the node's finalized head at ${finalized}, more than 10 blocks apart; no fee was paid`);
    expect(balanced).not.toHaveBeenCalled();
  });

  // An indexer on another fork from block 90 on: it agrees with the node below it.
  const forkedFrom90 = (height: number) => (height < 90 ? height.toString(16).padStart(64, "0") : `ee${height.toString(16).padStart(62, "0")}`);

  it("refuses, paying nothing, a forked indexer behind the node's finalized head", async () => {
    const { balanced, pay } = await walletSyncedTo(facadeSyncedTo(7n, 7n), liveSource({ indexed: 95, finalized: 100, indexerHashAt: forkedFrom90 }));
    await expect(pay()).rejects.toThrow("the preprod indexer's block 95 is not the node's finalized block there; no fee was paid");
    expect(balanced).not.toHaveBeenCalled();
  });

  it.each([1, 3, 10])("refuses, paying nothing, a forked indexer %i blocks ahead of the node's finalized head", async (ahead) => {
    const { balanced, pay } = await walletSyncedTo(facadeSyncedTo(7n, 7n), liveSource({ indexed: 100 + ahead, finalized: 100, indexerHashAt: forkedFrom90 }));
    await expect(pay()).rejects.toThrow("the preprod indexer's block 100 is not the node's finalized block there; no fee was paid");
    expect(balanced).not.toHaveBeenCalled();
  });

  it.each([0, 1, 10])("pays with the node's chain indexed %i blocks ahead of its finalized head", async (ahead) => {
    const { balanced, pay } = await walletSyncedTo(facadeSyncedTo(7n, 7n), liveSource({ indexed: 100 + ahead, finalized: 100 }));
    await expect(pay()).resolves.toBeInstanceOf(L.Transaction);
    expect(balanced).toHaveBeenCalledTimes(1);
  });

  it("refuses, paying nothing, an indexer ahead that holds no block at the node's finalized height", async () => {
    const { balanced, pay } = await walletSyncedTo(facadeSyncedTo(7n, 7n), liveSource({ indexed: 103, finalized: 100, indexerHashAt: (height) => (height === 100 ? null : height.toString(16).padStart(64, "0")) }));
    await expect(pay()).rejects.toThrow("the preprod indexer holds no block at the node's finalized height 100; no fee was paid");
    expect(balanced).not.toHaveBeenCalled();
  });
});

describe("opening the wallet against an indexer", () => {
  it("refuses an indexer of another chain than the node's, before the wallet syncs", async () => {
    const init = vi.spyOn(WalletFacade, "init");
    const source = liveSource({ indexerHashAt: (height) => `ee${height.toString(16).padStart(62, "0")}` });
    await expect(walletSyncedTo(facadeSyncedTo(7n, 7n), source)).rejects.toThrow(`the preprod indexer's genesis block ee${"0".repeat(62)} is not the node's ${"0".repeat(64)}; the wallet was not opened`);
    expect(init).not.toHaveBeenCalled();
  });

  it("refuses an indexer that holds no genesis block, before the wallet syncs", async () => {
    const init = vi.spyOn(WalletFacade, "init");
    const source = liveSource({ indexerHashAt: (height) => (height === 0 ? null : height.toString(16).padStart(64, "0")) });
    await expect(walletSyncedTo(facadeSyncedTo(7n, 7n), source)).rejects.toThrow(`the preprod indexer's genesis block (none) is not the node's ${"0".repeat(64)}; the wallet was not opened`);
    expect(init).not.toHaveBeenCalled();
  });
});

// Below the ledger 9 fork the wallets read the chain with ledger 8 and pay ledger 8 fees; from it,
// ledger 9's. A transaction of the other ledger can be neither balanced nor included.
describe("paying a fee for a transaction of either ledger", () => {
  it("pays only for a transaction of the ledger the wallets act at", async () => {
    const before = await walletSyncedTo(facadeSyncedTo(7n, 7n));
    await expect(before.pay9()).rejects.toThrow("the preprod wallet acts at protocol version 0, ledger 8, and pays no fee for a ledger 9 transaction; no fee was paid");
    await expect(before.pay()).resolves.toBeInstanceOf(L.Transaction);
    vi.restoreAllMocks();
    const after = await walletSyncedTo(facadeSyncedTo(7n, 7n, true, 2001100n));
    // The offline sub-wallets stay below the fork, where the facade finalizes no ledger 9 recipe;
    // binding it here stands in for a facade whose wallets crossed.
    vi.spyOn(WalletFacade.prototype, "finalizeRecipe").mockImplementation(async (recipe) => {
      const base = Either.getOrThrow(WalletTransaction.unwrapWithin<L9.Transaction<L9.SignatureEnabled, L9.Proof, L9.PreBinding>>((recipe as { baseTransaction: WalletTransaction }).baseTransaction, [ProtocolVersion.MinSupportedVersion, ProtocolVersion.MaxSupportedVersion]));
      return WalletTransaction.adopt("Finalized", base.bind(), recipe.protocolVersion);
    });
    await expect(after.pay()).rejects.toThrow("the preprod wallet acts at protocol version 2001100, ledger 9, and pays no fee for a ledger 8 transaction; no fee was paid");
    await expect(after.pay9()).resolves.toBeInstanceOf(L9.Transaction);
    expect(after.balanced.mock.calls.map(([handle]) => handle.protocolVersion)).toEqual([2001100n]);
  });
});

describe("the wallet's sync progress", () => {
  it("names, for the shielded and DUST sync, the newest event the indexer announced", async () => {
    const { wallet } = await walletSyncedTo(facadeSyncedTo(5n, 7n));
    expect(await wallet.progress()).toEqual({
      shielded: { applied: 3n, highest: 4n, connected: true },
      unshielded: { applied: 8n, highest: 9n, connected: true },
      dust: { applied: 5n, highest: 7n, connected: true },
      synced: false,
    });
  });
});

