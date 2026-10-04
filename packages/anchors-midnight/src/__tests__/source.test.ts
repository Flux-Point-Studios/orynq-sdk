import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockfrostEndpoints, finalityRpc, midnightSource } from "../source.js";

const TOKEN = "mainnetSECRETtoken0123456789abcdefABCDEF";

// A node and indexer that answer from `handlers`, and echo every request header back in their
// error bodies, the way a misconfigured proxy might.
let server: Server;
let base = "";
const seen: Array<{ url: string; headers: IncomingMessage["headers"]; body: unknown }> = [];
let handler: (body: any) => { status?: number; json?: unknown; text?: string } = () => ({ status: 404 });
beforeAll(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = data ? JSON.parse(data) : undefined;
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      const out = handler(body);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(out.text ?? JSON.stringify(out.json ?? { echoed: req.headers }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const source = () => midnightSource({ operator: "test", indexer: `${base}/indexer`, indexerWs: "ws://127.0.0.1:1/ws", node: `${base}/node`, headers: { project_id: TOKEN } });
const failure = async (p: Promise<unknown>) => (await p.then(() => "resolved", (e: Error) => e.message)) as string;

describe("midnightSource", () => {
  it("calls node JSON-RPC with the credential in a header, never in the URL", async () => {
    handler = (b) => ({ json: { jsonrpc: "2.0", id: b.id, result: "Midnight Mainnet" } });
    expect(await source().node.call("system_chain")).toBe("Midnight Mainnet");
    const last = seen.at(-1)!;
    expect(last.url).toBe("/node");
    expect(last.headers.project_id).toBe(TOKEN);
    expect(last.body).toMatchObject({ jsonrpc: "2.0", method: "system_chain", params: [] });
  });

  it("sends a batch as one request and returns the answers in request order", async () => {
    handler = (b) => ({ json: [...b].reverse().map((c: any) => ({ jsonrpc: "2.0", id: c.id, result: c.params[0] * 2 })) });
    const before = seen.length;
    expect(await source().node.batch([["double", [1]], ["double", [2]], ["double", [3]]])).toEqual([2, 4, 6]);
    expect(seen.length - before).toBe(1);
  });

  it("refuses a batch answer that misses a request or carries an error", async () => {
    handler = (b) => ({ json: b.slice(1).map((c: any) => ({ jsonrpc: "2.0", id: c.id, result: 1 })) });
    expect(await failure(source().node.batch([["a", []], ["b", []]]))).toMatch(/test node: no answer to a/);
    handler = (b) => ({ json: b.map((c: any) => ({ jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "boom" } })) });
    expect(await failure(source().node.batch([["a", []]]))).toMatch(/test node: a failed: .*boom/);
  });

  it("never lets the credential into an error, from a status, a JSON-RPC error or a body that echoes it", async () => {
    handler = () => ({ status: 500, text: `upstream refused project_id=${TOKEN}` });
    const fromStatus = await failure(source().node.call("system_chain"));
    handler = (b) => ({ json: { jsonrpc: "2.0", id: b.id, error: { code: 1, message: `bad key ${TOKEN}` } } });
    const fromRpc = await failure(source().node.call("system_chain"));
    handler = () => ({ status: 403 });
    const fromEcho = await failure(source().indexer.transactions("ab".repeat(32)));
    for (const message of [fromStatus, fromRpc, fromEcho]) {
      expect(message).toContain("<redacted>");
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(TOKEN.slice(8, 24));
    }
  });

  it("asks the indexer for a transaction by hash with GraphQL variables and maps what it returns", async () => {
    handler = (b) => ({
      json: {
        data: {
          transactions: [
            {
              __typename: "RegularTransaction",
              hash: b.variables.hash,
              raw: "00ff",
              block: { height: 7, hash: "cd".repeat(32), timestamp: 1791124488001 },
              transactionResult: { status: "SUCCESS" },
              contractActions: [{ __typename: "ContractCall", address: "ef".repeat(32), state: "0102", entryPoint: "anchor" }],
            },
          ],
        },
      },
    });
    const [tx] = await source().indexer.transactions("ab".repeat(32));
    expect(tx).toEqual({
      hash: "ab".repeat(32),
      raw: "00ff",
      block: { height: 7, hash: "cd".repeat(32), timestamp: 1791124488001 },
      status: "SUCCESS",
      contractActions: [{ kind: "ContractCall", address: "ef".repeat(32), state: "0102", entryPoint: "anchor" }],
    });
    expect(seen.at(-1)!.body).toMatchObject({ variables: { hash: "ab".repeat(32) } });
    expect((seen.at(-1)!.body as { query: string }).query).not.toContain("ab".repeat(32));
  });

  it("refuses to ask the indexer about anything but a 32-byte hash", async () => {
    expect(await failure(source().indexer.transactions('"){ __schema { types { name } } }'))).toMatch(/must be 64 lowercase hex/);
  });

  it("finalityRpc batches grandpa_proveFinality and chain_getHeader through the node", async () => {
    handler = (b) => ({ json: b.map((c: any) => ({ jsonrpc: "2.0", id: c.id, result: c.method === "grandpa_proveFinality" ? (c.params[0] === 2 ? null : "0x0a0b") : { number: "0x1" } })) });
    const rpc = finalityRpc(source());
    expect(await rpc.proveFinality([1, 2])).toEqual([new Uint8Array([10, 11]), null]);
    expect(await rpc.headers(["0x" + "aa".repeat(32)])).toEqual([{ number: "0x1" }]);
    expect(seen.at(-1)!.body).toMatchObject([{ method: "chain_getHeader", params: ["0x" + "aa".repeat(32)] }]);
  });
});

describe("blockfrostEndpoints", () => {
  const dir = mkdtempSync(join(tmpdir(), "orynq-blockfrost-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the project id from a file only its owner can read and names Blockfrost's Midnight hosts", () => {
    const file = join(dir, "mainnet.project_id");
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
    const e = blockfrostEndpoints("mainnet", file);
    expect(e).toEqual({
      operator: "blockfrost",
      indexer: "https://midnight-mainnet.blockfrost.io/api/v0",
      indexerWs: "wss://midnight-mainnet.blockfrost.io/api/v0/ws",
      node: "https://rpc.midnight-mainnet.blockfrost.io",
      headers: { project_id: TOKEN },
    });
    expect(blockfrostEndpoints("preprod", file).node).toBe("https://rpc.midnight-preprod.blockfrost.io");
  });

  it("refuses a project id file group or others can read, without echoing it", () => {
    const file = join(dir, "open.project_id");
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
    chmodSync(file, 0o644);
    let message = "";
    try {
      blockfrostEndpoints("mainnet", file);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/open\.project_id can be read or written by group or others/);
    expect(message).not.toContain(TOKEN.slice(4, 20));
  });
});

// A WebSocket that plays the indexer's side of graphql-transport-ws from a script.
class ScriptedSocket {
  static last: ScriptedSocket;
  static script: (socket: ScriptedSocket, message: { type: string; id?: string; payload?: any }) => void = () => {};
  readonly sent: Array<{ type: string; id?: string; payload?: any }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: ((e: { message?: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  closed = false;
  constructor(
    readonly url: string,
    readonly init: { protocols: string[]; headers: Record<string, string> },
  ) {
    ScriptedSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    const message = JSON.parse(data);
    this.sent.push(message);
    queueMicrotask(() => ScriptedSocket.script(this, message));
  }
  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  close() {
    this.closed = true;
  }
}

describe("midnightSource's indexer subscription", () => {
  const action = (height: number, id: number) => ({ transaction: { id, hash: `${String(id).padStart(2, "0")}`.repeat(32), raw: "00ff", block: { height, hash: "cd".repeat(32) } } });
  const withSockets = async <T>(script: typeof ScriptedSocket.script, run: () => Promise<T>) => {
    const original = globalThis.WebSocket;
    ScriptedSocket.script = script;
    (globalThis as { WebSocket: unknown }).WebSocket = ScriptedSocket;
    try {
      return await run();
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = original;
    }
  };
  const src = () => midnightSource({ operator: "test", indexer: `${base}/indexer`, indexerWs: "ws://127.0.0.1:1/ws", node: `${base}/node`, headers: { project_id: TOKEN } });

  it("subscribes with the credential in a header, never in the URL, and yields actions in order until closed", async () => {
    const got = await withSockets(
      (socket, m) => {
        if (m.type === "connection_init") socket.emit({ type: "connection_ack" });
        if (m.type === "subscribe") for (const [h, id] of [[10, 1], [12, 2], [15, 3]]) socket.emit({ id: m.id, type: "next", payload: { data: { contractActions: action(h!, id!) } } });
      },
      async () => {
        const out = [];
        const actions = src().indexer.contractActions("ef".repeat(32), 10);
        for await (const a of actions) {
          out.push(a);
          if (out.length === 2) break;
        }
        return out;
      },
    );
    expect(got).toEqual([
      { txHash: "01".repeat(32), transactionId: 1, raw: "00ff", block: { height: 10, hash: "cd".repeat(32) } },
      { txHash: "02".repeat(32), transactionId: 2, raw: "00ff", block: { height: 12, hash: "cd".repeat(32) } },
    ]);
    const socket = ScriptedSocket.last;
    expect(socket.url).toBe("ws://127.0.0.1:1/ws");
    expect(socket.init).toEqual({ protocols: ["graphql-transport-ws"], headers: { project_id: TOKEN } });
    expect(socket.sent[1]).toMatchObject({ type: "subscribe", payload: { variables: { address: "ef".repeat(32), height: 10 } } });
    expect(socket.sent.at(-1)).toMatchObject({ type: "complete" });
    expect(socket.closed).toBe(true);
  });

  it("rejects with the indexer's error, redacted, and refuses an address that is not 32 bytes", async () => {
    const message = await withSockets(
      (socket, m) => {
        if (m.type === "connection_init") socket.emit({ type: "connection_ack" });
        if (m.type === "subscribe") socket.emit({ id: m.id, type: "error", payload: [{ message: `rate limited for ${TOKEN}` }] });
      },
      async () => failure((async () => {
        for await (const _ of src().indexer.contractActions("ef".repeat(32), 1)) void _;
      })()),
    );
    expect(message).toMatch(/test indexer subscription: .*rate limited for <redacted>/);
    expect(ScriptedSocket.last.closed).toBe(true);
    expect(await failure((async () => {
      for await (const _ of src().indexer.contractActions("zz", 1)) void _;
    })())).toMatch(/must be 64 lowercase hex/);
  });

  it("reads the indexer's head block and a contract's newest action over HTTP", async () => {
    handler = (b) =>
      b.query.includes("contract(")
        ? { json: { data: { contract: { actions: [{ transaction: { id: 9, block: { height: 70 } } }] } } } }
        : { json: { data: { block: { height: 99, hash: "ab".repeat(32), timestamp: 1791124488001 } } } };
    expect(await src().indexer.head()).toEqual({ height: 99, hash: "ab".repeat(32), timestamp: 1791124488001 });
    expect(await src().indexer.latestAction("ef".repeat(32))).toEqual({ height: 70, transactionId: 9 });
    handler = () => ({ json: { data: { contract: null } } });
    expect(await src().indexer.latestAction("ef".repeat(32))).toBeNull();
  });
});
