import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { isAccountSid } from "@fluxpointstudios/orynq-sdk-core/broker-wire";

const PIPE_PREFIX = "\\\\.\\pipe\\";
// The sidecar refuses a longer --idle-secs; this refuses it before spawning one.
const MAX_IDLE_SECONDS = 86_400;

export interface PipeFrontendOptions {
  /** Path to orynq-pipe-frontend.exe. */
  readonly executable: string;
  /** Full pipe path, e.g. `\\.\pipe\orynq-broker`. */
  readonly pipe: string;
  /** User (S-1-5-21-…) or service (S-1-5-80-…) SIDs that may connect besides this account and SYSTEM. */
  readonly admit?: readonly string[];
  /** Seconds without a request before a connection closes, 1 to 86,400; the sidecar defaults to 300. */
  readonly idleSeconds?: number;
}

// Spawns the named-pipe sidecar. Its stdin and stdout carry the broker-wire mux, which the caller
// serves from READY on; stderr carries its reason for exiting.
export function spawnPipeFrontend(options: PipeFrontendOptions): ChildProcessByStdio<Writable, Readable, Readable> {
  const { pipe, admit = [], idleSeconds } = options;
  if (!pipe.startsWith(PIPE_PREFIX)) throw new RangeError("pipe must be a local \\\\.\\pipe\\ path");
  const refused = admit.find((sid) => !isAccountSid(sid));
  if (refused !== undefined) throw new RangeError(`cannot admit ${refused}: only user (S-1-5-21-…) and service (S-1-5-80-…) SIDs`);
  if (idleSeconds !== undefined && !(Number.isInteger(idleSeconds) && idleSeconds >= 1 && idleSeconds <= MAX_IDLE_SECONDS)) {
    throw new RangeError(`idleSeconds must be a whole number of seconds from 1 to ${MAX_IDLE_SECONDS}`);
  }
  const args = ["--pipe", pipe, ...admit.flatMap((sid) => ["--admit", sid])];
  if (idleSeconds !== undefined) args.push("--idle-secs", String(idleSeconds));
  return spawn(options.executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}
