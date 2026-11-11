import {
  encodeMuxMessage,
  MUX_CLOSE,
  MUX_FRAME,
  MUX_OPEN,
  MUX_READY,
  MuxDecoder,
  type LinuxPeer,
  type MuxKind,
  type MuxMessage,
  type Peer,
  type WindowsPeer,
} from "@fluxpointstudios/orynq-sdk-core/broker-wire";
import { type BrokerConnection, connectBroker } from "@fluxpointstudios/orynq-sdk-credential-broker-windows";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { frontendExecutable, ownSid, pipeName } from "../../credential-broker-windows/tests/sidecar.js";
import { Broker, type BrokerOptions } from "../src/broker.js";
import { serveMux, startLinuxFrontend, startWindowsFrontend, type WindowsFrontend } from "../src/host.js";

const OPERATOR = 1000;
const AGENT = 1500;
const SLICE = "/orynq.slice/orynq-agents.slice";
const C = "11".repeat(32);
const utf8 = (text: string) => new TextEncoder().encode(text);
const linux = (uid: number, cgroup = "/user.slice"): LinuxPeer => ({ os: "linux", uid, gid: uid, pidHint: 1, cgroup });
const onLinux = process.platform === "linux";
const onWindows = process.platform === "win32";

function broker(principals: BrokerOptions["principals"] = { operatorUid: OPERATOR, agent: { uid: AGENT, slice: SLICE } }): Broker {
  return new Broker({
    principals,
    receiptKey: Uint8Array.of(1, 2, 3),
    policy: Uint8Array.of(0xa0),
    registeredMandates: new Set([C]),
  });
}

// Plays the frontend: writes what it would write and collects what the host answers.
function frontend(b = broker()) {
  const input = new PassThrough();
  const output = new PassThrough();
  const decoder = new MuxDecoder();
  const sent: MuxMessage[] = [];
  output.on("data", (chunk: Buffer) => sent.push(...decoder.push(chunk)));
  const reports: unknown[] = [];
  const host = serveMux(input, output, b, error => reports.push(error));
  const settled = host.done.then(() => "ended", (error: Error) => `rejected: ${error.message}`);
  const write = (kind: MuxKind, conn: bigint, payload: Uint8Array = new Uint8Array()) =>
    input.write(encodeMuxMessage({ kind, conn, payload }));
  const open = (conn: bigint, peer: Peer | null) => write(MUX_OPEN, conn, utf8(JSON.stringify(peer)));
  const call = (conn: bigint, method: string, id = Number(conn), params?: unknown) =>
    write(MUX_FRAME, conn, utf8(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })));
  const replies = (conn: bigint) =>
    sent.filter(m => m.conn === conn && m.kind === MUX_FRAME).map(m => JSON.parse(new TextDecoder().decode(m.payload)) as Record<string, unknown>);
  const closes = () => sent.filter(m => m.kind === MUX_CLOSE).map(m => m.conn);
  return { b, host, input, settled, sent, reports, write, open, call, replies, closes };
}

const ready = async (f: ReturnType<typeof frontend>) => {
  f.write(MUX_READY, 0n);
  await f.host.ready;
};

describe("serveMux", () => {
  it("is ready once the frontend says READY, and ends when its output ends", async () => {
    const f = frontend();
    let isReady = false;
    void f.host.ready.then(() => { isReady = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(isReady).toBe(false);
    await ready(f);
    f.input.end();
    expect(await f.settled).toBe("ended");
  });

  it("answers each request as the principal the connection's peer maps to", async () => {
    const f = frontend();
    await ready(f);
    f.open(1n, linux(OPERATOR));
    f.call(1n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(1n)).toHaveLength(1));
    expect(f.replies(1n)[0]).toMatchObject({ jsonrpc: "2.0", id: 1, result: { principal: "operator", protocol: 2 } });
    f.call(1n, "session.open", 7, { mandates: [C] });
    await vi.waitFor(() => expect(f.replies(1n)).toHaveLength(2));
    expect(f.replies(1n)[1]).toMatchObject({ id: 7, result: { unit: expect.stringMatching(/^orynq-agent-[0-9a-f]{32}\.service$/) } });
  });

  it("answers PEER_UNKNOWN to an anonymous client, an unconfigured peer and a peer outside the contract", async () => {
    const f = frontend();
    await ready(f);
    f.open(1n, null);
    f.open(2n, linux(4242));
    f.write(MUX_OPEN, 3n, utf8(JSON.stringify({ ...linux(OPERATOR), extra: 1 })));
    for (const conn of [1n, 2n, 3n]) f.call(conn, "broker.hello");
    await vi.waitFor(() => expect([1n, 2n, 3n].map(conn => f.replies(conn).length)).toEqual([1, 1, 1]));
    for (const conn of [1n, 2n, 3n]) {
      expect(f.replies(conn)[0]).toEqual({ jsonrpc: "2.0", id: Number(conn), error: { code: -32001, message: "Peer unknown" } });
    }
    expect(f.reports).toHaveLength(1);
    expect(f.reports[0]).toMatchObject({ name: "BrokerWireError", code: "PEER_INVALID" });
  });

  // The Windows sidecar's DACL admits SYSTEM, whose token names no account a principal can.
  it("answers PEER_UNKNOWN to SYSTEM without reporting it, and counts it apart from anonymous clients", async () => {
    const f = frontend();
    await ready(f);
    const system: WindowsPeer = { os: "windows", sid: "S-1-5-18", logonLuid: "999", tsSessionId: 0, integrityRid: 0x4000, pidHint: null };
    for (let conn = 1n; conn <= 33n; conn++) f.open(conn, system);
    f.open(34n, null);
    for (const conn of [1n, 34n]) f.call(conn, "broker.hello");
    await vi.waitFor(() => expect([1n, 34n].map(conn => f.replies(conn).length)).toEqual([1, 1]));
    for (const conn of [1n, 34n]) expect(f.replies(conn)[0]).toMatchObject({ error: { code: -32001 } });
    expect(f.reports).toEqual([]);
    expect(f.closes()).toEqual([33n]);
  });

  it("answers a request it cannot decode from the error table with id null", async () => {
    const f = frontend();
    await ready(f);
    f.open(1n, linux(OPERATOR));
    f.write(MUX_FRAME, 1n, utf8('{"jsonrpc":"2.0","id":1,"id":2,"method":"broker.hello"}'));
    await vi.waitFor(() => expect(f.replies(1n)).toHaveLength(1));
    expect(f.replies(1n)[0]).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  });

  it("refuses the 33rd connection of a principal and admits one again when another closes", async () => {
    const f = frontend();
    await ready(f);
    for (let conn = 1n; conn <= 33n; conn++) f.open(conn, linux(OPERATOR, `/cg/${conn}`));
    await vi.waitFor(() => expect(f.closes()).toEqual([33n]));
    f.call(33n, "broker.hello");
    f.call(32n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(32n)).toHaveLength(1));
    expect(f.replies(33n)).toEqual([]);
    f.write(MUX_CLOSE, 33n);
    f.write(MUX_CLOSE, 1n);
    f.open(34n, linux(OPERATOR));
    f.open(35n, linux(OPERATOR));
    await vi.waitFor(() => expect(f.closes()).toEqual([33n, 35n]));
    f.call(34n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(34n)).toHaveLength(1));
  });

  it("refuses the 33rd connection of an account without a principal, whatever its cgroups, and the 33rd anonymous one", async () => {
    const f = frontend();
    await ready(f);
    const unknownSid = (conn: bigint): WindowsPeer => ({ os: "windows", sid: "S-1-5-21-9-9-9-1001", logonLuid: String(conn), tsSessionId: 1, integrityRid: 0x2000, pidHint: null });
    for (let conn = 1n; conn <= 33n; conn++) f.open(conn, { ...linux(4242, `/cg/${conn}`), gid: Number(conn) });
    for (let conn = 101n; conn <= 132n; conn++) f.open(conn, null);
    f.write(MUX_OPEN, 133n, utf8("{}"));
    for (let conn = 201n; conn <= 233n; conn++) f.open(conn, unknownSid(conn));
    for (let conn = 301n; conn <= 333n; conn++) f.open(conn, linux(AGENT, `${SLICE}/orynq-agent-${"0".repeat(32)}.service`));
    f.open(400n, linux(4243));
    f.call(400n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(400n)).toHaveLength(1));
    expect(f.replies(400n)[0]).toMatchObject({ error: { code: -32001 } });
    expect(f.closes()).toEqual([33n, 133n, 233n, 333n]);
    f.write(MUX_CLOSE, 33n);
    f.write(MUX_CLOSE, 1n);
    f.open(34n, linux(4242));
    f.open(35n, linux(4242));
    await vi.waitFor(() => expect(f.closes()).toEqual([33n, 133n, 233n, 333n, 35n]));
  });

  it("refuses the 9th connection of an agent session, each session counted on its own", async () => {
    const f = frontend();
    await ready(f);
    const sessions: string[] = [];
    for (const id of [1, 2]) {
      const reply = await f.b.handle({ id, method: "session.open", params: { mandates: [C] } }, "operator");
      sessions.push((JSON.parse(new TextDecoder().decode(reply)) as { result: { sessionId: string } }).result.sessionId);
    }
    const agent = (sessionId: string) => linux(AGENT, `${SLICE}/orynq-agent-${sessionId}.service`);
    for (let conn = 1n; conn <= 9n; conn++) f.open(conn, agent(sessions[0]!));
    for (let conn = 11n; conn <= 18n; conn++) f.open(conn, agent(sessions[1]!));
    await vi.waitFor(() => expect(f.closes()).toEqual([9n]));
    f.call(18n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(18n)).toHaveLength(1));
    expect(f.replies(18n)[0]).toMatchObject({ result: { principal: `agent:${sessions[1]}`, sessionId: sessions[1] } });
  });

  it("answers PEER_UNKNOWN on an agent's connection once its session has closed", async () => {
    const f = frontend();
    await ready(f);
    const opened = JSON.parse(new TextDecoder().decode(await f.b.handle({ id: 1, method: "session.open", params: { mandates: [C] } }, "operator"))) as {
      result: { sessionId: string; unit: string };
    };
    f.open(1n, linux(AGENT, `${SLICE}/${opened.result.unit}`));
    f.call(1n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(1n)).toHaveLength(1));
    await f.b.handle({ id: 2, method: "session.close", params: { sessionId: opened.result.sessionId } }, "operator");
    f.call(1n, "broker.hello", 2);
    await vi.waitFor(() => expect(f.replies(1n)).toHaveLength(2));
    expect(f.replies(1n)[1]).toMatchObject({ id: 2, error: { code: -32001 } });
  });

  it("closes a connection whose handler fails with anything but an RpcError, and reports it", async () => {
    const f = frontend();
    await ready(f);
    const failure = new Error("vault unreachable");
    vi.spyOn(f.b, "handle").mockRejectedValueOnce(failure);
    f.open(1n, linux(OPERATOR));
    f.call(1n, "broker.hello");
    await vi.waitFor(() => expect(f.closes()).toEqual([1n]));
    expect(f.reports).toEqual([failure]);
    expect(f.replies(1n)).toEqual([]);
    f.write(MUX_CLOSE, 1n);
    f.open(2n, linux(OPERATOR));
    f.call(2n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(2n)).toHaveLength(1));
  });

  it("runs no request that crosses its CLOSE, on a connection it refused or one whose handler failed", async () => {
    const f = frontend();
    await ready(f);
    for (let conn = 1n; conn <= 33n; conn++) f.open(conn, linux(OPERATOR, `/cg/${conn}`));
    const handle = vi.spyOn(f.b, "handle").mockRejectedValueOnce(new Error("vault unreachable"));
    f.call(1n, "broker.hello");
    await vi.waitFor(() => expect(f.closes()).toEqual([33n, 1n]));
    for (const conn of [1n, 33n]) f.call(conn, "session.open", 9, { mandates: [C] });
    f.call(2n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(2n)).toHaveLength(1));
    expect(handle).toHaveBeenCalledTimes(2);
    expect(f.replies(2n)[0]).toMatchObject({ result: { journalHead: { seq: "0" } } });
    expect(f.sent.filter(m => m.kind === MUX_FRAME && m.conn !== 2n)).toEqual([]);
  });

  it("sends no reply for a connection the frontend closed while its request ran", async () => {
    const f = frontend();
    await ready(f);
    let release!: (reply: Uint8Array) => void;
    vi.spyOn(f.b, "handle").mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    f.open(1n, linux(OPERATOR));
    f.call(1n, "broker.hello");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.write(MUX_CLOSE, 1n);
    await new Promise(resolve => setImmediate(resolve));
    release(utf8('{"jsonrpc":"2.0","id":1,"result":{}}'));
    f.open(2n, linux(OPERATOR));
    f.call(2n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(2n)).toHaveLength(1));
    expect(f.sent.filter(m => m.conn === 1n)).toEqual([]);
  });

  it.each([
    ["anything before READY", (f: ReturnType<typeof frontend>) => f.open(1n, null), false, "the frontend spoke before READY"],
    ["a second READY", (f: ReturnType<typeof frontend>) => f.write(MUX_READY, 0n), true, "the frontend sent READY twice"],
    ["an OPEN for an open connection", (f: ReturnType<typeof frontend>) => { f.open(1n, null); f.open(1n, null); }, true, "the frontend opened connection 1 twice"],
    ["a FRAME for a connection never opened", (f: ReturnType<typeof frontend>) => f.call(5n, "broker.hello"), true, "the frontend sent a FRAME for connection 5, which is not open"],
    ["a CLOSE for a connection never opened", (f: ReturnType<typeof frontend>) => f.write(MUX_CLOSE, 5n), true, "the frontend sent a CLOSE for connection 5, which is not open"],
    ["a malformed message", (f: ReturnType<typeof frontend>) => f.input.write(Uint8Array.of(0, 0, 0, 9, 7)), true, "mux message kind is unknown"],
    ["output that ends inside a message", (f: ReturnType<typeof frontend>) => f.input.end(Uint8Array.of(0, 0, 0, 9, 2)), true, "the frontend's output ended inside a message"],
  ])("rejects on %s, since the frontend is broken", async (_, act, afterReady, message) => {
    const f = frontend();
    if (afterReady) await ready(f);
    act(f);
    expect(await f.settled).toBe(`rejected: ${message}`);
  });

  it("rejects on a second request in flight on one connection", async () => {
    const f = frontend();
    await ready(f);
    vi.spyOn(f.b, "handle").mockReturnValueOnce(new Promise(() => {}));
    f.open(1n, linux(OPERATOR));
    f.call(1n, "broker.hello");
    f.call(1n, "broker.hello");
    expect(await f.settled).toBe("rejected: the frontend sent a second request on connection 1 before its reply");
  });
});

describe("startLinuxFrontend", () => {
  it("refuses an idle period outside 1 second to a day before spawning anything", async () => {
    for (const idleSeconds of [0, 86_401, 1.5, -1, Number.NaN, 2 ** 64]) {
      const started = startLinuxFrontend({ executable: "/nonexistent/orynq-socket-frontend", socket: "/unused/broker.sock", broker: broker(), idleSeconds });
      await expect(started).rejects.toThrow(RangeError);
      await expect(started).rejects.toThrow("idleSeconds must be a whole number of seconds from 1 to 86400");
    }
  });
});

describe("startWindowsFrontend", () => {
  it.each([
    ["a pipe outside \\\\.\\pipe\\", { pipe: "orynq-broker" }],
    ["an admitted SID that is not a user or service account", { admit: ["S-1-5-18"] }],
    ["an idle period outside 1 second to a day", { idleSeconds: 86_401 }],
  ])("refuses %s before spawning anything", async (_, refused) => {
    const started = startWindowsFrontend({ executable: "/nonexistent/orynq-pipe-frontend.exe", pipe: "\\\\.\\pipe\\orynq-broker", broker: broker(), ...refused });
    await expect(started).rejects.toThrow(RangeError);
  });
});

// These spawn a POSIX executable and a script in the frontend's place, which Windows cannot.
describe.runIf(onLinux).each([
  [
    "startLinuxFrontend",
    "orynq-socket-frontend",
    (executable: string, onError: (error: unknown) => void) => startLinuxFrontend({ executable, socket: "/unused/broker.sock", broker: broker(), onError }),
  ],
  [
    "startWindowsFrontend",
    "orynq-pipe-frontend",
    (executable: string, onError: (error: unknown) => void) => startWindowsFrontend({ executable, pipe: "\\\\.\\pipe\\unused", broker: broker(), onError }),
  ],
])("%s with a stand-in frontend", (_, name, start) => {
  it("rejects with the frontend's name and exit code when it exits before READY without a reason", async () => {
    await expect(start("/bin/false", () => undefined)).rejects.toThrow(`${name} exited with code 1`);
  });

  it("kills a frontend that breaks the protocol after READY, and reports why", async () => {
    const errors: unknown[] = [];
    const frontend = await start(join(import.meta.dirname, "fixtures", "broken-frontend.mjs"), error => errors.push(error));
    await vi.waitFor(() => expect(() => process.kill(frontend.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" })), { timeout: 5_000 });
    expect(errors[0]).toMatchObject({ name: "BrokerWireError", code: "MUX_KIND" });
  });
});

describe.runIf(onWindows)("startWindowsFrontend with the real sidecar", { timeout: 30_000 }, () => {
  const frontends: WindowsFrontend[] = [];
  const clients: BrokerConnection[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()));
    await Promise.all(frontends.splice(0).map(frontend => frontend.close()));
  });

  const start = async (errors: unknown[] = []) => {
    const b = broker({ operatorSid: ownSid() });
    const frontend = await startWindowsFrontend({ executable: frontendExecutable(), pipe: pipeName(), broker: b, onError: error => errors.push(error) });
    frontends.push(frontend);
    return { b, frontend };
  };
  const connect = async (frontend: WindowsFrontend) => {
    const client = await connectBroker(frontend.pipe, ownSid());
    clients.push(client);
    return client;
  };
  const request = (id: number, params?: unknown) => utf8(JSON.stringify({ jsonrpc: "2.0", id, method: "broker.hello", ...(params === undefined ? {} : { params }) }));
  const reply = async (pending: Promise<Buffer>) => JSON.parse((await pending).toString("utf8")) as Record<string, unknown>;

  it("relays each request on a connection to the broker and its reply back to the client", async () => {
    const { b, frontend } = await start();
    vi.spyOn(b, "handle").mockImplementation(async ({ id, params }) => utf8(JSON.stringify({ jsonrpc: "2.0", id, result: params })));
    const client = await connect(frontend);
    expect(await reply(client.request(request(1, { echo: "ping" })))).toEqual({ jsonrpc: "2.0", id: 1, result: { echo: "ping" } });
    expect(await reply(client.request(request(2, { echo: "again" })))).toEqual({ jsonrpc: "2.0", id: 2, result: { echo: "again" } });
  });

  it("maps the caller's Windows account, a peer with exactly the contract's keys, to its principal", async () => {
    const { b, frontend } = await start();
    const principalOf = vi.spyOn(b, "principalOf");
    const client = await connect(frontend);
    expect(await reply(client.request(request(1)))).toMatchObject({ id: 1, result: { principal: "operator" } });
    expect(principalOf).toHaveBeenCalledTimes(1);
    const [peer] = principalOf.mock.calls[0]!;
    expect(peer).toMatchObject({ os: "windows", sid: ownSid(), pidHint: process.pid });
    expect(Object.keys(peer ?? {}).sort()).toEqual(["integrityRid", "logonLuid", "os", "pidHint", "sid", "tsSessionId"]);
  });

  it("closes only the connection whose request failed in the broker, and reports the failure", async () => {
    const errors: unknown[] = [];
    const { b, frontend } = await start(errors);
    const failure = new Error("handler bug");
    vi.spyOn(b, "handle").mockRejectedValueOnce(failure);
    const failing = await connect(frontend);
    const healthy = await connect(frontend);
    await expect(failing.request(request(1))).rejects.toThrow(/closed/);
    expect(await reply(healthy.request(request(2)))).toMatchObject({ id: 2, result: { principal: "operator" } });
    expect(errors).toEqual([failure]);
  });

  it("cancels a request the broker is still running when the client closes", async () => {
    const { b, frontend } = await start();
    const handle = vi.spyOn(b, "handle").mockReturnValueOnce(new Promise(() => undefined));
    const client = await connect(frontend);
    const pending = client.request(request(1));
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
    await client.close();
    await expect(pending).rejects.toThrow(/closed/);
  });
});
