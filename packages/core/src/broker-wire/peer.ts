import { parseStrictJson, StrictJsonError } from "../utils/strict-json.js";
import { BrokerWireError } from "./errors.js";

// The OS identity a broker frontend reports for one client connection (credential-broker spec
// §5.2, §16). The broker maps it to a principal; pidHint never authorizes, since a pid is reused.
export interface LinuxPeer {
  readonly os: "linux";
  readonly uid: number;
  readonly gid: number;
  readonly pidHint: number | null;
  /** The client's cgroup v2 path, as /proc/<pid>/cgroup spells it. */
  readonly cgroup: string;
}

export interface WindowsPeer {
  readonly os: "windows";
  /** A user (S-1-5-21-…) or service (S-1-5-80-…) SID. */
  readonly sid: string;
  /** The logon session LUID as a canonical decimal u64. */
  readonly logonLuid: string;
  readonly tsSessionId: number;
  /** The mandatory integrity level RID, such as 0x2000 for medium. */
  readonly integrityRid: number;
  readonly pidHint: number | null;
}

export type Peer = LinuxPeer | WindowsPeer;

const KEYS = {
  linux: ["os", "uid", "gid", "pidHint", "cgroup"],
  windows: ["os", "sid", "logonLuid", "tsSessionId", "integrityRid", "pidHint"],
} as const;

const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;
const SUBAUTHORITY = "(0|[1-9][0-9]{0,9})";
const SID = new RegExp(`^S-1-5-(21(-${SUBAUTHORITY}){4}|80(-${SUBAUTHORITY}){5})$`);
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
// kernfs refuses "\n" in a cgroup name so that /proc/<pid>/cgroup stays one line per hierarchy.
const CGROUP = /^(\/|(\/[^/\0\n]+)+)$/;
const MAX_CGROUP_BYTES = 4096;
const MAX_PEER_VALUES = 16;

// A user (S-1-5-21-…) or service (S-1-5-80-…) SID in canonical form: the only accounts a Windows
// peer may name, since groups and well-known SIDs stand for whole populations.
export const isAccountSid = (value: unknown): value is string =>
  typeof value === "string" && SID.test(value) && value.split("-").slice(3).every(part => Number(part) <= U32_MAX);

const isU32 = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= U32_MAX && !Object.is(value, -0);

const FIELDS: Readonly<Record<string, (value: unknown) => boolean>> = {
  uid: isU32,
  gid: isU32,
  pidHint: value => value === null || isU32(value),
  cgroup: value => typeof value === "string" && CGROUP.test(value) && new TextEncoder().encode(value).length <= MAX_CGROUP_BYTES,
  sid: isAccountSid,
  logonLuid: value => typeof value === "string" && DECIMAL.test(value) && BigInt(value) <= U64_MAX,
  tsSessionId: isU32,
  integrityRid: isU32,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Exactly the keys of one system's peer, each of its exact type.
export function parsePeer(value: unknown): Peer {
  if (!isPlainObject(value) || (value.os !== "linux" && value.os !== "windows")) throw new BrokerWireError("PEER_INVALID", "peer");
  const keys: readonly string[] = KEYS[value.os];
  const present = Object.keys(value);
  if (present.length !== keys.length || present.some(key => !keys.includes(key))) throw new BrokerWireError("PEER_INVALID", "peer");
  for (const key of keys) {
    if (key !== "os" && !FIELDS[key]!(value[key])) throw new BrokerWireError("PEER_INVALID", key);
  }
  return { ...value } as unknown as Peer;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const NULL = "null";

// An OPEN payload: the literal bytes `null` for a client whose identity the frontend could not
// establish, otherwise one peer as strict JSON.
export function decodeOpenPayload(payload: Uint8Array): Peer | null {
  let text: string;
  let value: unknown;
  try {
    text = UTF8.decode(payload);
    if (text === NULL) return null;
    value = parseStrictJson(text, payload.byteLength, MAX_PEER_VALUES);
  } catch (error) {
    if (error instanceof TypeError || error instanceof StrictJsonError) throw new BrokerWireError("PEER_INVALID", "peer");
    throw error;
  }
  return parsePeer(value);
}
