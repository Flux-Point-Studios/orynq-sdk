import { lstat, realpath } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parseStrictJson } from "@fluxpointstudios/orynq-sdk-core/utils";
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from "./framing.js";

export interface BrokerClientOptions {
  /** The uid of the broker's account, which must own the socket. */
  readonly brokerUid: number;
}

export interface BrokerClient {
  /** Sends one request and resolves with its result; requests go one at a time, in call order. */
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

// The broker answered with an error from its table (spec §6.3).
export class BrokerReplyError extends Error {
  readonly code: number;
  readonly field: string | undefined;

  constructor(code: number, message: string, field: string | undefined) {
    super(message);
    this.name = "BrokerReplyError";
    this.code = code;
    this.field = field;
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const closedError = (cause?: unknown) => new Error("the broker connection is closed", { cause });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Connecting needs write permission on the socket, from whichever class of its mode applies.
function modeGrants(mode: number, uid: number, gid: number): boolean {
  if (uid === process.getuid!()) return (mode & 0o200) !== 0;
  if ([process.getgid!(), ...process.getgroups!()].includes(gid)) return (mode & 0o020) !== 0;
  return (mode & 0o002) !== 0;
}

// The socket must be the broker's, by lstat so a symlink is never followed, and every directory
// above it may change only at root's or the broker's hand (or be sticky), so that no other account
// can swap the socket between this check and connect().
async function brokerSocket(path: string, brokerUid: number): Promise<string> {
  if (!isAbsolute(path)) throw new Error("the broker socket path must be absolute");
  let directory = await realpath(dirname(path));
  const socket = join(directory, basename(path));
  const stats = await lstat(socket);
  if (!stats.isSocket() || stats.uid !== brokerUid) throw new Error(`${path} is not a socket owned by uid ${brokerUid}`);
  if (!modeGrants(stats.mode, stats.uid, stats.gid)) throw new Error(`the mode of ${path} does not let this account connect`);
  for (;;) {
    const parent = await lstat(directory);
    const owner = parent.uid === 0 || parent.uid === brokerUid;
    const guarded = (parent.mode & 0o022) === 0 || (parent.mode & 0o1000) !== 0;
    if (!owner || !guarded) throw new Error(`${directory} lets other accounts replace the broker socket`);
    if (directory === "/") return socket;
    directory = dirname(directory);
  }
}

// Connects to the broker's socket, refusing before a byte is sent unless the broker owns it.
export async function connectBroker(path: string, options: BrokerClientOptions): Promise<BrokerClient> {
  const socketPath = await brokerSocket(path, options.brokerUid);
  const socket: Socket = createConnection({ path: socketPath });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve();
    });
  });
  const decoder = new FrameDecoder();
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  let pending: { readonly id: number; resolve(value: unknown): void; reject(error: Error): void } | undefined;
  let ended = false;
  let nextId = 1;
  let queue: Promise<unknown> = Promise.resolve();

  const end = (error: Error) => {
    ended = true;
    socket.destroy();
    pending?.reject(error);
    pending = undefined;
  };
  const settle = (frame: Uint8Array) => {
    const current = pending;
    pending = undefined;
    if (!current) return end(new Error("the broker sent a reply nobody asked for"));
    let reply: unknown;
    try {
      reply = parseStrictJson(UTF8.decode(frame), frame.byteLength);
    } catch (cause) {
      current.reject(new Error("the broker sent an unreadable reply", { cause }));
      return end(closedError());
    }
    if (!isObject(reply) || reply.jsonrpc !== "2.0" || reply.id !== current.id) {
      current.reject(new Error("the broker answered another request"));
      return end(closedError());
    }
    if (isObject(reply.error)) {
      const { code, message, data } = reply.error;
      const field = isObject(data) && typeof data.field === "string" ? data.field : undefined;
      return current.reject(new BrokerReplyError(Number(code), String(message), field));
    }
    current.resolve(reply.result);
  };
  socket.on("data", (chunk: Buffer) => {
    try {
      for (const frame of decoder.push(chunk)) settle(frame);
    } catch (error) {
      end(new Error("the broker sent an unreadable reply", { cause: error }));
    }
  });
  socket.on("error", (error: Error) => end(closedError(error)));
  socket.on("close", () => end(closedError()));

  const exchange = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (ended) return reject(closedError());
      const id = nextId++;
      const payload = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
      if (payload.length > MAX_FRAME_BYTES) return reject(new RangeError("a request must fit in 16 MiB"));
      pending = { id, resolve, reject };
      socket.write(encodeFrame(payload));
    });

  return {
    request(method, params) {
      const result = queue.then(() => exchange(method, params));
      // Callers see each failure through their own result; the queue only keeps requests in order.
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    async close() {
      socket.end();
      await closed;
    },
  };
}
