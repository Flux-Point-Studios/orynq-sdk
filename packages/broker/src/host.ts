import { spawn } from "node:child_process";
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
import type { Broker } from "./broker.js";
import { answer } from "./framing.js";
import type { Principal } from "./principals.js";

export interface MuxHost {
  /** Resolves when the frontend says READY. */
  readonly ready: Promise<void>;
  /** Resolves when the frontend's output ends; rejects, and stops reading, if it breaks the protocol. */
  readonly done: Promise<void>;
}

interface Connection {
  readonly principal: Principal | undefined;
  busy: boolean;
  closing: boolean;
}

type Serves = Pick<Broker, "principalOf" | "connectionCap" | "handle">;

// B's side of a frontend's stdio mux (spec §6.1, §16). The frontend frames, admits at most 32
// connections per peer, keeps one request in flight and closes idle connections; B maps each peer
// to a principal once, at OPEN, caps the principal's connections, and answers each FRAME through
// the same decoder serveConnection uses. A connection B closes stays counted until the frontend's
// own CLOSE confirms it, and frames that crossed B's CLOSE are dropped.
export function serveMux(input: Readable, output: Writable, broker: Serves, report: (error: unknown) => void): MuxHost {
  const decoder = new MuxDecoder();
  const connections = new Map<bigint, Connection>();
  const counts = new Map<Principal, number>();
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
    const count = principal === undefined ? 0 : (counts.get(principal) ?? 0);
    const refused = principal !== undefined && count >= broker.connectionCap(principal);
    const connection: Connection = { principal: refused ? undefined : principal, busy: false, closing: false };
    connections.set(conn, connection);
    if (refused) close(conn, connection);
    else if (principal !== undefined) counts.set(principal, count + 1);
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
    if (connection.principal === undefined) return;
    const count = counts.get(connection.principal)! - 1;
    if (count === 0) counts.delete(connection.principal);
    else counts.set(connection.principal, count);
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
    input.once("end", () => resolve());
  });
  return { ready, done };
}

export interface LinuxFrontendOptions {
  /** Path to the orynq-socket-frontend binary. */
  readonly executable: string;
  /** Absolute path of the socket the frontend creates. */
  readonly socket: string;
  readonly broker: Broker;
  /** The socket's mode, 0o600 (owner only) unless given; read and write bits only. */
  readonly mode?: number;
  /** Seconds without a request before a connection closes; the frontend defaults to 300. */
  readonly idleSeconds?: number;
  readonly onError?: (error: unknown) => void;
}

export interface LinuxFrontend {
  readonly socket: string;
  /** The frontend's process id, for a supervisor's logs and signals. */
  readonly pid: number;
  /** Ends the frontend's stdin; it removes its socket and exits. */
  close(): Promise<void>;
}

// Spawns the Linux frontend and serves the broker over its mux. Rejects with the frontend's own
// message if it exits before READY, as it does for a squatted path or a kernel without
// SO_PEERPIDFD. A frontend that breaks the protocol is reported and killed.
export function startLinuxFrontend(options: LinuxFrontendOptions): Promise<LinuxFrontend> {
  const report = options.onError ?? ((error: unknown) => process.emitWarning(error instanceof Error ? error : String(error)));
  const args = ["--socket", options.socket];
  if (options.mode !== undefined) args.push("--mode", options.mode.toString(8));
  if (options.idleSeconds !== undefined) args.push("--idle-secs", String(options.idleSeconds));
  const child = spawn(options.executable, args, { stdio: ["pipe", "pipe", "pipe"] });
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
      const reason = new Error(stderr.trim() || `orynq-socket-frontend exited with code ${code}`);
      if (!started) reject(reason);
      else if (!closing) report(reason);
    });
    void host.ready.then(() => {
      started = true;
      resolve({
        socket: options.socket,
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
