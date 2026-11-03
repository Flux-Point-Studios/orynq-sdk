import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Peer } from "@fluxpointstudios/orynq-sdk-core/broker-wire";
import { afterEach, describe, expect, it } from "vitest";
import { Broker, type BrokerOptions } from "../src/broker.js";
import { BrokerReplyError, connectBroker, type BrokerClient } from "../src/client.js";
import { encodeFrame, FrameDecoder } from "../src/framing.js";
import { type LinuxFrontend, startLinuxFrontend } from "../src/host.js";
import type { Principal } from "../src/principals.js";

// The real binary, the Node host and the client over a real socket, unprivileged: the peer is this
// test process, so its uid, gid and cgroup are the oracles.
const executable = process.env.ORYNQ_SOCKET_FRONTEND;
if (!executable) throw new Error("ORYNQ_SOCKET_FRONTEND must name a built orynq-socket-frontend binary");

const UID = process.getuid!();
const GID = process.getgid!();
const OWN_CGROUP = readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::"))!.slice(3);
const CGROUP_ROOT = "/sys/fs/cgroup";
const C = "11".repeat(32);

const [major = 0, minor = 0] = release().split(/[^0-9]+/).map(Number);
// The frontend refuses to start where the kernel cannot report a peer's cgroup id (PIDFD_GET_INFO,
// Linux 6.13); the first test proves it.
const hasCgroupIds = major > 6 || (major === 6 && minor >= 13);

// Agent tests need a peer inside a session unit's cgroup, which an unprivileged process can make
// only under a cgroup delegated to it; the delegation test proves why it cannot elsewhere.
function delegation(): NodeJS.ErrnoException | undefined {
  const probe = join(CGROUP_ROOT, OWN_CGROUP, `orynq-probe-${process.pid}`);
  try {
    mkdirSync(probe);
  } catch (error) {
    return error as NodeJS.ErrnoException;
  }
  rmdirSync(probe);
  return undefined;
}
const refusedDelegation = delegation();

class RecordingBroker extends Broker {
  readonly peers: (Peer | null)[] = [];

  override principalOf(peer: Peer | null): Principal | undefined {
    this.peers.push(peer);
    return super.principalOf(peer);
  }
}

const base: Omit<BrokerOptions, "principals"> = {
  receiptKey: Uint8Array.of(1, 2, 3),
  policy: Uint8Array.of(0xa0),
  registeredMandates: new Set([C]),
};

let dir: string | undefined;
const frontends: LinuxFrontend[] = [];
const clients: BrokerClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(frontends.splice(0).map(frontend => frontend.close()));
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function start(principals: BrokerOptions["principals"], options: { idleSeconds?: number } = {}) {
  dir ??= mkdtempSync(join(tmpdir(), "orynq-socket-"));
  const broker = new RecordingBroker({ ...base, principals });
  const errors: unknown[] = [];
  const frontend = await startLinuxFrontend({
    executable: executable!,
    socket: join(dir, "broker.sock"),
    broker,
    onError: error => errors.push(error),
    ...options,
  });
  frontends.push(frontend);
  return { broker, frontend, errors };
}

async function connect(frontend: LinuxFrontend): Promise<BrokerClient> {
  const client = await connectBroker(frontend.socket, { brokerUid: UID });
  clients.push(client);
  return client;
}

async function code(promise: Promise<unknown>): Promise<number | string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof BrokerReplyError ? error.code : (error as Error).message;
  }
  throw new Error("the request succeeded");
}

it("starts the frontend where the kernel reports a peer's cgroup id, and is refused where it does not", async () => {
  if (hasCgroupIds) {
    const { frontend } = await start({ operatorUid: UID });
    expect(existsSync(frontend.socket)).toBe(true);
    return;
  }
  await expect(start({ operatorUid: UID })).rejects.toThrow("cannot identify a peer by its cgroup");
});

describe.runIf(hasCgroupIds)("over a real socket", () => {
  it("reports this process's uid, gid, pid and cgroup as the peer, and maps it to its service", async () => {
    const { broker, frontend } = await start({ services: { e2e: { uid: UID, cgroup: OWN_CGROUP } } });
    const client = await connect(frontend);
    expect(await client.request("broker.hello")).toMatchObject({ protocol: 2, principal: "service:e2e", mandates: [] });
    expect(broker.peers).toEqual([{ os: "linux", uid: UID, gid: GID, pidHint: process.pid, cgroup: OWN_CGROUP }]);
  });

  it("answers PEER_UNKNOWN to a peer the configuration does not name", async () => {
    const { frontend } = await start({ operatorUid: UID + 1 });
    const client = await connect(frontend);
    expect(await code(client.request("broker.hello"))).toBe(-32001);
  });

  it("answers PEER_UNKNOWN to an agent-uid peer outside its session's unit cgroup", async () => {
    const { broker, frontend } = await start({ agent: { uid: UID, slice: dirname(OWN_CGROUP) } });
    await broker.handle({ id: 1, method: "session.open", params: { mandates: [C] } }, "operator");
    const client = await connect(frontend);
    expect(await code(client.request("broker.hello"))).toBe(-32001);
  });

  it("answers PEER_UNKNOWN to a client whose connecting process is gone, and the host saw null", async () => {
    const { broker, frontend } = await start({ operatorUid: UID });
    process.kill(frontend.pid, "SIGSTOP");
    let socket: Socket;
    try {
      const helper = fork(join(import.meta.dirname, "fixtures", "hand-over.mjs"), [frontend.socket], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      socket = await new Promise<Socket>((resolve, reject) => {
        helper.once("message", (_, handle) => resolve(handle as Socket));
        helper.once("exit", status => status !== 0 && reject(new Error(`the helper exited with ${status}`)));
      });
      await new Promise(resolve => (helper.exitCode === null ? helper.once("exit", resolve) : resolve(undefined)));
    } finally {
      process.kill(frontend.pid, "SIGCONT");
    }
    const decoder = new FrameDecoder();
    const reply = new Promise<Uint8Array>(resolve => socket.on("data", chunk => decoder.push(chunk).forEach(resolve)));
    socket.write(encodeFrame(new TextEncoder().encode('{"jsonrpc":"2.0","id":3,"method":"broker.hello"}')));
    expect(JSON.parse(new TextDecoder().decode(await reply))).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32001, message: "Peer unknown" } });
    socket.destroy();
    expect(broker.peers).toEqual([null]);
  });

  it("admits 32 connections of one principal and refuses the 33rd", async () => {
    const { frontend } = await start({ operatorUid: UID });
    const admitted = await Promise.all(Array.from({ length: 32 }, () => connect(frontend)));
    for (const client of admitted) expect(await client.request("broker.hello")).toMatchObject({ principal: "operator" });
    const refused = await connect(frontend);
    expect(await code(refused.request("broker.hello"))).toBe("the broker connection is closed");
    await admitted[0]!.close();
    const again = await connect(frontend);
    await expect(again.request("broker.hello")).resolves.toMatchObject({ principal: "operator" });
  });

  it("closes a connection that sends no request within the idle period", async () => {
    const { frontend } = await start({ operatorUid: UID }, { idleSeconds: 1 });
    const idle = await connect(frontend);
    const busy = await connect(frontend);
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 400));
      await busy.request("broker.hello");
    }
    expect(await code(idle.request("broker.hello"))).toBe("the broker connection is closed");
  });

  it("removes its socket and exits when the host closes its stdin", async () => {
    const { frontend } = await start({ operatorUid: UID });
    const client = await connect(frontend);
    await client.request("broker.hello");
    await frontend.close();
    frontends.splice(frontends.indexOf(frontend), 1);
    expect(existsSync(frontend.socket)).toBe(false);
    expect(() => process.kill(frontend.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(await code(client.request("broker.hello"))).toBe("the broker connection is closed");
  });

  it("refuses to start on a path another file squats", async () => {
    dir = mkdtempSync(join(tmpdir(), "orynq-socket-"));
    writeFileSync(join(dir, "broker.sock"), "squatter");
    await expect(start({ operatorUid: UID })).rejects.toThrow(`${join(dir, "broker.sock")} exists and is not this account's socket`);
    expect(readFileSync(join(dir, "broker.sock"), "utf8")).toBe("squatter");
  });

  it("lets a client refuse the broker's socket when another uid is pinned, before the broker sees it", async () => {
    const { broker, frontend } = await start({ operatorUid: UID });
    await expect(connectBroker(frontend.socket, { brokerUid: UID + 1 })).rejects.toThrow(`is not a socket owned by uid ${UID + 1}`);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(broker.peers).toEqual([]);
  });
});

it.runIf(hasCgroupIds && refusedDelegation !== undefined)("cannot place a peer in a session's cgroup here, because no cgroup is delegated to this account", () => {
  expect(["EROFS", "EACCES", "EPERM"]).toContain(refusedDelegation!.code);
});

// Moves this test process into a child cgroup for `run`, then back, removing the cgroup.
async function inCgroup<T>(name: string, run: () => Promise<T>): Promise<T> {
  const cgroup = join(CGROUP_ROOT, OWN_CGROUP, name);
  mkdirSync(cgroup);
  try {
    writeFileSync(join(cgroup, "cgroup.procs"), String(process.pid));
    try {
      return await run();
    } finally {
      writeFileSync(join(CGROUP_ROOT, OWN_CGROUP, "cgroup.procs"), String(process.pid));
    }
  } finally {
    rmdirSync(cgroup);
  }
}

describe.runIf(hasCgroupIds && refusedDelegation === undefined)("with a session unit cgroup delegated to this account", () => {
  it("names an agent in its session's unit cgroup, admits 8 of its connections and refuses the 9th", async () => {
    const { broker, frontend } = await start({ agent: { uid: UID, slice: OWN_CGROUP } });
    const opened = JSON.parse(
      new TextDecoder().decode(await broker.handle({ id: 1, method: "session.open", params: { mandates: [C] } }, "operator")),
    ) as { result: { sessionId: string; unit: string } };
    const { sessionId, unit } = opened.result;
    // Each connection is answered before the next opens and before this process leaves the
    // cgroup, so the frontend has read the cgroup by then.
    const hellos = await inCgroup(unit, async () => {
      const replies: unknown[] = [];
      for (let i = 0; i < 9; i++) {
        const client = await connect(frontend);
        replies.push(await client.request("broker.hello").catch((error: Error) => error.message));
      }
      return replies;
    });
    for (const hello of hellos.slice(0, 8)) expect(hello).toMatchObject({ principal: `agent:${sessionId}`, sessionId, mandates: [C] });
    expect(hellos[8]).toBe("the broker connection is closed");
    expect(broker.peers.at(-1)).toEqual({ os: "linux", uid: UID, gid: GID, pidHint: process.pid, cgroup: `${OWN_CGROUP}/${unit}` });
    const outside = await connect(frontend);
    expect(await code(outside.request("broker.hello"))).toBe(-32001);
  });

  it("refuses an operator's 33rd connection in the broker when the frontend counts it as another peer", async () => {
    const { frontend } = await start({ operatorUid: UID });
    const own = await Promise.all(Array.from({ length: 32 }, () => connect(frontend)));
    for (const client of own) await client.request("broker.hello");
    const refused = await inCgroup(`orynq-other-${process.pid}`, async () => code((await connect(frontend)).request("broker.hello")));
    expect(refused).toBe("the broker connection is closed");
  });
});
