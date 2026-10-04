import { afterAll, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { credentialRelay } from "../src/relay.js";

const SECRET = "projectSecretValue0123456789";

// An upstream that records what reaches it: GraphQL over POST, and a WebSocket upgrade after
// which it writes "from-upstream" and records whatever bytes follow.
function upstream() {
  const seen: { posts: Array<{ url: string; headers: IncomingHttpHeaders; body: string }>; upgrades: Array<{ url: string; headers: IncomingHttpHeaders }>; tunnelled: string } = {
    posts: [],
    upgrades: [],
    tunnelled: "",
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.posts.push({ url: req.url!, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { block: { height: 7 } } }));
    });
  });
  const tunnels = new Set<import("node:stream").Duplex>();
  server.on("upgrade", (req, socket, head: Buffer) => {
    tunnels.add(socket);
    seen.tunnelled += head.toString();
    seen.upgrades.push({ url: req.url!, headers: req.headers });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nfrom-upstream");
    socket.on("data", (d) => (seen.tunnelled += d.toString()));
  });
  const close = () =>
    new Promise<void>((resolve) => {
      for (const t of tunnels) t.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return new Promise<{ base: string; seen: typeof seen; close: () => Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ base: `127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close })),
  );
}

const closers: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const close of closers) await close();
});

async function relayed() {
  const up = await upstream();
  closers.push(up.close);
  const relay = await credentialRelay({
    operator: "test",
    indexer: `http://${up.base}/api/v0`,
    indexerWs: `ws://${up.base}/api/v0/ws`,
    node: `http://${up.base}/rpc`,
    headers: { project_id: SECRET },
  });
  closers.push(() => relay.close());
  return { up, relay };
}

describe("credentialRelay", () => {
  it("hands out loopback URLs that carry no credential", async () => {
    const { relay } = await relayed();
    for (const url of [relay.indexerHttpUrl, relay.indexerWsUrl]) {
      expect(url).toMatch(/^(http|ws):\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\//);
      expect(url).not.toContain(SECRET);
    }
  });

  it("forwards indexer queries with the credential header added", async () => {
    const { up, relay } = await relayed();
    const res = await fetch(relay.indexerHttpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: '{"query":"{ block { height } }"}' });
    expect(await res.json()).toEqual({ data: { block: { height: 7 } } });
    expect(up.seen.posts).toHaveLength(1);
    expect(up.seen.posts[0]!.url).toBe("/api/v0");
    expect(up.seen.posts[0]!.headers.project_id).toBe(SECRET);
    expect(up.seen.posts[0]!.body).toBe('{"query":"{ block { height } }"}');
  });

  it("tunnels a WebSocket upgrade with the credential header added, bytes both ways", async () => {
    const { up, relay } = await relayed();
    const target = new URL(relay.indexerWsUrl);
    const socket = connect(Number(target.port), target.hostname);
    let received = "";
    socket.on("data", (d) => (received += d.toString()));
    socket.write(
      `GET ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: graphql-transport-ws\r\n\r\nfrom-client`,
    );
    await expect.poll(() => received, { timeout: 5000 }).toContain("from-upstream");
    await expect.poll(() => up.seen.tunnelled, { timeout: 5000 }).toBe("from-client");
    expect(received).toMatch(/^HTTP\/1\.1 101/);
    expect(up.seen.upgrades[0]!.url).toBe("/api/v0/ws");
    expect(up.seen.upgrades[0]!.headers.project_id).toBe(SECRET);
    expect(up.seen.upgrades[0]!.headers["sec-websocket-protocol"]).toBe("graphql-transport-ws");
    socket.destroy();
  });

  it("refuses any path outside its capability prefix", async () => {
    const { up, relay } = await relayed();
    const origin = new URL(relay.indexerHttpUrl).origin;
    const res = await fetch(`${origin}/api/v0`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(up.seen.posts).toHaveLength(0);
  });

  it("passes the URLs through untouched when the source needs no credential", async () => {
    const relay = await credentialRelay({ operator: "midnight", indexer: "https://indexer.example/api/v3/graphql", indexerWs: "wss://indexer.example/api/v3/graphql/ws", node: "https://rpc.example", headers: {} });
    expect(relay).toMatchObject({ indexerHttpUrl: "https://indexer.example/api/v3/graphql", indexerWsUrl: "wss://indexer.example/api/v3/graphql/ws" });
    await relay.close();
  });
});
