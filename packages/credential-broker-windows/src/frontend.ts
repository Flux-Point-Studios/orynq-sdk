import { spawn } from "node:child_process";

const READY = 0;
const OPEN = 1;
const FRAME = 2;
const CLOSE = 3;

/** The OS identity of a pipe client; the broker maps it to a principal. */
export interface Peer {
  os: "windows";
  sid: string;
  /** Logon session LUID as a decimal string. */
  logonLuid: string;
  /** Terminal Services session id. */
  tsSessionId: number;
  /** Mandatory integrity level RID, e.g. 0x2000 for medium. */
  integrityRid: number;
  /** Client process id. Never an authorization input: a pid can be reused. */
  pidHint: number | null;
}

export interface FrontendOptions {
  /** Path to orynq-pipe-frontend.exe. */
  executable: string;
  /** Full pipe path, e.g. `\\.\pipe\orynq-broker`. */
  pipe: string;
  /** User (S-1-5-21-…) or service (S-1-5-80-…) SIDs that may connect besides this account and SYSTEM. */
  admit?: string[];
  /** Answers one frame; the frontend sends the next frame on a connection only after this resolves. */
  handle: (frame: Buffer, peer: Peer | null) => Promise<Uint8Array>;
  onError?: (error: unknown) => void;
}

export interface Frontend {
  pipe: string;
  close(): Promise<void>;
}

const message = (kind: number, conn: bigint, payload: Uint8Array = new Uint8Array()): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(9 + payload.length, 0);
  header.writeUInt8(kind, 4);
  header.writeBigUInt64BE(conn, 5);
  return Buffer.concat([header, payload]);
};

// Collects stdout chunks and concatenates only when a whole message is present, so a 16 MiB frame
// arriving in 64 KiB chunks is copied once rather than once per chunk.
class MessageReader {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  next(): { kind: number; conn: bigint; payload: Buffer } | undefined {
    if (this.size < 4) return undefined;
    const length = this.contiguous(4).readUInt32BE(0);
    if (this.size < 4 + length) return undefined;
    const all = this.contiguous(this.size);
    const rest = all.subarray(4 + length);
    this.chunks = [rest];
    this.size = rest.length;
    return { kind: all.readUInt8(4), conn: all.readBigUInt64BE(5), payload: all.subarray(13, 4 + length) };
  }

  private contiguous(count: number): Buffer {
    const [first] = this.chunks;
    if (first && first.length >= count) return first;
    const joined = Buffer.concat(this.chunks);
    this.chunks = [joined];
    return joined;
  }
}

export function startFrontend(options: FrontendOptions): Promise<Frontend> {
  const report = options.onError ?? ((error: unknown) => process.emitWarning(error instanceof Error ? error : String(error)));
  const child = spawn(options.executable, ["--pipe", options.pipe, ...(options.admit ?? []).flatMap((sid) => ["--admit", sid])], {
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const peers = new Map<bigint, Peer | null>();
  const reader = new MessageReader();
  let stderr = "";
  let ready = false;
  let closing = false;

  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.on("error", report);

  const answer = (conn: bigint, frame: Buffer) =>
    options.handle(frame, peers.get(conn) ?? null).then(
      (response) => child.stdin.write(message(FRAME, conn, response)),
      (error: unknown) => {
        report(error);
        child.stdin.write(message(CLOSE, conn));
      },
    );

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      const reason = new Error(stderr.trim() || `orynq-pipe-frontend exited with code ${code}`);
      if (!ready) reject(reason);
      else if (!closing) report(reason);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      reader.push(chunk);
      for (let next = reader.next(); next; next = reader.next()) {
        const { kind, conn, payload } = next;
        if (kind === READY) {
          ready = true;
          resolve({
            pipe: options.pipe,
            async close() {
              closing = true;
              child.stdin.end();
              await exited;
            },
          });
        } else if (kind === OPEN) {
          peers.set(conn, JSON.parse(payload.toString("utf8")) as Peer | null);
        } else if (kind === FRAME) {
          void answer(conn, Buffer.from(payload));
        } else if (kind === CLOSE) {
          peers.delete(conn);
        } else {
          report(new Error(`orynq-pipe-frontend sent message kind ${kind}`));
        }
      }
    });
  });
}
