import { createHash, randomBytes } from "node:crypto";
import type { Peer } from "@fluxpointstudios/orynq-sdk-core/broker-wire";
import { cborEncode, type CborMap, type CborValue } from "@fluxpointstudios/orynq-sdk-conduct";
import { jsonToCbor } from "./dcbor.js";
import { RpcError } from "./errors.js";
import type { RpcRequest } from "./framing.js";
import { agentUnit, checkPrincipalConfig, type Principal, type PrincipalConfig, principalOf } from "./principals.js";
import { METHOD_PARAMS, SCHEMA_RULES } from "./schema.js";

export interface BrokerOptions {
  readonly principals: PrincipalConfig;
  /** The SPKI of X's receipt key; brokerId is its SHA-256 (spec §6.3). */
  readonly receiptKey: Uint8Array;
  /** policy.cbor; policyHash is its SHA-256. */
  readonly policy: Uint8Array;
  /** Commitments C, as lowercase hex, registered for this broker and allowed to bind to a session. */
  readonly registeredMandates: ReadonlySet<string>;
}

interface Session {
  readonly unit: string;
  readonly mandates: readonly string[];
}

type Access = "any" | "operator";

interface Method {
  readonly access: Access;
  readonly run: (principal: Principal, params: CborMap) => unknown;
}

const AGENT_CONNECTIONS = 8;
const OTHER_CONNECTIONS = 32;
const JOURNAL_DOMAIN = new TextEncoder().encode("orynq:broker:journal:v1|");

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sha256 = (...parts: Uint8Array[]) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
const sessionOf = (principal: Principal) => (principal.startsWith("agent:") ? principal.slice("agent:".length) : undefined);

// B's request side: principals, sessions and the method table. The journal is the §11 hash chain
// held in memory, so broker.hello can report its head; it gains a store with the rest of §11.
export class Broker {
  private readonly sessions = new Map<string, Session>();
  private journalSeq = 0n;
  private journalHash: Uint8Array = new Uint8Array(32);
  private readonly brokerId: string;
  private readonly policyHash: string;

  private readonly methods: Partial<Record<keyof typeof METHOD_PARAMS, Method>> = {
    "broker.hello": { access: "any", run: principal => this.hello(principal) },
    "session.open": { access: "operator", run: (_, params) => this.openSession(params) },
    "session.close": { access: "operator", run: (_, params) => this.closeSession(params) },
  };

  constructor(private readonly options: BrokerOptions) {
    checkPrincipalConfig(options.principals);
    this.brokerId = hex(sha256(options.receiptKey));
    this.policyHash = hex(sha256(options.policy));
  }

  principalOf(peer: Peer | null): Principal | undefined {
    return principalOf(peer, this.options.principals, sessionId => this.sessions.has(sessionId));
  }

  /** Connections one principal may hold, or one account without a principal (undefined). */
  connectionCap(principal: Principal | undefined): number {
    return principal !== undefined && sessionOf(principal) !== undefined ? AGENT_CONNECTIONS : OTHER_CONNECTIONS;
  }

  // A principal comes from the connection's peer when it opened; an agent's lapses with its session.
  async handle(request: RpcRequest, principal: Principal | undefined): Promise<Uint8Array> {
    const sessionId = principal && sessionOf(principal);
    if (principal === undefined || (sessionId !== undefined && !this.sessions.has(sessionId))) throw new RpcError("PEER_UNKNOWN");
    const method = Object.hasOwn(this.methods, request.method) ? this.methods[request.method as keyof typeof METHOD_PARAMS] : undefined;
    if (!method || (method.access === "operator" && principal !== "operator")) throw new RpcError("METHOD_NOT_FOUND");
    const rule = SCHEMA_RULES[METHOD_PARAMS[request.method as keyof typeof METHOD_PARAMS]];
    const result = method.run(principal, jsonToCbor(request.params, rule) as CborMap);
    return new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }

  private hello(principal: Principal) {
    const sessionId = sessionOf(principal);
    const session = sessionId === undefined ? undefined : this.sessions.get(sessionId);
    return {
      protocol: 2,
      brokerId: this.brokerId,
      receiptKey: hex(this.options.receiptKey),
      policyHash: this.policyHash,
      principal,
      ...(sessionId === undefined ? {} : { sessionId }),
      mandates: session?.mandates ?? [],
      verifyMode: "replay",
      journalHead: { seq: this.journalSeq.toString(), hash: hex(this.journalHash) },
    };
  }

  private openSession(params: CborMap) {
    const mandates = (params.get("mandates") as Uint8Array[]).map(hex);
    if (new Set(mandates).size !== mandates.length) throw new RpcError("INVALID_PARAMS", { field: "params.mandates" });
    const unknown = mandates.findIndex(c => !this.options.registeredMandates.has(c));
    if (unknown >= 0) throw new RpcError("MANDATE_REFUSED", { field: `params.mandates[${unknown}]` });
    const id = new Uint8Array(randomBytes(16));
    const sessionId = hex(id);
    const unit = agentUnit(sessionId);
    this.sessions.set(sessionId, { unit, mandates });
    this.journal([["event", "session.bound"], ["sessionId", id], ["unit", unit], ["mandates", params.get("mandates") as CborValue]]);
    return { sessionId, unit };
  }

  private closeSession(params: CborMap) {
    const id = params.get("sessionId") as Uint8Array;
    const sessionId = hex(id);
    const session = this.sessions.get(sessionId);
    if (!session) throw new RpcError("INVALID_PARAMS", { field: "params.sessionId" });
    this.sessions.delete(sessionId);
    this.journal([["event", "session.closed"], ["sessionId", id]]);
    return { sessionId, unit: session.unit };
  }

  private journal(event: [string, CborValue][]): void {
    this.journalHash = sha256(JOURNAL_DOMAIN, this.journalHash, cborEncode(new Map(event)));
    this.journalSeq += 1n;
  }
}
