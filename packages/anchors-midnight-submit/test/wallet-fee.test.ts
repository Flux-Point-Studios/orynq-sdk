import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { BehaviorSubject } from "rxjs";
import { createWalletMnemonicFile } from "../src/keys.js";
import { DEFAULT_COST_PARAMETERS, costParametersOf, openWallet, type OperatorWallet } from "../src/wallet.js";
import { facadeSyncedTo } from "./fakes.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-wallet-fee-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const OFFLINE = { operator: "offline", indexer: "http://127.0.0.1:9/graphql", indexerWs: "ws://127.0.0.1:9/graphql/ws", node: "http://127.0.0.1:9", headers: {} };

const opened: OperatorWallet[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const wallet of opened.splice(0)) await wallet.close();
  vi.restoreAllMocks();
});

// wallet-sdk-dust-wallet 4.2.0 pays a fee by selecting DUST until it covers the fee its dry run
// computes. For a transaction whose computed fee is 0 it selects nothing, the dry run then costs
// 1 SPECK, and every later round reads that fee as a surplus and selects nothing again: the
// synchronous loop never ends, and its ledger allocations grow the wasm heap until the ledger
// traps. On preprod the same balancing of a maintenance update, stuck that way, finished in one
// round with 1 SPECK of overhead.
describe("the wallet's fee overhead", () => {
  it("is 1 SPECK unless the caller sets more", () => {
    expect(DEFAULT_COST_PARAMETERS.additionalFeeOverhead).toBe(1n);
    expect(costParametersOf(undefined)).toEqual(DEFAULT_COST_PARAMETERS);
    expect(costParametersOf({ additionalFeeOverhead: 5n, feeBlocksMargin: 3 })).toEqual({ additionalFeeOverhead: 5n, feeBlocksMargin: 3 });
  });

  it("is refused at 0, before the wallet reads its mnemonic", async () => {
    expect(() => costParametersOf({ additionalFeeOverhead: 0n, feeBlocksMargin: 5 })).toThrow(/additionalFeeOverhead must be at least 1 SPECK/);
    await expect(
      openWallet({ network: "preprod", mnemonicFile: "/nonexistent/wallet.mnemonic", endpoints: undefined as never, source: undefined as never, zkDir: "/nonexistent", costParameters: { additionalFeeOverhead: 0n, feeBlocksMargin: 5 } }),
    ).rejects.toThrow(/additionalFeeOverhead must be at least 1 SPECK/);
  });
});

// A wallet over no indexer whose facade reports `states` and balances every fee as nothing.
async function walletSyncedTo(initial: ReturnType<typeof facadeSyncedTo>) {
  const mnemonicFile = join(dir, `${opened.length}-${Math.random().toString(16).slice(2)}.mnemonic`);
  createWalletMnemonicFile(mnemonicFile);
  const states = new BehaviorSubject(initial);
  vi.spyOn(WalletFacade.prototype, "state").mockReturnValue(states as never);
  const balanced = vi.spyOn(WalletFacade.prototype, "balanceUnboundTransaction").mockImplementation(async (tx) => ({ type: "UNBOUND_TRANSACTION", baseTransaction: tx, balancingTransaction: undefined }));
  const wallet = await openWallet({ network: "preprod", mnemonicFile, endpoints: OFFLINE, source: undefined as never, zkDir: "/nonexistent" });
  opened.push(wallet);
  const pay = () => {
    const ttl = new Date(Date.now() + 15 * 60_000);
    return wallet.payFee(L.Transaction.fromParts("preprod", undefined, undefined, L.Intent.new(ttl)).mockProve() as never, ttl);
  };
  return { wallet, states, balanced, pay };
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
