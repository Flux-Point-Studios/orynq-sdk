// What run.ts imports as ./endpoints.js and ../src/index.js when deploy.test.ts runs it offline:
// the submit package itself, with its wallet and prover replaced, over a chain that lives in the
// JSON file OFFLINE_CHAIN so it outlasts each run.ts process. OFFLINE_FAULT breaks one step of a
// run: "refuse-broadcast" (a proxy answers the broadcast with HTTP 403), "lose-read" (the first
// read of a landed transaction fails) or "lose-sync" (the wallet stops syncing once a deploy
// landed).
import { readFileSync, writeFileSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import type { IndexedTransaction, MidnightSource, SourceEndpoints } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import type { OperatorWallet, WalletOptions } from "../../src/index.js";
import { prover } from "../../test/prover.js";

export * from "../../src/index.js";

export interface OfflineChain {
  // How far the newest block's time runs ahead of the local clock.
  aheadMs: number;
  // Every transaction handed to the node, in order, whether or not it landed.
  sent: string[];
  landed: Record<string, { raw: string; height: number; address: string; state: string }>;
}

const FILE = process.env.OFFLINE_CHAIN!;
const FAULT = process.env.OFFLINE_FAULT;
const HEAD = "00".repeat(32);
const BLOCK = "ab".repeat(32);
const read = (): OfflineChain => JSON.parse(readFileSync(FILE, "utf8"));
const write = (chain: OfflineChain) => writeFileSync(FILE, JSON.stringify(chain));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
let readsToLose = FAULT === "lose-read" ? 1 : 0;

export const source = {
  operator: "offline",
  node: {
    async call(method: string, params: unknown[] = []) {
      if (method === "state_getRuntimeVersion") return { specVersion: 1000300 };
      if (method === "chain_getBlockHash") return `0x${HEAD}`;
      if (method === "state_getStorage" && params[1] === `0x${HEAD}`) {
        const now = Buffer.alloc(8);
        now.writeBigUInt64LE(BigInt(Date.now() + read().aheadMs));
        return `0x${now.toString("hex")}`;
      }
      if (method === "midnight_contractState") return Object.values(read().landed).find((t) => t.address === params[0])?.state ?? null;
      throw new Error(`offline node: unexpected ${method}`);
    },
    async batch() {
      throw new Error("offline node: unexpected batch");
    },
  },
  indexer: {
    async transactions(hash: string): Promise<IndexedTransaction[]> {
      const t = read().landed[hash];
      if (!t) return [];
      if (readsToLose > 0) {
        readsToLose--;
        throw new Error("offline indexer: HTTP 502: Bad Gateway");
      }
      return [{ hash, raw: t.raw, block: { height: t.height, hash: BLOCK, timestamp: Date.now() }, status: "SUCCESS", contractActions: [{ kind: "ContractDeploy", address: t.address, state: t.state }] }];
    },
    async head() {
      return { height: 1000, hash: HEAD, timestamp: Date.now() + read().aheadMs };
    },
    async latestAction() {
      return null;
    },
    contractActions() {
      throw new Error("offline indexer: unexpected subscription");
    },
  },
} as unknown as MidnightSource;

export const WALLET_SYNC: SourceEndpoints = { operator: "offline", indexer: "http://127.0.0.1:9/never", indexerWs: "ws://127.0.0.1:9/never", node: "http://127.0.0.1:9/never", headers: {} };

export const provingService = () => prover;

// A synced wallet with DUST to spare that binds without adding a fee and lands what it submits.
export async function openWallet(options: WalletOptions): Promise<OperatorWallet> {
  return {
    network: options.network,
    addresses: options.expectedAddresses!,
    async waitForSync() {},
    async progress() {
      throw new Error("offline wallet: unexpected progress");
    },
    async saveState() {},
    async balances() {
      if (FAULT === "lose-sync" && Object.keys(read().landed).length > 0) throw new Error(`the ${options.network} wallet did not sync within 600 s`);
      return { night: 10n ** 9n, dust: 10n ** 16n, nightUtxos: 1, registeredNightUtxos: 1 };
    },
    async registerNightForDust() {
      return null;
    },
    async payFee(tx) {
      return tx.bind();
    },
    async submit(tx) {
      const chain = read();
      chain.sent.push(tx.transactionHash());
      write(chain);
      if (FAULT === "refuse-broadcast") throw new Error("offline node: HTTP 403: Forbidden");
      const deploy = [...tx.intents!.values()].flatMap((intent) => intent.actions).find((a): a is L.ContractDeploy => a instanceof L.ContractDeploy)!;
      chain.landed[tx.transactionHash()] = { raw: hex(tx.serialize()), height: 500 + Object.keys(chain.landed).length, address: String(deploy.address), state: hex(deploy.initialState.serialize()) };
      write(chain);
    },
    async discard() {},
    async close() {},
  };
}
