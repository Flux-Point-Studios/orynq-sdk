import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as L8 from "@midnightntwrk/ledger-v8";
import { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { firstValueFrom, of } from "rxjs";
import { decodeTransaction } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { createWalletMnemonicFile } from "../src/keys.js";
import { MIDNIGHT_FORKS, openWallet, type OperatorWallet } from "../src/wallet.js";
import { facadeSyncedTo, liveSource } from "./fakes.js";
import { NIGHT, closeSimulators, dustOnSimulator, run } from "./simulator.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-wallet-custody-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const TOKEN = "preprodCUSTODYtoken0123456789abcdefABCD";
const opened: OperatorWallet[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const wallet of opened.splice(0)) await wallet.close();
  vi.restoreAllMocks();
});
const mnemonic = () => {
  const file = join(dir, `${Math.random().toString(16).slice(2)}.mnemonic`);
  createWalletMnemonicFile(file);
  return file;
};

// Every TCP connection this process opens through net.Socket's connect, by destination port, while
// `run` runs. Worker threads, Unix sockets, DNS lookups and child processes are not watched.
async function connectionsDuring<T>(run: () => Promise<T>): Promise<{ result: T; ports: number[] }> {
  const ports: number[] = [];
  const connect = net.Socket.prototype.connect;
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: Socket, ...args: unknown[]) {
    // net.connect hands the socket its normalized arguments as one array.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const port = typeof first === "object" && first !== null && "port" in first ? Number((first as { port: unknown }).port) : Number(first);
    if (Number.isFinite(port)) ports.push(port);
    return (connect as (...a: unknown[]) => Socket).apply(this, args);
  });
  const result = await run();
  return { result, ports };
}

// An upstream indexer that answers nothing useful and records whether each request and WebSocket
// upgrade carried the credential, and a node that only counts who connects to it.
async function upstreams() {
  const requests: Array<{ kind: "http" | "upgrade"; credentialed: boolean }> = [];
  const credentialed = (req: IncomingMessage) => req.headers.project_id === TOKEN;
  const indexer = createServer((req, res) => {
    requests.push({ kind: "http", credentialed: credentialed(req) });
    req.resume();
    req.on("end", () => res.writeHead(503).end());
  });
  indexer.on("upgrade", (req, socket) => {
    requests.push({ kind: "upgrade", credentialed: credentialed(req) });
    socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
  });
  let nodeConnections = 0;
  const node = net.createServer((socket) => {
    nodeConnections++;
    socket.destroy();
  });
  await Promise.all([indexer, node].map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))));
  const port = (server: { address(): unknown }) => (server.address() as AddressInfo).port;
  return {
    requests,
    nodeConnections: () => nodeConnections,
    indexerPort: port(indexer),
    nodePort: port(node),
    endpoints: { operator: "custody-test", indexer: `http://127.0.0.1:${port(indexer)}/graphql`, indexerWs: `ws://127.0.0.1:${port(indexer)}/graphql/ws`, node: `http://127.0.0.1:${port(node)}`, headers: { project_id: TOKEN } },
    close: () => Promise.all([indexer, node].map((server) => new Promise((resolve) => server.close(resolve)))),
  };
}

describe("the wallet's connections", () => {
  it("open sockets only to its credential relay and, from the relay with the credential, to the indexer; the SDK dials no node", async () => {
    const up = await upstreams();
    try {
      const init = vi.spyOn(WalletFacade, "init");
      const { result: wallet, ports } = await connectionsDuring(async () => {
        const wallet = await openWallet({ network: "preprod", mnemonicFile: mnemonic(), endpoints: up.endpoints, source: liveSource(), zkDir: "/nonexistent" });
        // Long enough for the SDK's subscriptions, its chain-version probe and the first
        // liveness poll it would run against a node it was given.
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        return wallet;
      });
      opened.push(wallet);
      const relay = Number(new URL((init.mock.calls[0]![0].configuration as { indexerClientConnection: { indexerHttpUrl: string } }).indexerClientConnection.indexerHttpUrl).port);
      expect(ports.length).toBeGreaterThan(0);
      expect([...new Set(ports)].sort()).toEqual([relay, up.indexerPort].sort());
      expect(up.requests.length).toBeGreaterThan(0);
      expect(up.requests.every((request) => request.credentialed)).toBe(true);
      expect(up.nodeConnections()).toBe(0);
    } finally {
      await up.close();
    }
  }, 30_000);

  it("open no other socket while the wallet pays a fee and submits it, nor while a DUST wallet registers, balances, proves and submits on the simulator", async () => {
    const up = await upstreams();
    try {
      const init = vi.spyOn(WalletFacade, "init");
      vi.spyOn(WalletFacade.prototype, "state").mockReturnValue(of(facadeSyncedTo(1n, 1n)) as never);
      vi.spyOn(WalletFacade.prototype, "balanceUnboundTransaction").mockImplementation(async (tx) => ({ type: "UNBOUND_TRANSACTION", protocolVersion: tx.protocolVersion, baseTransaction: tx, balancingTransaction: undefined }));
      const live = liveSource();
      const submitted: unknown[] = [];
      const node = { ...live.node, call: async <T>(method: string, params: unknown[] = []): Promise<T> => (method === "author_submitExtrinsic" ? (submitted.push(params[0]), "0x" as T) : live.node.call<T>(method, params)) };
      const { ports } = await connectionsDuring(async () => {
        const wallet = await openWallet({ network: "preprod", mnemonicFile: mnemonic(), endpoints: up.endpoints, source: { ...live, node }, zkDir: "/nonexistent" });
        opened.push(wallet);
        const ttl = new Date(Date.now() + 60_000);
        await wallet.submit(await wallet.payFee(L8.Transaction.fromParts("preprod", undefined, undefined, L8.Intent.new(ttl)).mockProve() as never, ttl));
        const { simulator, balanced } = await dustOnSimulator([NIGHT]);
        await run(simulator.submitTransaction(await balanced()));
      });
      const relay = Number(new URL((init.mock.calls[0]![0].configuration as { indexerClientConnection: { indexerHttpUrl: string } }).indexerClientConnection.indexerHttpUrl).port);
      expect(submitted).toHaveLength(1);
      expect(new Set(ports)).toEqual(new Set([relay, up.indexerPort]));
      expect(up.requests.every((request) => request.credentialed)).toBe(true);
      expect(up.nodeConnections()).toBe(0);
    } finally {
      await closeSimulators();
      await up.close();
    }
  }, 120_000);

  it("names no node to the wallet SDK, whose liveness check would dial it without the credential", async () => {
    const init = vi.spyOn(WalletFacade, "init");
    opened.push(await openWallet({ network: "preprod", mnemonicFile: mnemonic(), endpoints: { operator: "offline", indexer: "http://127.0.0.1:9/graphql", indexerWs: "ws://127.0.0.1:9/graphql/ws", node: "http://127.0.0.1:9", headers: {} }, source: liveSource(), zkDir: "/nonexistent" }));
    const { configuration } = init.mock.calls[0]![0] as { configuration: Record<string, unknown> };
    expect(configuration).not.toHaveProperty("relayURL");
    expect(configuration).not.toHaveProperty("nodeClientConnection");
    expect(configuration.forks).toEqual(MIDNIGHT_FORKS);
  });
});

const OFFLINE = { operator: "offline", indexer: "http://127.0.0.1:9/graphql", indexerWs: "ws://127.0.0.1:9/graphql/ws", node: "http://127.0.0.1:9", headers: {} };

// A wallet over no indexer whose facade reports its DUST sync caught up and balances every fee as
// nothing, so the SDK's own finalizeRecipe binds the bytes and hands them to the lifecycle service.
async function payingWallet() {
  vi.spyOn(WalletFacade.prototype, "state").mockReturnValue(of(facadeSyncedTo(1n, 1n)) as never);
  vi.spyOn(WalletFacade.prototype, "balanceUnboundTransaction").mockImplementation(async (tx) => ({ type: "UNBOUND_TRANSACTION", protocolVersion: tx.protocolVersion, baseTransaction: tx, balancingTransaction: undefined }));
  const init = vi.spyOn(WalletFacade, "init");
  const wallet = await openWallet({ network: "preprod", mnemonicFile: mnemonic(), endpoints: OFFLINE, source: liveSource(), zkDir: "/nonexistent" });
  opened.push(wallet);
  const facade = (await init.mock.results[0]!.value) as WalletFacade;
  // Where every release of DUST lands, whoever asks for it.
  const released = vi.spyOn(facade.dust, "revertTransaction");
  const pay = (ttlMs: number) => {
    const ttl = new Date(Date.now() + ttlMs);
    return wallet.payFee(L8.Transaction.fromParts("preprod", undefined, undefined, L8.Intent.new(ttl)).mockProve() as never, ttl);
  };
  const freed = () => released.mock.calls.map(([handle]) => decodeTransaction((handle as { serialize(): Uint8Array }).serialize()).tx.transactionHash());
  return { wallet, facade, pay, freed };
}

// wallet-sdk 2.x's default lifecycle service frees a transaction's DUST once its TTL passes by this
// machine's clock with no inclusion the indexer shows. The journal alone decides that bytes did not
// land; until it does, their DUST stays held.
describe("the DUST of balanced bytes", () => {
  it("stays held when their TTL passes with no inclusion observed, until the journal discards them", async () => {
    const { wallet, facade, pay, freed } = await payingWallet();
    const tx = await pay(1_000);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(freed()).toEqual([]);
    expect((await firstValueFrom(facade.transactionLifecycleService.state())).records).toEqual([]);
    await wallet.discard(tx);
    expect(freed()).toEqual([tx.transactionHash()]);
  }, 30_000);

  it("stays held for bytes a node may hold, after their TTL, whatever the facade's lifecycle is told", async () => {
    const { wallet, facade, pay, freed } = await payingWallet();
    const tx = await pay(1_000);
    await facade.transactionLifecycleService.submitted({ identifiers: tx.identifiers(), tx: undefined, ttl: new Date(Date.now() - 1) } as never);
    await facade.transactionLifecycleService.included(tx.identifiers(), { status: "FAILURE", segments: [] });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(freed()).toEqual([]);
    await expect(wallet.discard(tx)).resolves.toBeUndefined();
  }, 30_000);
});

// A proof server would receive every witness of every proof: the wallet proves in this process.
describe("the wallet's provers", () => {
  it("prove each ledger in this process, from key material read only from the ZK directory", async () => {
    const init = vi.spyOn(WalletFacade, "init");
    opened.push(await openWallet({ network: "preprod", mnemonicFile: mnemonic(), endpoints: OFFLINE, source: liveSource(), zkDir: "/nonexistent-zk" }));
    const { provers } = init.mock.calls[0]![0].configuration as unknown as { provers: Record<"v8" | "v9", { kind: string; keyMaterialProvider: { lookupKey(location: string): Promise<unknown> } }> };
    expect(Object.keys(provers).sort()).toEqual(["v8", "v9"]);
    for (const [ledger, generation] of [["v8", 9], ["v9", 10]] as const) {
      expect(provers[ledger]).toEqual({ kind: "wasm", keyMaterialProvider: expect.any(Object) });
      await expect(provers[ledger].keyMaterialProvider.lookupKey("midnight/dust/spend")).rejects.toThrow(`/nonexistent-zk/dust/${generation}/spend.prover`);
    }
  });
});
