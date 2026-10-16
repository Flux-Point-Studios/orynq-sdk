import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { of } from "rxjs";
import type { MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { createWalletMnemonicFile } from "../src/keys.js";
import { openWallet, type OperatorWallet } from "../src/wallet.js";
import { facadeSyncedTo } from "./fakes.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-wallet-release-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const OFFLINE = { operator: "offline", indexer: "http://127.0.0.1:9/graphql", indexerWs: "ws://127.0.0.1:9/graphql/ws", node: "http://127.0.0.1:9", headers: {} };
const REFUSED = 'test node: author_submitExtrinsic failed: {"code":1010,"message":"Invalid Transaction","data":"Custom error: 136"}';

const opened: OperatorWallet[] = [];
afterEach(async () => {
  for (const wallet of opened.splice(0)) await wallet.close();
  vi.restoreAllMocks();
});

// A wallet over no indexer, its DUST sync reported as caught up, whose node answers each
// submission with the next of `answers` (an Error is thrown, anything else returned), balancing
// every fee as nothing: the SDK's own finalizeRecipe binds the bytes and hands them to the
// facade's pending-transactions service.
async function walletWithNode(...answers: Array<Error | string>) {
  const mnemonicFile = join(dir, `${opened.length}-${Math.random().toString(16).slice(2)}.mnemonic`);
  createWalletMnemonicFile(mnemonicFile);
  const submitted: string[] = [];
  const source = {
    operator: "test",
    node: {
      async call(method: string, params: unknown[] = []) {
        if (method !== "author_submitExtrinsic") throw new Error(`unexpected ${method}`);
        submitted.push(String(params[0]));
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer ?? "0xextrinsic";
      },
    },
  } as unknown as MidnightSource;
  vi.spyOn(WalletFacade.prototype, "state").mockReturnValue(of(facadeSyncedTo(1n, 1n)) as never);
  vi.spyOn(WalletFacade.prototype, "balanceUnboundTransaction").mockImplementation(async (tx) => ({ type: "UNBOUND_TRANSACTION", baseTransaction: tx, balancingTransaction: undefined }));
  const reverted = vi.spyOn(WalletFacade.prototype, "revert");
  const wallet = await openWallet({ network: "preprod", mnemonicFile, endpoints: OFFLINE, source, zkDir: "/nonexistent" });
  opened.push(wallet);
  const paid = (ttlMs = 15 * 60_000, dustActionsAt?: Date) => {
    const ttl = new Date(Date.now() + ttlMs);
    const intent = L.Intent.new(ttl);
    if (dustActionsAt) intent.dustActions = new L.DustActions("signature", "pre-proof", dustActionsAt, [], []);
    return wallet.payFee(L.Transaction.fromParts("preprod", undefined, undefined, intent).mockProve() as never, ttl);
  };
  const revertedHashes = () => reverted.mock.calls.map(([tx]) => (tx as L.FinalizedTransaction).transactionHash());
  return { wallet, paid, submitted, revertedHashes };
}

describe("the DUST of final bytes the node refused", () => {
  it("is freed when the node refused their first delivery, and those bytes are never sent again", async () => {
    const { wallet, paid, submitted, revertedHashes } = await walletWithNode(new Error(REFUSED));
    const tx = await paid();
    await expect(wallet.submit(tx)).rejects.toThrow(REFUSED);
    expect(revertedHashes()).toEqual([tx.transactionHash()]);
    await expect(wallet.submit(tx)).rejects.toThrow(`transaction ${tx.transactionHash()} was refused or discarded, and the DUST it spent freed; its bytes are never sent again`);
    expect(submitted).toHaveLength(1);
    expect(revertedHashes()).toEqual([tx.transactionHash()]);
  });

  // A delivery the node never answered may have reached it: a later refusal of the same bytes
  // can mean they are already in a block.
  it("stays held when an earlier delivery of the same bytes went unanswered", async () => {
    const { wallet, paid, submitted, revertedHashes } = await walletWithNode(new Error("test node: fetch failed"), new Error(REFUSED));
    const tx = await paid();
    await expect(wallet.submit(tx)).rejects.toThrow("fetch failed");
    await expect(wallet.submit(tx)).rejects.toThrow(REFUSED);
    expect(submitted).toHaveLength(2);
    expect(revertedHashes()).toEqual([]);
  });

  // Bytes another process balanced, a journal's resend after a restart, may have reached a node
  // before that process died.
  it("stays held for bytes this wallet did not balance", async () => {
    const { wallet, revertedHashes } = await walletWithNode(new Error(REFUSED));
    const elsewhere = L.Transaction.fromParts("preprod", undefined, undefined, L.Intent.new(new Date(Date.now() + 60_000))).mockProve().bind() as L.FinalizedTransaction;
    await expect(wallet.submit(elsewhere)).rejects.toThrow(REFUSED);
    expect(revertedHashes()).toEqual([]);
  });
});

// feeTransacting's revert reads the ledger as it stands when each reverted spend's hold ends, its
// DUST actions' ctime plus the grace period; wallet-sdk-dust-wallet 4.2.0's own revert reads
// nothing for spends its list of this process's spends no longer holds, as here.
describe("the wallet's DUST", () => {
  it("is freed by feeTransacting's revert", async () => {
    const { wallet, paid } = await walletWithNode();
    const ctime = new Date(Math.floor(Date.now() / 1000) * 1000);
    const tx = await paid(15 * 60_000, ctime);
    const held = vi.spyOn(L.DustLocalState.prototype, "processTtls");
    await wallet.discard(tx);
    expect(held.mock.calls).toEqual([[new Date(ctime.getTime() + 3 * 3600_000)]]);
  });
});

describe("discarding final bytes", () => {
  it("frees the DUST of bytes never handed to a node, which are then never sent", async () => {
    const { wallet, paid, submitted, revertedHashes } = await walletWithNode();
    const tx = await paid();
    await wallet.discard(tx);
    expect(revertedHashes()).toEqual([tx.transactionHash()]);
    await expect(wallet.submit(tx)).rejects.toThrow(/its bytes are never sent again/);
    expect(submitted).toEqual([]);
  });

  it("is refused for bytes already handed to a node, whose DUST stays held", async () => {
    const { wallet, paid, revertedHashes } = await walletWithNode(new Error("test node: fetch failed"));
    const tx = await paid();
    await expect(wallet.submit(tx)).rejects.toThrow("fetch failed");
    await expect(wallet.discard(tx)).rejects.toThrow(`transaction ${tx.transactionHash()} was handed to a node, or not balanced by this wallet since it opened, so its DUST stays held until the chain settles it`);
    expect(revertedHashes()).toEqual([]);
  });
});

// The facade's default pending-transactions service reverts bytes once their TTL has passed by
// this machine's clock while the indexer does not list them, which an indexer behind the chain or
// out of reach makes true of bytes already in a block.
describe("the facade", () => {
  it("never frees DUST on its own clock", async () => {
    const { paid, revertedHashes } = await walletWithNode();
    await paid(-60_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(revertedHashes()).toEqual([]);
  });
});
