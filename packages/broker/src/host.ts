import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  BrokerWireError,
  decodeOpenPayload,
  encodeMuxMessage,
  MUX_CLOSE,
  MUX_FRAME,
  MUX_OPEN,
  MUX_READY,
  MuxDecoder,
  type MuxMessage,
  type Peer,
} from "@fluxpointstudios/orynq-sdk-core/broker-wire";
import { type PipeFrontendOptions, spawnPipeFrontend } from "@fluxpointstudios/orynq-sdk-credential-broker-windows/frontend";
import type { Broker } from "./broker.js";
import { answer } from "./framing.js";
import type { Principal } from "./principals.js";

export interface MuxHost {
  /** Resolves when the frontend says READY. */
  readonly ready: Promise<void>;
  /** Resolves when the frontend's output ends between messages; rejects, and stops reading, if it breaks the protocol. */
  readonly done: Promise<void>;
}

interface Connection {
  readonly principal: Principal | undefined;
  /** The principal, or the account of a peer without one, that the connection counts against. */
  readonly bucket: string | undefined;
  busy: boolean;
  closing: boolean;
}

type Serves = Pick<Broker, "principalOf" | "connectionCap" | "handle">;

// Principals are "operator", "agent:…" and "service:…", so these never name one.
const accountOf = (peer: Peer | null): string => (peer === null ? "anonymous" : peer.os === "linux" ? `uid:${peer.uid}` : `sid:${peer.sid}`);

// B's side of a frontend's stdio mux (spec §6.1, §16). The frontend frames, bounds connections,
// keeps one request in flight and closes idle connections; B maps each peer to a principal once,
// at OPEN, caps the principal's connections, or the account's when the peer has no principal (a
// frontend counts peers by cgroup, which any account can multiply), and answers each FRAME through
// the same decoder serveConnection uses. A connection B closes stays counted until the frontend's
// own CLOSE confirms it, and frames that crossed B's CLOSE are dropped.
export function serveMux(input: Readable, output: Writable, broker: Serves, report: (error: unknown) => void): MuxHost {
  const decoder = new MuxDecoder();
  const connections = new Map<bigint, Connection>();
  const counts = new Map<string, number>();
  let isReady = false;
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });

  const send = (kind: typeof MUX_FRAME | typeof MUX_CLOSE, conn: bigint, payload: Uint8Array = new Uint8Array()) =>
    output.write(encodeMuxMessage({ kind, conn, payload }));
  const close = (conn: bigint, connection: Connection) => {
    connection.closing = true;
    send(MUX_CLOSE, conn);
  };

  const open = (conn: bigint, payload: Uint8Array) => {
    let peer: Peer | null;
    try {
      peer = decodeOpenPayload(payload);
    } catch (error) {
      if (!(error instanceof BrokerWireError)) throw error;
      report(error);
      peer = null;
    }
    const principal = broker.principalOf(peer);
    const bucket = principal ?? accountOf(peer);
    const count = counts.get(bucket) ?? 0;
    if (count >= broker.connectionCap(principal)) {
      const refused: Connection = { principal: undefined, bucket: undefined, busy: false, closing: false };
      connections.set(conn, refused);
      close(conn, refused);
      return;
    }
    connections.set(conn, { principal, bucket, busy: false, closing: false });
    counts.set(bucket, count + 1);
  };

  const respond = async (conn: bigint, connection: Connection, payload: Uint8Array) => {
    connection.busy = true;
    try {
      const reply = await answer(payload, request => broker.handle(request, connection.principal));
      if (!connection.closing) send(MUX_FRAME, conn, reply);
    } catch (error) {
      report(error);
      if (!connection.closing) close(conn, connection);
    } finally {
      connection.busy = false;
    }
  };

  const release = (conn: bigint, connection: Connection) => {
    connection.closing = true;
    connections.delete(conn);
    if (connection.bucket === undefined) return;
    const count = counts.get(connection.bucket)! - 1;
    if (count === 0) counts.delete(connection.bucket);
    else counts.set(connection.bucket, count);
  };

  const receive = ({ kind, conn, payload }: MuxMessage) => {
    if (!isReady) {
      if (kind !== MUX_READY) throw new Error("the frontend spoke before READY");
      isReady = true;
      markReady();
      return;
    }
    if (kind === MUX_READY) throw new Error("the frontend sent READY twice");
    const connection = connections.get(conn);
    if (kind === MUX_OPEN) {
      if (connection) throw new Error(`the frontend opened connection ${conn} twice`);
      open(conn, payload);
      return;
    }
    const name = kind === MUX_FRAME ? "FRAME" : "CLOSE";
    if (!connection) throw new Error(`the frontend sent a ${name} for connection ${conn}, which is not open`);
    if (kind === MUX_CLOSE) {
      release(conn, connection);
    } else if (!connection.closing) {
      if (connection.busy) throw new Error(`the frontend sent a second request on connection ${conn} before its reply`);
      void respond(conn, connection, payload);
    }
  };

  const done = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) receive(message);
      } catch (error) {
        input.off("data", onData);
        reject(error);
      }
    };
    input.on("data", onData);
    input.once("end", () => (decoder.buffered === 0 ? resolve() : reject(new Error("the frontend's output ended inside a message"))));
  });
  return { ready, done };
}

// The frontend refuses a longer --idle-secs; this refuses it before spawning one.
const MAX_IDLE_SECONDS = 86_400;

interface HostOptions {
  readonly broker: Broker;
  readonly onError?: (error: unknown) => void;
}

interface Frontend {
  /** The frontend's process id, for a supervisor's logs and signals. */
  readonly pid: number;
  /** Ends the frontend's stdin; it removes its socket or pipe and exits. */
  close(): Promise<void>;
}

export interface LinuxFrontendOptions extends HostOptions {
  /** Path to the orynq-socket-frontend binary. */
  readonly executable: string;
  /** Absolute path of the socket the frontend creates. */
  readonly socket: string;
  /** The socket's mode, 0o600 (owner only) unless given; read and write bits only. */
  readonly mode?: number;
  /** Seconds without a request before a connection closes, 1 to 86,400; the frontend defaults to 300. */
  readonly idleSeconds?: number;
}

export interface LinuxFrontend extends Frontend {
  readonly socket: string;
}

export interface WindowsFrontendOptions extends PipeFrontendOptions, HostOptions {}

export interface WindowsFrontend extends Frontend {
  readonly pipe: string;
}

// Serves the broker over a spawned frontend's mux. Rejects with the frontend's own message if it
// exits before READY. A frontend that breaks the protocol is reported and killed.
function serveFrontend(child: ChildProcessByStdio<Writable, Readable, Readable>, name: string, options: HostOptions): Promise<Frontend> {
  const report = options.onError ?? ((error: unknown) => process.emitWarning(error instanceof Error ? error : String(error)));
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let stderr = "";
  let started = false;
  let closing = false;
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.on("error", report);
  const host = serveMux(child.stdout, child.stdin, options.broker, report);
  host.done.catch((error: unknown) => {
    report(error);
    child.kill();
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => {
      const reason = new Error(stderr.trim() || `${name} exited with code ${code}`);
      if (!started) reject(reason);
      else if (!closing) report(reason);
    });
    void host.ready.then(() => {
      started = true;
      resolve({
        pid: child.pid!,
        async close() {
          closing = true;
          child.stdin.end();
          await exited;
        },
      });
    });
  });
}

// Spawns the Linux frontend and serves the broker over its mux. It exits before READY for a
// squatted path or a kernel that cannot report a peer's cgroup id.
export async function startLinuxFrontend(options: LinuxFrontendOptions): Promise<LinuxFrontend> {
  const { idleSeconds } = options;
  if (idleSeconds !== undefined && !(Number.isInteger(idleSeconds) && idleSeconds >= 1 && idleSeconds <= MAX_IDLE_SECONDS)) {
    throw new RangeError(`idleSeconds must be a whole number of seconds from 1 to ${MAX_IDLE_SECONDS}`);
  }
  const args = ["--socket", options.socket];
  if (options.mode !== undefined) args.push("--mode", options.mode.toString(8));
  if (idleSeconds !== undefined) args.push("--idle-secs", String(idleSeconds));
  const frontend = await serveFrontend(spawn(options.executable, args, { stdio: ["pipe", "pipe", "pipe"] }), "orynq-socket-frontend", options);
  return { ...frontend, socket: options.socket };
}

// Spawns the Windows sidecar and serves the broker over its mux. Options the sidecar would refuse
// reject before it spawns; it exits before READY when another process serves the pipe.
export async function startWindowsFrontend(options: WindowsFrontendOptions): Promise<WindowsFrontend> {
  const frontend = await serveFrontend(spawnPipeFrontend(options), "orynq-pipe-frontend", options);
  return { ...frontend, pipe: options.pipe };
}
