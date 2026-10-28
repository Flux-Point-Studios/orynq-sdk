import { EventEmitter, once } from "node:events";
import net from "node:net";
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
    }, Date.now() + 1000, false);
    await acknowledged;
    for (const socket of server.clients) socket.terminate();
    await expect(outcome).resolves.toMatchObject({ status: "lost", timedOut: false });
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

it("aborts an in-flight connect when disconnect() is called and leaves no socket or reconnect behind", async () => {
  const sockets = new Set<net.Socket>();
  let closed = 0;
  const server = net.createServer(socket => {
    sockets.add(socket);
    // A paused socket never notices the client's FIN; reading the upgrade request lets it.
    socket.resume();
    socket.on("error", () => {});
    socket.on("close", () => { closed++; });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing local port");
  const provider = new MateriosProvider({ rpcUrl: `ws://127.0.0.1:${address.port}`, signerUri: "//Alice", connectTimeoutMs: 5000 });
  try {
    const connecting = provider.connect().catch((error: unknown) => error);
    await vi.waitFor(() => expect(sockets.size).toBe(1));
    const start = performance.now();
    await expect(provider.disconnect()).resolves.toBeUndefined();
    expect(performance.now() - start).toBeLessThan(500);
    expect(await connecting).toMatchObject({ name: "MateriosConnectionError", code: "connect-aborted" });
    // Node's built-in WebSocket (undici) retries an aborted handshake once on a new socket and closes it at once.
    await vi.waitFor(() => expect(closed).toBe(sockets.size), { timeout: 1000 });
    // Past polkadot.js's 2.5 s auto-reconnect delay: nothing reconnected.
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(closed).toBe(sockets.size);
    expect(sockets.size).toBeLessThanOrEqual(2);
    expect(() => provider.getApi()).toThrow("Not connected");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10_000);

it("keeps a non-empty cause naming the failure for a refused connection", async () => {
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (typeof address === "string" || !address) throw new Error("Missing local port");
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const rpcUrl = `ws://127.0.0.1:${address.port}`;
  const error = await new MateriosProvider({ rpcUrl, signerUri: "//Alice", connectTimeoutMs: 5000 }).connect().catch((value: unknown) => value);
  expect(error).toBeInstanceOf(MateriosConnectionError);
  expect(error).toMatchObject({ code: "connect-failed" });
  const cause = (error as Error).cause;
  expect(cause).toBeInstanceOf(Error);
  expect((cause as Error).message).toMatch(new RegExp(`ECONNREFUSED|${rpcUrl}`));
  expect((error as Error).message).toContain((cause as Error).message);
}, 10_000);
