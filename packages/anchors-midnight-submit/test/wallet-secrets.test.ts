import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { BehaviorSubject } from "rxjs";
import { createWalletMnemonicFile } from "../src/keys.js";
import { openWallet } from "../src/wallet.js";
import { facadeSyncedTo } from "./fakes.js";

// The credential relay is replaced by one whose URLs reach nothing, so the wallet opens offline.
const RELAY_SECRET = "fedcba9876543210fedcba9876543210";
vi.mock("../src/relay.js", () => ({
  credentialRelay: async () => ({ indexerHttpUrl: "http://127.0.0.1:9/graphql", indexerWsUrl: "ws://127.0.0.1:9/graphql/ws", secrets: [RELAY_SECRET], close: async () => undefined }),
}));

const dir = mkdtempSync(join(tmpdir(), "orynq-wallet-secrets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("names its credential relay's secrets, which a log line must never carry", async () => {
  const mnemonicFile = join(dir, "wallet.mnemonic");
  createWalletMnemonicFile(mnemonicFile);
  vi.spyOn(WalletFacade.prototype, "state").mockReturnValue(new BehaviorSubject(facadeSyncedTo(0n, 0n)) as never);
  const endpoints = { operator: "offline", indexer: "http://127.0.0.1:9/graphql", indexerWs: "ws://127.0.0.1:9/graphql/ws", node: "http://127.0.0.1:9", headers: { project_id: "preprod" + "Ab".repeat(16) } };
  const wallet = await openWallet({ network: "preprod", mnemonicFile, endpoints, source: undefined as never, zkDir: "/nonexistent" });
  try { expect(wallet.secrets).toEqual([RELAY_SECRET]); }
  finally { await wallet.close(); }
});
