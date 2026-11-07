import { mkdtempSync, rmSync } from "node:fs";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as L9 from "@midnightntwrk/ledger-v9";
import { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { decodeAnchorTransaction, unprovenRegistryCall } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { createWalletMnemonicFile } from "../src/keys.js";
import { MIDNIGHT_FORKS, openWallet } from "../src/wallet.js";
import { deployed, deployed9, liveSource } from "../test/fakes.js";

const zkDir = process.env.MIDNIGHT_PP;
if (!zkDir) throw new Error("MIDNIGHT_PP must name the directory tools/compactc/install.sh filled");
const dir = mkdtempSync(join(tmpdir(), "orynq-wallet-prove-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// The wallet opens over an indexer and node on port 9, which refuse every connection.
const OFFLINE = { operator: "offline", indexer: "http://127.0.0.1:9/graphql", indexerWs: "ws://127.0.0.1:9/graphql/ws", node: "http://127.0.0.1:9", headers: {} };

// The wallet's own prover, as the facade proves its fee transactions: zkir-v2 in this process.
describe("the wallet's facade prover", () => {
  it("proves a ledger 9 registry call in this process, connecting to nothing but the wallet's own endpoints", async () => {
    const mnemonicFile = join(dir, "wallet.mnemonic");
    createWalletMnemonicFile(mnemonicFile);
    const init = vi.spyOn(WalletFacade, "init");
    const wallet = await openWallet({ network: "preprod", mnemonicFile, endpoints: OFFLINE, source: liveSource(), zkDir });
    try {
      const facade = (await init.mock.results[0]!.value) as WalletFacade;
      const ttl = new Date(Date.now() + 3600e3);
      const commitment = crypto.getRandomValues(new Uint8Array(32));
      const { tx } = unprovenRegistryCall({ networkId: "preprod", address: deployed.address, state: deployed9.state, parameters: L9.LedgerParameters.initialParameters(), call: { circuit: "anchor", args: [commitment, 1n] }, witnesses: { authorSecret: crypto.getRandomValues(new Uint8Array(32)) }, ttl });
      const ports: number[] = [];
      const connect = net.Socket.prototype.connect;
      vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: Socket, ...args: unknown[]) {
        const first = Array.isArray(args[0]) ? args[0][0] : args[0];
        ports.push(Number(typeof first === "object" && first !== null && "port" in first ? (first as { port: unknown }).port : first));
        return (connect as (...a: unknown[]) => Socket).apply(this, args);
      });
      const proven = (await facade.provingService.prove(tx as never, MIDNIGHT_FORKS.v9)) as unknown as L9.Transaction<L9.SignatureEnabled, L9.Proof, L9.PreBinding>;
      const bytes = proven.bind().serialize();
      expect(Buffer.from(bytes.subarray(0, 26)).toString("latin1")).toBe("midnight:transaction[v12](");
      expect(decodeAnchorTransaction(bytes, [deployed.address]).calls).toEqual([expect.objectContaining({ entryPoint: "anchor", kind: 1, commitment: Buffer.from(commitment).toString("hex") })]);
      expect(ports.filter((port) => port !== 9)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await wallet.close();
    }
  });
});
