import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonToCbor } from "../src/dcbor.js";
import { RpcError } from "../src/errors.js";
import {
  decodeRequest,
  encodeFrame,
  FrameDecoder,
  FrameError,
  IDLE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  serveConnection,
  type CloseReason,
  type RequestHandler,
  type RpcRequest,
} from "../src/framing.js";
import { METHOD_PARAMS, SCHEMA_RULES } from "../src/schema.js";

const utf8 = (text: string) => new TextEncoder().encode(text);
const json = (value: unknown) => utf8(JSON.stringify(value));
const header = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
const request = (id: unknown, method = "broker.hello", params: unknown = {}) => json({ jsonrpc: "2.0", id, method, params });
const decoded = (frames: Uint8Array[]) => frames.map(frame => JSON.parse(new TextDecoder().decode(frame)) as Record<string, unknown>);

function frameError(f: () => unknown): FrameError {
  try {
    f();
  } catch (error) {
    expect(error).toBeInstanceOf(FrameError);
    return error as FrameError;
  }
  throw new Error("accepted");
}

function rpcError(payload: Uint8Array): RpcError {
  try {
    decodeRequest(payload);
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    return error as RpcError;
  }
  throw new Error("accepted");
}

describe("frames", () => {
  it("prefix the payload with its uint32 big-endian length", () => {
    expect([...encodeFrame(Uint8Array.of(7, 8, 9))]).toEqual([0, 0, 0, 3, 7, 8, 9]);
    expect([...encodeFrame(new Uint8Array(0x00fedcba)).subarray(0, 4)]).toEqual([0x00, 0xfe, 0xdc, 0xba]);
  });

  it("hold 1 to 16 MiB", () => {
    expect(MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
    expect(encodeFrame(new Uint8Array(MAX_FRAME_BYTES))).toHaveLength(MAX_FRAME_BYTES + 4);
    expect(frameError(() => encodeFrame(new Uint8Array(0))).code).toBe("FRAME_EMPTY");
    expect(frameError(() => encodeFrame(new Uint8Array(MAX_FRAME_BYTES + 1))).code).toBe("FRAME_OVERSIZE");
  });
});

describe("FrameDecoder", () => {
  it("returns a frame that arrives whole", () => {
    expect(new FrameDecoder().push(encodeFrame(utf8("{}")))).toEqual([utf8("{}")]);
  });

  it("reassembles a frame from single bytes, the header included", () => {
    const decoder = new FrameDecoder();
    const bytes = encodeFrame(utf8('{"a":1}'));
    for (let i = 0; i < bytes.length - 1; i++) {
      expect(decoder.push(bytes.subarray(i, i + 1))).toEqual([]);
      expect(decoder.buffered).toBe(i + 1);
    }
    expect(decoder.push(bytes.subarray(bytes.length - 1))).toEqual([utf8('{"a":1}')]);
    expect(decoder.buffered).toBe(0);
  });

  it("splits several frames and keeps a partial tail", () => {
    const decoder = new FrameDecoder();
    const tail = encodeFrame(utf8("[3]"));
    const chunk = Buffer.concat([encodeFrame(utf8("1")), encodeFrame(utf8("22")), tail.subarray(0, 5)]);
    expect(decoder.push(chunk)).toEqual([utf8("1"), utf8("22")]);
    expect(decoder.buffered).toBe(5);
    expect(decoder.push(tail.subarray(5))).toEqual([utf8("[3]")]);
  });

  it("does not keep a view of the caller's chunk", () => {
    const decoder = new FrameDecoder();
    const chunk = encodeFrame(utf8("ab"));
    const [frame] = decoder.push(chunk);
    chunk.fill(0);
    expect(frame).toEqual(utf8("ab"));
  });

  it("refuses N = 0", () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(header(0).subarray(0, 3))).toEqual([]);
    expect(frameError(() => decoder.push(header(0).subarray(3))).code).toBe("FRAME_EMPTY");
  });

  it("refuses an oversize length from the header alone, before allocating", () => {
    for (const n of [MAX_FRAME_BYTES + 1, 0xffffffff]) {
      const decoder = new FrameDecoder();
      const before = process.memoryUsage().arrayBuffers;
      expect(frameError(() => decoder.push(header(n))).code).toBe("FRAME_OVERSIZE");
      expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(1024 * 1024);
    }
    expect(new FrameDecoder().push(header(MAX_FRAME_BYTES))).toEqual([]);
  });

  it("allocates payload memory as bytes arrive, not when a header announces them", () => {
    const before = process.memoryUsage().arrayBuffers;
    const decoders = Array.from({ length: 64 }, () => {
      const decoder = new FrameDecoder();
      decoder.push(header(MAX_FRAME_BYTES));
      decoder.push(new Uint8Array(1000));
      return decoder;
    });
    expect(decoders.every(decoder => decoder.buffered === 1004)).toBe(true);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(1024 * 1024);
  });

  it("returns a frame in a buffer of exactly its length, however it arrived", () => {
    const payload = Uint8Array.from({ length: 300_000 }, (_, i) => i % 251);
    const bytes = encodeFrame(payload);
    for (const cuts of [[], [5], [4, 5, 70_000], [1, 2, 3, 4, 100, 299_999]]) {
      const decoder = new FrameDecoder();
      const frames: Uint8Array[] = [];
      [0, ...cuts, bytes.length].reduce((start, end) => {
        frames.push(...decoder.push(bytes.subarray(start, end)));
        return end;
      });
      expect(frames).toHaveLength(1);
      expect(frames[0]).toEqual(payload);
      expect(frames[0]!.buffer.byteLength).toBe(payload.length);
    }
  });

  it("rethrows its first framing error on every later push, an empty one included", () => {
    const decoder = new FrameDecoder();
    const first = frameError(() => decoder.push(header(0)));
    expect(frameError(() => decoder.push(encodeFrame(utf8("{}"))))).toBe(first);
    expect(frameError(() => decoder.push(new Uint8Array(0)))).toBe(first);
  });
});

describe("decodeRequest", () => {
  it("returns one JSON-RPC 2.0 request with its id, method and params", () => {
    expect(decodeRequest(request(7, "intent.submit", { kind: "x" }))).toEqual({ id: 7, method: "intent.submit", params: { kind: "x" } });
    expect(decodeRequest(request("a-1"))).toMatchObject({ id: "a-1" });
    expect(decodeRequest(request(0))).toMatchObject({ id: 0 });
    expect(decodeRequest(request(2 ** 53))).toMatchObject({ id: 2 ** 53 });
    expect(decodeRequest(request("é".repeat(64)))).toMatchObject({ id: "é".repeat(64) });
  });

  it("refuses frames outside 1 to 16 MiB as framing errors", () => {
    expect(frameError(() => decodeRequest(new Uint8Array(0))).code).toBe("FRAME_EMPTY");
    expect(frameError(() => decodeRequest(new Uint8Array(MAX_FRAME_BYTES + 1))).code).toBe("FRAME_OVERSIZE");
  });

  it("answers what is not strict JSON with -32700", () => {
    for (const payload of [utf8("{"), utf8('{"jsonrpc":"2.0","id":1,"id":2,"method":"a.b","params":{}}'), Uint8Array.of(0xff), utf8(`[${"1".repeat(30)}]`)]) {
      expect(rpcError(payload).code).toBe(-32700);
    }
  });

  it("refuses batches and non-objects with -32600", () => {
    for (const value of [[JSON.parse(new TextDecoder().decode(request(1)))], [], "x", 1, null]) {
      expect(rpcError(json(value)).code).toBe(-32600);
    }
  });

  it("refuses id-less, null and malformed ids with -32600", () => {
    const { id: _, ...noId } = JSON.parse(new TextDecoder().decode(request(1))) as Record<string, unknown>;
    expect(rpcError(json(noId)).code).toBe(-32600);
    for (const id of [null, 1.5, -1, "", "x".repeat(129), "é".repeat(65), {}, [1], true]) {
      expect(rpcError(request(id)).code).toBe(-32600);
    }
  });

  it("refuses a wrong version, a malformed method and unknown members with -32600", () => {
    for (const jsonrpc of [undefined, "1.0", 2]) {
      expect(rpcError(json({ jsonrpc, id: 1, method: "broker.hello", params: {} })).code).toBe(-32600);
    }
    for (const method of [undefined, "", "broker", "Broker.hello", "broker.hello\n", "broker..hello", "broker.hello.", `a.${"b".repeat(63)}`, 1]) {
      expect(rpcError(json({ jsonrpc: "2.0", id: 1, method, params: {} })).code).toBe(-32600);
    }
    expect(rpcError(json({ jsonrpc: "2.0", id: 1, method: "broker.hello", params: {}, extra: 1 })).code).toBe(-32600);
  });

  it("reads omitted params as {}, as JSON-RPC 2.0 allows, and leaves any other params to the method's schema", () => {
    expect(decodeRequest(json({ jsonrpc: "2.0", id: 1, method: "broker.hello" }))).toEqual({ id: 1, method: "broker.hello", params: {} });
    for (const params of [[], null, "x", 1]) {
      expect(decodeRequest(request(1, "broker.hello", params)).params).toEqual(params);
    }
  });
});

// A server end whose client side the test drives directly.
function pair() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = Duplex.from({ readable: toServer, writable: toClient });
  const decoder = new FrameDecoder();
  const replies: Uint8Array[] = [];
  toClient.on("data", (chunk: Buffer) => replies.push(...decoder.push(chunk)));
  return { server, replies, send: (bytes: Uint8Array) => toServer.write(bytes), end: () => toServer.end() };
}

const echo: RequestHandler = async (req: RpcRequest) => json({ jsonrpc: "2.0", id: req.id, result: { method: req.method } });

describe("serveConnection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers one request per frame, in turn, until the client ends", async () => {
    const { server, replies, send, end } = pair();
    const closed = serveConnection(server, echo);
    send(encodeFrame(request(1)));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    send(encodeFrame(request(2, "credential.list")));
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(decoded(replies)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { method: "broker.hello" } },
      { jsonrpc: "2.0", id: 2, result: { method: "credential.list" } },
    ]);
    end();
    await expect(closed).resolves.toBe("end");
  });

  it("answers undecodable requests with id null and keeps serving", async () => {
    const { server, replies, send, end } = pair();
    const closed = serveConnection(server, echo);
    send(encodeFrame(utf8('{"jsonrpc":"2.0","id":1,"id":1,"method":"a.b","params":{}}')));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    send(encodeFrame(json([1])));
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    send(encodeFrame(request(3)));
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(decoded(replies)).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
      { jsonrpc: "2.0", id: 3, result: { method: "broker.hello" } },
    ]);
    end();
    await expect(closed).resolves.toBe("end");
  });

  it("answers a handler's RpcError with the request id and the decoder path", async () => {
    const { server, replies, send, end } = pair();
    const closed = serveConnection(server, async () => {
      throw new RpcError("INVALID_PARAMS", { field: "params.mandates[0]" });
    });
    send(encodeFrame(request("q")));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(decoded(replies)).toEqual([
      { jsonrpc: "2.0", id: "q", error: { code: -32602, message: "Invalid params", data: { field: "params.mandates[0]" } } },
    ]);
    end();
    await expect(closed).resolves.toBe("end");
  });

  it("answers params its schema refuses with the request id", async () => {
    const { server, replies, send, end } = pair();
    const closed = serveConnection(server, async req => {
      jsonToCbor(req.params, SCHEMA_RULES[METHOD_PARAMS[req.method as keyof typeof METHOD_PARAMS]]);
      return echo(req);
    });
    const requests = [
      json({ jsonrpc: "2.0", id: 5, method: "broker.hello" }),
      json({ jsonrpc: "2.0", id: 6, method: "mandate.get" }),
      request(7, "mandate.get", ["11".repeat(32)]),
      request(8, "mandate.get", { mandate: "11".repeat(32) }),
    ];
    for (const [i, payload] of requests.entries()) {
      send(encodeFrame(payload));
      await vi.waitFor(() => expect(replies).toHaveLength(i + 1));
    }
    expect(decoded(replies)).toEqual([
      { jsonrpc: "2.0", id: 5, result: { method: "broker.hello" } },
      { jsonrpc: "2.0", id: 6, error: { code: -32602, message: "Invalid params", data: { field: "params.mandate" } } },
      { jsonrpc: "2.0", id: 7, error: { code: -32602, message: "Invalid params", data: { field: "params" } } },
      { jsonrpc: "2.0", id: 8, result: { method: "mandate.get" } },
    ]);
    end();
    await expect(closed).resolves.toBe("end");
  });

  it("rejects with any other handler failure and closes the connection", async () => {
    const { server, send } = pair();
    const failure = new Error("vault unavailable");
    const closed = serveConnection(server, async () => {
      throw failure;
    });
    send(encodeFrame(request(1)));
    await expect(closed).rejects.toBe(failure);
    expect(server.destroyed).toBe(true);
  });

  it.each([
    ["a string naming a close reason", "end"],
    ["undefined", undefined],
    ["a number", 42],
  ])("rejects with an Error when the handler throws %s, so a failure never reads as a close", async (_, thrown) => {
    const { server, send } = pair();
    const closed = serveConnection(server, async () => {
      throw thrown;
    });
    send(encodeFrame(request(1)));
    await expect(closed).rejects.toThrow(new Error("request handling failed with a value that is not an Error"));
    await expect(closed).rejects.toHaveProperty("cause", thrown);
    expect(server.destroyed).toBe(true);
  });

  it("rejects a stream that carries text instead of bytes, before decoding", async () => {
    const { server, send } = pair();
    server.setEncoding("utf8");
    const handle = vi.fn(echo);
    const closed = serveConnection(server, handle);
    send(encodeFrame(request(1)));
    await expect(closed).rejects.toThrow(new TypeError("the stream must carry bytes"));
    expect(handle).not.toHaveBeenCalled();
    expect(server.destroyed).toBe(true);
  });

  it("rejects a stream that ends its write side when the client half-closes", async () => {
    const stream = new Duplex({ allowHalfOpen: false, read() {}, write: (_chunk, _encoding, done) => done() });
    const handle = vi.fn(echo);
    const outcome = serveConnection(stream, handle).then(
      reason => `resolved ${reason}`,
      (error: Error) => `${error.name}: ${error.message}`,
    );
    stream.push(encodeFrame(request(1)));
    const pending = new Promise(resolve => setImmediate(() => resolve("pending")));
    expect(await Promise.race([outcome, pending])).toBe("TypeError: the stream must allow half-open so a reply can follow the client's FIN");
    expect(handle).not.toHaveBeenCalled();
    expect(stream.destroyed).toBe(true);
  });

  it("closes on a framing error without calling the handler", async () => {
    for (const bytes of [header(0), header(MAX_FRAME_BYTES + 1)]) {
      const { server, replies, send } = pair();
      const handle = vi.fn(echo);
      const closed = serveConnection(server, handle);
      send(bytes);
      await expect(closed).resolves.toBe("frame");
      expect(handle).not.toHaveBeenCalled();
      expect(replies).toEqual([]);
      expect(server.destroyed).toBe(true);
    }
  });

  it("refuses a second request that arrives with the first", async () => {
    const { server, replies, send } = pair();
    const handle = vi.fn(echo);
    const closed = serveConnection(server, handle);
    send(Buffer.concat([encodeFrame(request(1)), encodeFrame(request(2))]));
    await expect(closed).resolves.toBe("concurrent");
    expect(handle).not.toHaveBeenCalled();
    expect(replies).toEqual([]);
  });

  it("refuses a request whose chunk already starts the next one", async () => {
    const { server, replies, send } = pair();
    const handle = vi.fn(echo);
    const closed = serveConnection(server, handle);
    send(Buffer.concat([encodeFrame(request(1)), header(10).subarray(0, 3)]));
    await expect(closed).resolves.toBe("concurrent");
    expect(handle).not.toHaveBeenCalled();
    expect(replies).toEqual([]);
  });

  it("refuses bytes of a next request that arrive before the reply", async () => {
    const { server, replies, send } = pair();
    let release!: () => void;
    const closed = serveConnection(server, async req => {
      await new Promise<void>(resolve => { release = resolve; });
      return echo(req);
    });
    send(encodeFrame(request(1)));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    send(header(10).subarray(0, 1));
    await expect(closed).resolves.toBe("concurrent");
    release();
    await new Promise(resolve => setImmediate(resolve));
    expect(replies).toEqual([]);
  });

  it(`closes a connection that completes no request for ${IDLE_TIMEOUT_MS / 1000} s, partial frames included`, async () => {
    vi.useFakeTimers();
    expect(IDLE_TIMEOUT_MS).toBe(300_000);
    const { server, send } = pair();
    let reason: CloseReason | undefined;
    void serveConnection(server, echo).then(r => { reason = r; });
    await vi.advanceTimersByTimeAsync(100_000);
    send(encodeFrame(request(1)).subarray(0, 6));
    await vi.advanceTimersByTimeAsync(199_999);
    expect(reason).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(reason).toBe("idle");
    expect(server.destroyed).toBe(true);
  });

  it("restarts the idle clock after each reply and stops it while a request runs", async () => {
    vi.useFakeTimers();
    const { server, replies, send } = pair();
    let reason: CloseReason | undefined;
    const closed = serveConnection(server, async req => {
      await new Promise(resolve => setTimeout(resolve, 400_000));
      return echo(req);
    });
    void closed.then(r => { reason = r; });
    await vi.advanceTimersByTimeAsync(200_000);
    send(encodeFrame(request(1)));
    await vi.advanceTimersByTimeAsync(400_000);
    expect(replies).toHaveLength(1);
    expect(reason).toBeUndefined();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(reason).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(reason).toBe("idle");
  });
});

describe("serveConnection over a Unix domain socket", () => {
  let dir: string | undefined;
  let listener: Server | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await new Promise<void>(resolve => (listener ? listener.close(() => resolve()) : resolve()));
    if (dir) rmSync(dir, { recursive: true, force: true });
    listener = undefined;
    dir = undefined;
  });

  // A rejection is recorded as `rejected <code or message>`, so a test sees it next to the reasons.
  async function listen(handle: RequestHandler = echo): Promise<{ path: string; reasons: string[]; sockets: Socket[] }> {
    dir = mkdtempSync(join(tmpdir(), "orynq-broker-framing-"));
    const path = join(dir, "rpc.sock");
    const reasons: string[] = [];
    const sockets: Socket[] = [];
    listener = createServer({ allowHalfOpen: true }, socket => {
      sockets.push(socket);
      void serveConnection(socket, handle).then(
        (reason: CloseReason) => reasons.push(reason),
        (error: NodeJS.ErrnoException) => reasons.push(`rejected ${error.code ?? error.message}`),
      );
    });
    await new Promise<void>(resolve => listener!.listen(path, resolve));
    return { path, reasons, sockets };
  }

  const turns = async (n: number) => {
    for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve));
  };
  const bigReply = (req: RpcRequest) => json({ jsonrpc: "2.0", id: req.id, result: "x".repeat(8 * 1024 * 1024) });

  it(`closes a connection whose client leaves its reply unread for ${IDLE_TIMEOUT_MS / 1000} s`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let answered = false;
    const { path, reasons, sockets } = await listen(async req => {
      answered = true;
      return bigReply(req);
    });
    const { socket } = await connect(path);
    socket.pause();
    socket.write(encodeFrame(request(1)));
    while (!answered) await turns(1);
    await turns(10);
    const [server] = sockets;
    expect(server!.writableLength).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    await turns(10);
    expect(reasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await turns(10);
    expect(reasons).toEqual(["idle"]);
    expect(server!.destroyed).toBe(true);
    socket.destroy();
  });

  it("answers a request whose client half-closes after sending it, then closes", async () => {
    const handle = vi.fn(async (req: RpcRequest) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return echo(req);
    });
    const { path, reasons } = await listen(handle);
    const { socket, replies, closed } = await connect(path, { allowHalfOpen: true });
    socket.end(encodeFrame(request(9)));
    await closed;
    expect(handle).toHaveBeenCalledTimes(1);
    expect(decoded(replies)).toEqual([{ jsonrpc: "2.0", id: 9, result: { method: "broker.hello" } }]);
    await vi.waitFor(() => expect(reasons).toEqual(["end"]));
  });

  it("resolves 'reset' when the client vanishes while its reply is written", async () => {
    const { path, reasons } = await listen(async req => bigReply(req));
    for (let i = 0; i < 5; i++) {
      const { socket, closed } = await connect(path);
      socket.once("data", () => socket.destroy());
      socket.write(encodeFrame(request(i)));
      await closed;
      await vi.waitFor(() => expect(reasons).toHaveLength(i + 1));
    }
    expect(reasons).toEqual(Array(5).fill("reset"));
  });

  async function connect(path: string, options: { allowHalfOpen?: boolean } = {}): Promise<{ socket: Socket; replies: Uint8Array[]; closed: Promise<void> }> {
    const socket = createConnection({ path, ...options });
    await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
    const decoder = new FrameDecoder();
    const replies: Uint8Array[] = [];
    socket.on("data", chunk => replies.push(...decoder.push(chunk)));
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    return { socket, replies, closed };
  }

  const pause = () => new Promise(resolve => setTimeout(resolve, 20));

  it("reassembles a request written in pieces and answers it", async () => {
    const { path, reasons } = await listen();
    const { socket, replies, closed } = await connect(path);
    const bytes = encodeFrame(request(41, "mandate.get", { mandate: "11".repeat(32) }));
    for (const [start, end] of [[0, 2], [2, 9], [9, bytes.length]]) {
      socket.write(bytes.subarray(start, end));
      await pause();
    }
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(decoded(replies)).toEqual([{ jsonrpc: "2.0", id: 41, result: { method: "mandate.get" } }]);
    socket.end();
    await closed;
    await vi.waitFor(() => expect(reasons).toEqual(["end"]));
  });

  // Before the value bound, one such request stalled the event loop for about 1.5 s and grew
  // peak RSS by about 640 MiB, and eight stalled it for 8.6 s in turn.
  it.each([
    ["empty objects", "[", (i: number) => (i < 0 ? "]" : "{}")],
    ["object members", "{", (i: number) => (i < 0 ? "}" : `"k${i}":0`)],
  ])("answers 16 MiB requests of %s from 8 clients with -32700 without stalling the event loop", async (_, open, part) => {
    const { path, reasons } = await listen();
    const parts = [`{"jsonrpc":"2.0","id":1,"method":"broker.hello","params":${open}`];
    for (let i = 0, size = parts[0]!.length + 2; size + 32 < MAX_FRAME_BYTES; i++) {
      parts.push(`${i === 0 ? "" : ","}${part(i)}`);
      size += parts[i + 1]!.length;
    }
    const frame = encodeFrame(utf8(`${parts.join("")}${part(-1)}}`));
    expect(frame.length).toBeGreaterThan(MAX_FRAME_BYTES - 64);
    const clients = await Promise.all(Array.from({ length: 8 }, () => connect(path)));
    try {
      const delay = monitorEventLoopDelay({ resolution: 10 });
      delay.enable();
      for (const { socket } of clients) socket.write(frame);
      await vi.waitFor(() => expect(clients.every(client => client.replies.length === 1)).toBe(true), { timeout: 60_000, interval: 20 });
      delay.disable();
      expect(delay.max / 1e6).toBeLessThan(400);
      for (const { replies } of clients) {
        expect(decoded(replies)).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }]);
      }
      for (const { socket } of clients) socket.end();
      await Promise.all(clients.map(client => client.closed));
      await vi.waitFor(() => expect(reasons).toEqual(Array(8).fill("end")));
    } finally {
      for (const { socket } of clients) socket.destroy();
    }
  });

  it("drops a client that sends a zero-length frame", async () => {
    const { path, reasons } = await listen();
    const { socket, replies, closed } = await connect(path);
    socket.write(header(0));
    await closed;
    expect(replies).toEqual([]);
    await vi.waitFor(() => expect(reasons).toEqual(["frame"]));
  });
});
