import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerReplyError, connectBroker } from "../src/client.js";
import { encodeFrame, FrameDecoder } from "../src/framing.js";
import { privateDir } from "./private-dir.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const UID = process.getuid!();
const utf8 = (text: string) => new TextEncoder().encode(text);

let dir: string | undefined;
let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  if (dir) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
  server = undefined;
  dir = undefined;
});

interface Received {
  readonly id: unknown;
  readonly method: string;
  readonly params?: unknown;
}

// A stand-in broker that records every connection and request, and answers through `reply`.
async function listen(
  reply: (request: Received, socket: Socket) => unknown = request => ({ jsonrpc: "2.0", id: request.id, result: { echo: request.method } }),
  name = "rpc.sock",
): Promise<{ path: string; connections: Socket[]; requests: Received[] }> {
  dir ??= privateDir("orynq-client-");
  const path = join(dir, name);
  const connections: Socket[] = [];
  const requests: Received[] = [];
  server = createServer(socket => {
    connections.push(socket);
    const decoder = new FrameDecoder();
    socket.on("data", chunk => {
      for (const frame of decoder.push(chunk)) {
        const request = JSON.parse(new TextDecoder().decode(frame)) as Received;
        requests.push(request);
        const answer = reply(request, socket);
        if (answer !== undefined) socket.write(encodeFrame(utf8(JSON.stringify(answer))));
      }
    });
  });
  await new Promise<void>(resolve => server!.listen(path, resolve));
  return { path, connections, requests };
}

async function refusal(path: string, brokerUid = UID): Promise<Error> {
  try {
    const client = await connectBroker(path, { brokerUid });
    await client.close();
  } catch (error) {
    return error as Error;
  }
  throw new Error("connected");
}

describe("connectBroker", () => {
  it("sends each request as one frame and returns its result", async () => {
    const { path, requests } = await listen();
    const client = await connectBroker(path, { brokerUid: UID });
    expect(await client.request("broker.hello")).toEqual({ echo: "broker.hello" });
    expect(await client.request("session.open", { mandates: ["11".repeat(32)] })).toEqual({ echo: "session.open" });
    expect(requests).toEqual([
      { jsonrpc: "2.0", id: 1, method: "broker.hello" },
      { jsonrpc: "2.0", id: 2, method: "session.open", params: { mandates: ["11".repeat(32)] } },
    ]);
    await client.close();
  });

  it("sends a request only after the previous one is answered", async () => {
    const held: (() => void)[] = [];
    const { path, requests } = await listen((request, socket) => {
      held.push(() => socket.write(encodeFrame(utf8(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.id })))));
      return undefined;
    });
    const client = await connectBroker(path, { brokerUid: UID });
    const first = client.request("broker.hello");
    const second = client.request("broker.hello");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(requests).toHaveLength(1);
    held.shift()!();
    expect(await first).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(requests).toHaveLength(2);
    held.shift()!();
    expect(await second).toBe(2);
    await client.close();
  });

  it("rejects an error reply with its code, message and field", async () => {
    const { path } = await listen(request => ({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32011, message: "Mandate refused", data: { field: "params.mandates[1]" } },
    }));
    const client = await connectBroker(path, { brokerUid: UID });
    const error = await client.request("session.open").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BrokerReplyError);
    expect(error).toMatchObject({ code: -32011, message: "Mandate refused", field: "params.mandates[1]" });
    await client.close();
  });

  it("refuses a reply for another request, and every request after it", async () => {
    const { path } = await listen(request => ({ jsonrpc: "2.0", id: Number(request.id) + 1, result: {} }));
    const client = await connectBroker(path, { brokerUid: UID });
    await expect(client.request("broker.hello")).rejects.toThrow("the broker answered another request");
    await expect(client.request("broker.hello")).rejects.toThrow("the broker connection is closed");
  });

  it("rejects a reply that is not strict JSON, and every request after it", async () => {
    const { path } = await listen((_, socket) => {
      socket.write(encodeFrame(utf8('{"jsonrpc":"2.0","id":1,"id":1,"result":{}}')));
      return undefined;
    });
    const client = await connectBroker(path, { brokerUid: UID });
    await expect(client.request("broker.hello")).rejects.toThrow("the broker sent an unreadable reply");
    await expect(client.request("broker.hello")).rejects.toThrow("the broker connection is closed");
  });

  it("rejects a pending request when the broker closes the connection", async () => {
    const { path } = await listen((_, socket) => {
      socket.end();
      return undefined;
    });
    const client = await connectBroker(path, { brokerUid: UID });
    await expect(client.request("broker.hello")).rejects.toThrow("the broker connection is closed");
  });

  it("refuses a socket another account owns before connecting to it", async () => {
    const { path, connections } = await listen();
    const error = await refusal(path, UID + 1);
    expect(error.message).toBe(`${path} is not a socket owned by uid ${UID + 1}`);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(connections).toEqual([]);
  });

  it("refuses a symlink, a file and a missing path without following or creating anything", async () => {
    const { path, connections } = await listen();
    const link = join(dir!, "link.sock");
    symlinkSync(path, link);
    const file = join(dir!, "file.sock");
    writeFileSync(file, "x");
    for (const candidate of [link, file]) {
      expect((await refusal(candidate)).message).toBe(`${candidate} is not a socket owned by uid ${UID}`);
    }
    expect((await refusal(join(dir!, "missing.sock"))).message).toMatch(/ENOENT/);
    expect((await refusal("relative.sock")).message).toBe("the broker socket path must be absolute");
    expect(connections).toEqual([]);
  });

  it("refuses a socket in a directory its group or others can write, sticky or not", async () => {
    const { path, connections } = await listen();
    for (const mode of [0o777, 0o1777, 0o770, 0o1770, 0o730, 0o702]) {
      chmodSync(dir!, mode);
      expect((await refusal(path)).message, mode.toString(8)).toBe(`${dir} lets other accounts replace the broker socket`);
    }
    chmodSync(dir!, 0o755);
    const client = await connectBroker(path, { brokerUid: UID });
    await client.close();
    expect(connections).toHaveLength(1);
  });

  it("refuses a socket below a directory another account can write, however far above it", async () => {
    dir = privateDir("orynq-client-");
    mkdirSync(join(dir, "inner", "deeper"), { recursive: true, mode: 0o700 });
    chmodSync(join(dir, "inner"), 0o700);
    chmodSync(join(dir, "inner", "deeper"), 0o700);
    const { path, connections } = await listen(undefined, join("inner", "deeper", "rpc.sock"));
    chmodSync(dir, 0o770);
    expect((await refusal(path)).message).toBe(`${dir} lets other accounts replace the broker socket`);
    chmodSync(dir, 0o700);
    chmodSync(join(dir, "inner"), 0o707);
    expect((await refusal(path)).message).toBe(`${join(dir, "inner")} lets other accounts replace the broker socket`);
    expect(connections).toEqual([]);
  });

  // Only root can give a directory to another account, so the owner lstat reports is altered here.
  it("refuses a socket in a directory that neither root nor the broker owns", async () => {
    const { path, connections } = await listen();
    const owned = realpathSync(dir!);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(lstat).mockImplementation(async target => {
      const stats = await actual.lstat(target);
      return target === owned ? Object.assign(stats, { uid: UID + 1 }) : stats;
    });
    try {
      expect((await refusal(path)).message).toBe(`${owned} lets other accounts replace the broker socket`);
    } finally {
      vi.mocked(lstat).mockImplementation(actual.lstat);
    }
    expect(connections).toEqual([]);
    const client = await connectBroker(path, { brokerUid: UID });
    await client.close();
  });

  it("refuses a socket whose mode does not let this account connect", async () => {
    const { path, connections } = await listen();
    chmodSync(path, 0o400);
    expect((await refusal(path)).message).toBe(`the mode of ${path} does not let this account connect`);
    expect(connections).toEqual([]);
  });

  it("follows a symlinked directory to the socket it names, checking the directory it reaches", async () => {
    const { connections } = await listen();
    const alias = join(dir!, "alias");
    symlinkSync(dir!, alias);
    const client = await connectBroker(join(alias, "rpc.sock"), { brokerUid: UID });
    expect(await client.request("broker.hello")).toEqual({ echo: "broker.hello" });
    await client.close();
    chmodSync(dir!, 0o777);
    expect((await refusal(join(alias, "rpc.sock"))).message).toBe(`${dir} lets other accounts replace the broker socket`);
    expect(connections).toHaveLength(1);
  });
});
