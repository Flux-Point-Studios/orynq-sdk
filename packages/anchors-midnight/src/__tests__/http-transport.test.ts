import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { midnightSource } from "../source.js";
import { rpcOnlySource } from "../rpc-source.js";

let server: Server, url: string, requests: number, timers: ReturnType<typeof setTimeout>[];
let handler: (req: IncomingMessage, res: ServerResponse) => void;
const answer = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" });
beforeEach(async () => {
  requests = 0; timers = []; handler = (_req, res) => res.end(answer);
  server = createServer((req, res) => { req.resume(); req.on("end", () => { requests++; handler(req, res); }); });
  server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks(); for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
const client = (httpSignal?: AbortSignal) => midnightSource({ operator: "fixture", node: url, indexer: url, indexerWs: "ws://127.0.0.1:1", headers: {}, ...(httpSignal ? { httpSignal } : {}) });

it("rejects a pre-aborted HTTP request without sending it or exposing the abort reason", async () => {
  const abort = new AbortController(); abort.abort("fixture-sensitive-abort-reason");
  const result = await client(abort.signal).node.call("system_chain").catch(error => error);
  expect(result).toBeInstanceOf(Error); if (!(result instanceof Error)) throw new Error("Expected cancellation failure"); expect(result.message).toMatch(/unavailable|abort/i);
  expect(result.message).not.toContain("fixture-sensitive-abort-reason"); expect(requests).toBe(0);
});

it("aborts the actual request while waiting for response headers", async () => {
  const abort = new AbortController(); let entered!: () => void, closed = false;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  handler = (_req, res) => { res.on("close", () => { closed = true; }); entered(); timers.push(setTimeout(() => res.end(answer), 500)); };
  const pending = client(abort.signal).node.call("system_chain"); await ready; abort.abort();
  await expect(pending).rejects.toThrow(/unavailable|abort/i);
  await vi.waitFor(() => expect(closed).toBe(true));
});

it("keeps cancellation active while consuming a stalled chunked body", async () => {
  const abort = new AbortController(); let entered!: () => void, closed = false;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  handler = (_req, res) => {
    res.on("close", () => { closed = true; }); res.writeHead(200, { "content-type": "application/json" }); res.write('{"jsonrpc":"2.0","id":1,"result":"');
    entered(); timers.push(setTimeout(() => res.end('ok"}'), 500));
  };
  const pending = client(abort.signal).node.call("system_chain"); await ready; abort.abort();
  await expect(pending).rejects.toThrow(/unavailable|abort/i);
  await vi.waitFor(() => expect(closed).toBe(true));
});

it("closes the actual request when invalid UTF-8 rejects before a stalled body ends", async () => {
  let closed = false;
  handler = (_req, res) => {
    res.on("close", () => { closed = true; }); res.writeHead(200, { "content-type": "application/json" }); res.write(Buffer.from([0xff]));
  };
  await expect(client().node.call("system_chain")).rejects.toThrow(/unavailable/i);
  await vi.waitFor(() => expect(closed).toBe(true), { timeout: 100, interval: 10 });
});

it("bounds decoded response bytes rather than compressed size or UTF-16 characters", async () => {
  const compressed = gzipSync(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "é".repeat(21 * 1024 * 1024) }));
  expect(compressed.length).toBeLessThan(1024 * 1024);
  handler = (_req, res) => { res.writeHead(200, { "content-encoding": "gzip", "content-length": compressed.length }); res.end(compressed); };
  await expect(client().node.call("system_chain")).rejects.toThrow(/byte budget|size limit/i);
});

it("refuses an oversized request before HTTP transmission", async () => {
  await expect(client().node.call("echo", ["x".repeat(1024 * 1024)])).rejects.toThrow(/request.*byte budget|request.*size limit/i);
  expect(requests).toBe(0);
});

it("bounds stalled requests with a deadline and clears the timer after completion", async () => {
  const original = globalThis.setTimeout;
  const started: ReturnType<typeof setTimeout>[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
    const timer = original(fn, delay === 15_000 ? 20 : delay, ...args); if (delay === 15_000) started.push(timer); return timer;
  }) as typeof setTimeout);
  const cleared = vi.spyOn(globalThis, "clearTimeout");
  handler = (_req, res) => { timers.push(original(() => res.end(answer), 500)); };
  await expect(client().node.call("system_chain")).rejects.toThrow(/unavailable|timed out/i);
  expect(started).toHaveLength(1); expect(cleared).toHaveBeenCalledWith(started[0]);
});

it("forwards cancellation through the RPC-only URL source", async () => {
  const abort = new AbortController(); abort.abort();
  const source = rpcOnlySource({ network: "mainnet", node: url, hints: [], signal: abort.signal });
  await expect(source.node.call("system_chain")).rejects.toThrow(/unavailable|abort/i);
  expect(requests).toBe(0);
});

it("refuses redirects before forwarding a provider credential to another origin", async () => {
  let forwarded = 0;
  const destination = createServer((_req, res) => { forwarded++; res.end(answer); });
  destination.listen(0, "127.0.0.1"); await new Promise<void>(resolve => destination.once("listening", resolve));
  try {
    handler = (_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${(destination.address() as { port: number }).port}` }); res.end(); };
    const source = midnightSource({ operator: "fixture", node: url, indexer: url, indexerWs: "ws://127.0.0.1:1", headers: { project_id: "fixture-provider-credential" } });
    await expect(source.node.call("system_chain")).rejects.toThrow(/unavailable|redirect/i);
    expect(forwarded).toBe(0);
  } finally {
    destination.closeAllConnections(); await new Promise<void>((resolve, reject) => destination.close(error => error ? reject(error) : resolve()));
  }
});

it("shares an explicit request budget across transports and stops before another HTTP call", async () => {
  const httpBudget = { requests: 1, bytes: 1024, abort: new AbortController() };
  const source = () => midnightSource({ operator: "fixture", node: url, indexer: url, indexerWs: "ws://127.0.0.1:1", headers: {}, httpBudget });
  expect(await source().node.call("system_chain")).toBe("ok");
  await expect(source().node.call("system_chain")).rejects.toThrow(/budget/i);
  expect(requests).toBe(1); expect(httpBudget.abort.signal.aborted).toBe(true);
});

it("charges exact decoded bytes against a shared budget before exposing a result", async () => {
  const httpBudget = { requests: 2, bytes: Buffer.byteLength(answer) * 2 - 1, abort: new AbortController() };
  const source = midnightSource({ operator: "fixture", node: url, indexer: url, indexerWs: "ws://127.0.0.1:1", headers: {}, httpBudget });
  expect(await source.node.call("system_chain")).toBe("ok");
  expect(httpBudget.bytes).toBe(Buffer.byteLength(answer) - 1);
  await expect(source.node.call("system_chain")).rejects.toThrow(/budget/i);
  expect(httpBudget.abort.signal.aborted).toBe(true);
});

it("budget exhaustion aborts sibling requests waiting for headers", async () => {
  const httpBudget = { requests: 2, bytes: 64, abort: new AbortController() };
  const source = (path: string) => midnightSource({ operator: "fixture", node: url + path, indexer: url, indexerWs: "ws://127.0.0.1:1", headers: {}, httpBudget });
  let large: ServerResponse | undefined, stalled: ServerResponse | undefined, closed = false;
  handler = (req, res) => {
    if (req.url === "/large") large = res;
    else { stalled = res; res.on("close", () => { closed = true; }); timers.push(setTimeout(() => res.end(answer), 500)); }
    if (large && stalled) large.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(200) }));
  };
  const results = await Promise.allSettled([source("/large").node.call("system_chain"), source("/stall").node.call("system_chain")]);
  expect(results.every(result => result.status === "rejected")).toBe(true);
  await vi.waitFor(() => expect(closed).toBe(true), { timeout: 100, interval: 10 });
});
