import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
