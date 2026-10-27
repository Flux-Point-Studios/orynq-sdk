import { EventEmitter, once } from "node:events";
import { performance } from "node:perf_hooks";
import { WebSocketServer } from "ws";
import { WsProvider } from "@polkadot/api";
import type { ApiPromise } from "@polkadot/api";
import { expect, it, vi } from "vitest";
import { MateriosProvider } from "../src/provider.js";
import { MateriosConnectionError } from "../src/errors.js";
import { watchSubmission } from "../src/subscription.js";

it("closes a real local WebSocket that accepts RPCs but never answers readiness", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing local port");
  let received = 0;
  let accepted = 0;
  let closed = 0;
  server.on("connection", socket => {
    accepted++;
    socket.on("message", () => { received++; });
    socket.on("close", () => { closed++; });
  });
  const provider = new MateriosProvider({ rpcUrl: `ws://127.0.0.1:${address.port}`, signerUri: "//Alice", connectTimeoutMs: 150 });
  const start = performance.now();
  try {
    await expect(provider.connect()).rejects.toBeInstanceOf(MateriosConnectionError);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(accepted).toBe(1);
    expect(received).toBeGreaterThan(0);
    await vi.waitFor(() => expect(closed).toBe(1));
    expect(server.clients.size).toBe(0);
    expect(() => provider.getApi()).toThrow("Not connected");
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 5000);

it("ends an acknowledged real author watch on abnormal closure and removes its listener", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing local port");
  server.on("connection", socket => {
    socket.on("message", bytes => {
      const request = JSON.parse(String(bytes));
      if (request.method === "author_submitAndWatchExtrinsic") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "watch-1" }));
      }
    });
  });
  const ws = new WsProvider(`ws://127.0.0.1:${address.port}`, false);
  const api = Object.assign(new EventEmitter(), { isConnected: true });
  const off = ws.on("disconnected", () => { api.isConnected = false; api.emit("disconnected"); });
  let unsubscribed: Promise<boolean> | undefined;
  const unsubscribe = vi.fn(() => {
    unsubscribed = ws.unsubscribe("author_extrinsicUpdate", "author_unwatchExtrinsic", "watch-1");
  });
  try {
    const connected = new Promise<void>(resolve => {
      const remove = ws.on("connected", () => { remove(); resolve(); });
    });
    await ws.connect();
    await connected;
    let acknowledge: () => void = () => {};
    const acknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
    const outcome = watchSubmission(api as unknown as ApiPromise, async () => {
      await ws.subscribe("author_extrinsicUpdate", "author_submitAndWatchExtrinsic", ["0x00"], () => {});
      acknowledge();
      return unsubscribe;
    }, Date.now() + 1000, "fixture", false);
    await acknowledged;
    for (const socket of server.clients) socket.terminate();
    await expect(outcome).resolves.toBeNull();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await expect(unsubscribed).resolves.toBe(true);
    expect(api.listenerCount("disconnected")).toBe(0);
  } finally {
    off();
    await ws.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 5000);
