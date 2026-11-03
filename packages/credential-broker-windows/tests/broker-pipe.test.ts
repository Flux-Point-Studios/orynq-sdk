import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  decodeOpenPayload,
  encodeMuxMessage,
  MUX_CLOSE,
  MUX_FRAME,
  MUX_OPEN,
  MUX_READY,
  MuxDecoder,
  type MuxMessage,
} from "@fluxpointstudios/orynq-sdk-core/broker-wire";
import { afterEach, describe, expect, it } from "vitest";
import { type BrokerConnection, connectBroker } from "../src/client.js";
import { type PipeFrontendOptions, spawnPipeFrontend } from "../src/frontend.js";
import { openWithGenericRights, whileRestrictedTo } from "./restricted-token.js";
import { frontendExecutable, ownSid, pipeName } from "./sidecar.js";

type Sidecar = ChildProcessByStdio<Writable, Readable, Readable>;

const text = (value: string) => Buffer.from(value, "utf8");
const utf8 = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");
// "close" rather than "exit", so stderr has been read in full.
const exitOf = (child: Sidecar) =>
  new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once("close", resolve)));

// The test speaks the broker's side of the sidecar's stdio mux.
function mux(child: Sidecar) {
  const decoder = new MuxDecoder();
  const queued: MuxMessage[] = [];
  const waiting: ((message: MuxMessage) => void)[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      const waiter = waiting.shift();
      if (waiter) waiter(message);
      else queued.push(message);
    }
  });
  return {
    next: () =>
      new Promise<MuxMessage>((resolve) => {
        const message = queued.shift();
        if (message) resolve(message);
        else waiting.push(resolve);
      }),
    send: (kind: typeof MUX_FRAME | typeof MUX_CLOSE, conn: bigint, payload: Uint8Array = new Uint8Array()) =>
      child.stdin.write(encodeMuxMessage({ kind, conn, payload })),
  };
}

describe("spawnPipeFrontend", () => {
  const options = { executable: "never-spawned.exe", pipe: "\\\\.\\pipe\\orynq-broker" };

  it.each(["orynq-broker", "\\\\server\\pipe\\orynq-broker", "\\\\.\\mailslot\\orynq-broker"])(
    "refuses the pipe %s before spawning",
    (pipe) => {
      expect(() => spawnPipeFrontend({ ...options, pipe })).toThrow(RangeError);
    },
  );

  it.each(["WD", "S-1-1-0", "S-1-5-18", "S-1-5-32-545", "S-1-5-21-1-2-3", "S-1-5-21-1-2-3-1001)(A;;GA;;;WD"])(
    "refuses to admit %s before spawning",
    (sid) => {
      expect(() => spawnPipeFrontend({ ...options, admit: [sid] })).toThrow(RangeError);
    },
  );

  it.each([0, 86_401, 1.5, Number.NaN])("refuses an idle period of %s seconds before spawning", (idleSeconds) => {
    expect(() => spawnPipeFrontend({ ...options, idleSeconds })).toThrow(RangeError);
  });
});

describe.runIf(process.platform === "win32")("broker pipe", { timeout: 30_000 }, () => {
  const sidecars: Sidecar[] = [];
  const clients: BrokerConnection[] = [];
  const start = async (options: Partial<PipeFrontendOptions> = {}) => {
    const pipe = pipeName();
    const child = spawnPipeFrontend({ executable: frontendExecutable(), pipe, ...options });
    sidecars.push(child);
    const host = mux(child);
    const ready = await host.next();
    expect({ kind: ready.kind, conn: ready.conn, bytes: ready.payload.length }).toEqual({ kind: MUX_READY, conn: 0n, bytes: 0 });
    return { child, host, pipe };
  };
  const connect = async (pipe: string, serverSid = ownSid()) => {
    const client = await connectBroker(pipe, serverSid);
    clients.push(client);
    return client;
  };
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(
      sidecars.splice(0).map((child) => {
        child.stdin.end();
        return exitOf(child);
      }),
    );
  });

  it("opens each connection with the caller's Windows account and relays its request and reply", async () => {
    const { host, pipe } = await start();
    const reply = (await connect(pipe)).request(text("ping"));
    const open = await host.next();
    expect(open.kind).toBe(MUX_OPEN);
    expect(Object.keys(JSON.parse(utf8(open.payload))).sort()).toEqual(["integrityRid", "logonLuid", "os", "pidHint", "sid", "tsSessionId"]);
    expect(decodeOpenPayload(open.payload)).toMatchObject({ os: "windows", sid: ownSid(), pidHint: process.pid });
    const frame = await host.next();
    expect({ kind: frame.kind, conn: frame.conn, body: utf8(frame.payload) }).toEqual({ kind: MUX_FRAME, conn: open.conn, body: "ping" });
    host.send(MUX_FRAME, open.conn, text("pong"));
    expect((await reply).toString("utf8")).toBe("pong");
  });

  it("serves an admitted account that does not own the pipe", async () => {
    const admitted = "S-1-5-21-1-2-3-1001";
    const owner = ownSid();
    const { host, pipe } = await start({ admit: [admitted] });
    expect(whileRestrictedTo(admitted, () => openWithGenericRights(pipe))).toBe(5);
    // connectBroker opens the pipe before its first await, so the open runs under the restricted token.
    const client = await whileRestrictedTo(admitted, () => connectBroker(pipe, owner));
    clients.push(client);
    const reply = client.request(text("{}"));
    const open = await host.next();
    await host.next();
    host.send(MUX_FRAME, open.conn, text("ok"));
    expect((await reply).toString("utf8")).toBe("ok");
  });

  it("refuses to talk to a pipe owned by another account", async () => {
    const { host, pipe } = await start();
    await expect(connectBroker(pipe, "S-1-5-18")).rejects.toThrow(/owned by S-1-5-21-[\d-]+, not S-1-5-18/);
    const reply = (await connect(pipe)).request(text("{}"));
    const open = await host.next();
    expect(decodeOpenPayload(open.payload)).toMatchObject({ pidHint: process.pid });
    expect((await host.next()).kind).toBe(MUX_FRAME);
    host.send(MUX_FRAME, open.conn, text("ok"));
    await reply;
  });

  it("closes only the connection the host closes, and confirms it", async () => {
    const { host, pipe } = await start();
    const closed = await connect(pipe);
    const healthy = await connect(pipe);
    const lost = closed.request(text("{}"));
    const open = await host.next();
    await host.next();
    host.send(MUX_CLOSE, open.conn);
    await expect(lost).rejects.toThrow(/closed/);
    const confirm = await host.next();
    expect({ kind: confirm.kind, conn: confirm.conn }).toEqual({ kind: MUX_CLOSE, conn: open.conn });
    const reply = healthy.request(text("{}"));
    const other = await host.next();
    await host.next();
    host.send(MUX_FRAME, other.conn, text("ok"));
    expect((await reply).toString("utf8")).toBe("ok");
  });

  it("tells the host when a client closes with a request pending", async () => {
    const { host, pipe } = await start();
    const client = await connect(pipe);
    const pending = client.request(text("{}"));
    const open = await host.next();
    await host.next();
    await client.close();
    await expect(pending).rejects.toThrow(/closed/);
    const close = await host.next();
    expect({ kind: close.kind, conn: close.conn }).toEqual({ kind: MUX_CLOSE, conn: open.conn });
  });

  it("closes a connection that stays silent for idleSeconds", async () => {
    const { pipe } = await start({ idleSeconds: 1 });
    const client = await connect(pipe);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await expect(client.request(text("{}"))).rejects.toThrow(/closed/);
  });

  it("removes its pipe and exits 0 when its stdin ends", async () => {
    const { child, pipe } = await start();
    child.stdin.end();
    expect(await exitOf(child)).toBe(0);
    await expect(connectBroker(pipe, ownSid())).rejects.toThrow(/CreateFileW failed with Windows error 2\b/);
  });

  it("exits with its reason when the pipe is already served", async () => {
    const { pipe } = await start();
    const second = spawnPipeFrontend({ executable: frontendExecutable(), pipe });
    let stderr = "";
    second.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    expect(await exitOf(second)).toBe(1);
    expect(stderr).toMatch(/cannot create .*orynq-broker-test/);
  });
});
