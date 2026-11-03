import { isAccountSid, type Peer } from "@fluxpointstudios/orynq-sdk-core/broker-wire";

// Spec §5.2: `agent:<sessionId>` is an orynq-agent peer in its session's unit cgroup, `operator`
// the operator's account, `service:<name>` a service's uid inside its unit's cgroup (Linux) or its
// service SID (Windows). Every other peer, and a client the frontend could not identify, has none.
export type Principal = "operator" | `agent:${string}` | `service:${string}`;

export interface LinuxService {
  readonly uid: number;
  /** The cgroup v2 path of the service's unit, such as /system.slice/orynq-drain.service. */
  readonly cgroup: string;
}

export interface WindowsService {
  readonly sid: string;
}

export interface PrincipalConfig {
  readonly operatorUid?: number;
  readonly operatorSid?: string;
  /** The orynq-agent uid, and the cgroup path of the slice session units run in. */
  readonly agent?: { readonly uid: number; readonly slice: string };
  readonly services?: Readonly<Record<string, LinuxService | WindowsService>>;
}

const SESSION_ID = /^[0-9a-f]{32}$/;
const SERVICE_NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
// Absolute, no empty, "." or ".." component, no trailing slash: one spelling per cgroup.
const CGROUP_PATH = /^(\/|(\/(?!\.\.?(\/|$))[^/\0\n]+)+)$/;
const UNIT_PREFIX = "orynq-agent-";
const UNIT_SUFFIX = ".service";

export const agentUnit = (sessionId: string): string => `${UNIT_PREFIX}${sessionId}${UNIT_SUFFIX}`;

const under = (slice: string, name: string) => (slice === "/" ? `/${name}` : `${slice}/${name}`);

const isU32 = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;

// One uid or SID per principal (spec §5.1: no agent runs as the operator, one uid per service).
export function checkPrincipalConfig(config: PrincipalConfig): void {
  const uids: unknown[] = [];
  const sids: unknown[] = [];
  if (config.operatorUid !== undefined) uids.push(config.operatorUid);
  if (config.operatorSid !== undefined) sids.push(config.operatorSid);
  if (config.agent) {
    uids.push(config.agent.uid);
    if (!CGROUP_PATH.test(config.agent.slice)) throw new TypeError("the agent slice must be a canonical cgroup path");
  }
  for (const [name, service] of Object.entries(config.services ?? {})) {
    if (!SERVICE_NAME.test(name)) throw new TypeError("a service name must be lowercase letters, digits and inner hyphens");
    if ("sid" in service) {
      sids.push(service.sid);
    } else {
      uids.push(service.uid);
      if (!CGROUP_PATH.test(service.cgroup)) throw new TypeError(`service ${name} must name a canonical cgroup path`);
    }
  }
  if (!uids.every(isU32) || new Set(uids).size !== uids.length) throw new TypeError("principal uids must be distinct u32s");
  if (!sids.every(isAccountSid) || new Set(sids).size !== sids.length) throw new TypeError("principal SIDs must be distinct account SIDs");
}

export function principalOf(peer: Peer | null, config: PrincipalConfig, isOpen: (sessionId: string) => boolean): Principal | undefined {
  if (peer === null) return undefined;
  const services = Object.entries(config.services ?? {});
  if (peer.os === "windows") {
    if (peer.sid === config.operatorSid) return "operator";
    const service = services.find(([, s]) => "sid" in s && s.sid === peer.sid);
    return service && `service:${service[0]}`;
  }
  if (peer.uid === config.operatorUid) return "operator";
  if (config.agent && peer.uid === config.agent.uid) {
    const stem = under(config.agent.slice, UNIT_PREFIX);
    if (!peer.cgroup.startsWith(stem) || !peer.cgroup.endsWith(UNIT_SUFFIX)) return undefined;
    const sessionId = peer.cgroup.slice(stem.length, -UNIT_SUFFIX.length);
    return SESSION_ID.test(sessionId) && isOpen(sessionId) ? `agent:${sessionId}` : undefined;
  }
  const service = services.find(([, s]) => "uid" in s && s.uid === peer.uid && s.cgroup === peer.cgroup);
  return service && `service:${service[0]}`;
}
