import { WebSocket, WebSocketServer } from "ws";

export interface ProxyConnection {
  id: number;
  client: WebSocket;
  upstream: WebSocket;
  /** Drop every message in both directions while the socket stays open. */
  blackhole: boolean;
  closed: boolean;
  sent: string[];
  /** Socket errors from either side; cutting a connection on purpose produces some. */
  errors: Error[];
}

/** "drop" swallows the message, "kill" terminates both sockets; a `respond` object answers locally. */
export type ClientVerdict = "drop" | "kill" | { respond: unknown } | undefined;
/** "kill-before" terminates without delivering, "kill-after" delivers and then terminates. */
export type UpstreamVerdict = "drop" | "kill-before" | "kill-after" | undefined;

export interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: { result?: unknown } & unknown[];
}

/** A loopback WebSocket proxy in front of a JSON-RPC node that can stall, rewrite or cut each connection. */
export async function startProxy(upstreamUrl: string) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  const address = server.address();
  if (typeof address === "string") throw new Error("Proxy has no port");
  const connections: ProxyConnection[] = [];
  const hooks: {
    onClient?: (connection: ProxyConnection, message: JsonRpcMessage) => ClientVerdict;
    onUpstream?: (connection: ProxyConnection, message: JsonRpcMessage) => UpstreamVerdict;
  } = {};
  const flags = { blackholeNew: false };
  const kill = (connection: ProxyConnection) => {
    connection.closed = true;
    connection.client.terminate();
    connection.upstream.terminate();
  };
  server.on("connection", client => {
    const upstream = new WebSocket(upstreamUrl);
    const connection: ProxyConnection = {
      id: connections.length + 1, client, upstream, blackhole: flags.blackholeNew, closed: false, sent: [], errors: [],
    };
    connections.push(connection);
    const queued: string[] = [];
    client.on("error", error => connection.errors.push(error));
    upstream.on("error", error => connection.errors.push(error));
    upstream.on("open", () => { for (const text of queued.splice(0)) upstream.send(text); });
    client.on("message", data => {
      const text = data.toString();
      connection.sent.push(text);
      const verdict = hooks.onClient?.(connection, parse(text));
      if (connection.blackhole || verdict === "drop") return;
      if (verdict === "kill") { kill(connection); return; }
      if (verdict) { client.send(JSON.stringify(verdict.respond)); return; }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else queued.push(text);
    });
    upstream.on("message", data => {
      const text = data.toString();
      const verdict = hooks.onUpstream?.(connection, parse(text));
      if (connection.blackhole || verdict === "drop") return;
      if (verdict === "kill-before") { kill(connection); return; }
      if (verdict === "kill-after") { client.send(text, () => kill(connection)); return; }
      client.send(text);
    });
    client.on("close", () => { connection.closed = true; upstream.terminate(); });
    upstream.on("close", () => client.terminate());
  });
  return {
    url: `ws://127.0.0.1:${address.port}`,
    connections,
    hooks,
    flags,
    kill,
    /** JSON-RPC methods every client sent through this proxy, in order. */
    methods: () => connections.flatMap(connection => connection.sent.map(text => parse(text).method)),
    close: () => new Promise<void>(resolve => {
      for (const connection of connections) kill(connection);
      server.close(() => resolve());
    }),
  };
}
export type Proxy = Awaited<ReturnType<typeof startProxy>>;

export const parse = (text: string) => JSON.parse(text) as JsonRpcMessage;

/** An `author_extrinsicUpdate` notification whose status satisfies `test`. */
export function isStatus(message: JsonRpcMessage, test: (status: unknown) => boolean): boolean {
  return message.method === "author_extrinsicUpdate" && test((message.params as { result?: unknown } | undefined)?.result);
}
