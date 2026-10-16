import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { connect as tcp, type AddressInfo, type Socket } from "node:net";
import { connect as tls } from "node:tls";
import type { SourceEndpoints } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

export interface WalletTransport {
  indexerHttpUrl: string;
  indexerWsUrl: string;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "content-length", "upgrade"]);
const forwardable = (headers: IncomingMessage["headers"]) =>
  Object.fromEntries(Object.entries(headers).filter(([name, v]) => !HOP_BY_HOP.has(name) && typeof v === "string") as Array<[string, string]>);

// The wallet SDK's indexer clients take a bare URL and echo it into their errors, so a
// credential cannot ride in the URL. This loopback relay adds the source's credential headers
// to every indexer query and WebSocket upgrade instead; its URLs carry only a random path
// prefix, which keeps other local accounts from borrowing the credential while it runs.
export async function credentialRelay(endpoints: SourceEndpoints): Promise<WalletTransport> {
  if (Object.keys(endpoints.headers).length === 0) {
    return { indexerHttpUrl: endpoints.indexer, indexerWsUrl: endpoints.indexerWs, close: async () => undefined };
  }
  const prefix = `/${randomBytes(16).toString("hex")}`;
  const http = `${prefix}/graphql`;
  const ws = `${prefix}/graphql/ws`;
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    if (req.url !== http) return void res.writeHead(404).end();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      fetch(endpoints.indexer, {
        method: req.method ?? "POST",
        headers: { ...forwardable(req.headers), ...endpoints.headers },
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
      })
        .then(async (upstream) => {
          res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
          res.end(Buffer.from(await upstream.arrayBuffer()));
        })
        .catch((error: Error) => res.writeHead(502).end(`${endpoints.operator} indexer unreachable: ${error.name}`));
    });
  });

  server.on("upgrade", (req: IncomingMessage, client: Socket, head: Buffer) => {
    if (req.url !== ws) return void client.end("HTTP/1.1 404 Not Found\r\n\r\n");
    const target = new URL(endpoints.indexerWs);
    const secure = target.protocol === "wss:";
    const port = Number(target.port || (secure ? 443 : 80));
    const upstream = secure ? tls({ host: target.hostname, port, servername: target.hostname }) : tcp(port, target.hostname);
    sockets.add(client).add(upstream);
    const headers = { ...forwardable(req.headers), upgrade: "websocket", connection: "Upgrade", host: target.host, ...endpoints.headers };
    upstream.on(secure ? "secureConnect" : "connect", () => {
      upstream.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const end = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    upstream.on("error", end).on("close", end);
    client.on("error", end).on("close", end);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    indexerHttpUrl: `http://127.0.0.1:${port}${http}`,
    indexerWsUrl: `ws://127.0.0.1:${port}${ws}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
