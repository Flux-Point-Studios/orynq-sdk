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
  /**
   * The client token's user SID as ConvertSidToStringSidW spells it: a user (S-1-5-21-…) or
   * service (S-1-5-80-…) SID, or another account the pipe admits, such as SYSTEM (S-1-5-18).
   */
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
const ACCOUNT_SID = new RegExp(`^S-1-5-(21(-${SUBAUTHORITY}){4}|80(-${SUBAUTHORITY}){5})$`);
// ConvertSidToStringSidW spells an authority of 2^32 or more in hex; no token a pipe admits has one.
const SID = new RegExp(`^S-1-${SUBAUTHORITY}(-${SUBAUTHORITY}){1,15}$`);
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
// kernfs refuses "\n" in a cgroup name so that /proc/<pid>/cgroup stays one line per hierarchy.
const CGROUP = /^(\/|(\/[^/\0\n]+)+)$/;
const MAX_CGROUP_BYTES = 4096;
const MAX_PEER_VALUES = 16;

const isSid = (value: unknown, form: RegExp): value is string =>
  typeof value === "string" && form.test(value) && value.split("-").slice(2).every(part => Number(part) <= U32_MAX);

// A user (S-1-5-21-…) or service (S-1-5-80-…) SID in canonical form: the only accounts a principal
// may be configured as, since groups and well-known SIDs stand for whole populations.
export const isAccountSid = (value: unknown): value is string => isSid(value, ACCOUNT_SID);

const isU32 = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= U32_MAX && !Object.is(value, -0);

const FIELDS: Readonly<Record<string, (value: unknown) => boolean>> = {
  uid: isU32,
  gid: isU32,
  pidHint: value => value === null || isU32(value),
  cgroup: value => typeof value === "string" && CGROUP.test(value) && new TextEncoder().encode(value).length <= MAX_CGROUP_BYTES,
  sid: value => isSid(value, SID),
  logonLuid: value => typeof value === "string" && DECIMAL.test(value) && BigInt(value) <= U64_MAX,
  tsSessionId: isU32,
  integrityRid: isU32,
};

function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// A plain object's own properties, each read once, so the checks and the result see the same
// values; an accessor, a symbol key or a non-enumerable key is not peer data. fromEntries defines a
// "__proto__" key as a property rather than setting the prototype, so it stays refused.
function snapshot(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) return undefined;
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

// Exactly the keys of one system's peer, each of its exact type.
export function parsePeer(value: unknown): Peer {
  const peer = snapshot(value);
  if (!peer || (peer.os !== "linux" && peer.os !== "windows")) throw new BrokerWireError("PEER_INVALID", "peer");
  const keys: readonly string[] = KEYS[peer.os];
  const present = Object.keys(peer);
  if (present.length !== keys.length || present.some(key => !keys.includes(key))) throw new BrokerWireError("PEER_INVALID", "peer");
  for (const key of keys) {
    if (key !== "os" && !FIELDS[key]!(peer[key])) throw new BrokerWireError("PEER_INVALID", key);
  }
  return peer as unknown as Peer;
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
