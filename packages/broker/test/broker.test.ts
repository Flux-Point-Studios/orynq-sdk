import { createHash } from "node:crypto";
import type { LinuxPeer, Peer, WindowsPeer } from "@fluxpointstudios/orynq-sdk-core/broker-wire";
import { cborEncode } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { Broker, type BrokerOptions } from "../src/broker.js";
import type { Principal } from "../src/principals.js";
import { RpcError } from "../src/errors.js";
import type { RpcRequest } from "../src/framing.js";

const OPERATOR = 1000;
const AGENT = 1500;
const DRAIN = 1600;
const SLICE = "/orynq.slice/orynq-agents.slice";
const DRAIN_UNIT = "/system.slice/orynq-drain.service";
const OPERATOR_SID = "S-1-5-21-1-2-3-1001";
const SEALED_SID = "S-1-5-80-1-2-3-4-5";
const C = (byte: number) => byte.toString(16).padStart(2, "0").repeat(32);
const REGISTERED = [C(0x11), C(0x22), C(0x33)];
const RECEIPT_KEY = Uint8Array.from({ length: 44 }, (_, i) => i);
const POLICY = Uint8Array.of(0xa1, 0x61, 0x76, 0x01);

const options = (overrides: Partial<BrokerOptions> = {}): BrokerOptions => ({
  principals: {
    operatorUid: OPERATOR,
    operatorSid: OPERATOR_SID,
    agent: { uid: AGENT, slice: SLICE },
    services: { drain: { uid: DRAIN, cgroup: DRAIN_UNIT }, sealed: { sid: SEALED_SID } },
  },
  receiptKey: RECEIPT_KEY,
  policy: POLICY,
  registeredMandates: new Set(REGISTERED),
  ...overrides,
});

const linux = (uid: number, cgroup: string): LinuxPeer => ({ os: "linux", uid, gid: uid, pidHint: 77, cgroup });
const windows = (sid: string): WindowsPeer => ({ os: "windows", sid, logonLuid: "999", tsSessionId: 1, integrityRid: 0x2000, pidHint: null });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sha256 = (...parts: Uint8Array[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
const utf8 = (text: string) => new TextEncoder().encode(text);

let nextId = 1;
async function call(broker: Broker, principal: Principal | undefined, method: string, params?: unknown): Promise<unknown> {
  const id = nextId++;
  const request: RpcRequest = { id, method, params: params === undefined ? {} : params };
  const reply = JSON.parse(new TextDecoder().decode(await broker.handle(request, principal))) as Record<string, unknown>;
  expect(reply).toMatchObject({ jsonrpc: "2.0", id });
  expect(Object.keys(reply).sort()).toEqual(["id", "jsonrpc", "result"]);
  return reply.result;
}

async function refusal(broker: Broker, principal: Principal | undefined, method: string, params?: unknown): Promise<RpcError> {
  try {
    await call(broker, principal, method, params);
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    return error as RpcError;
  }
  throw new Error(`${method} succeeded`);
}

async function openSession(broker: Broker, mandates = [REGISTERED[0]!]): Promise<{ sessionId: string; unit: string }> {
  return (await call(broker, "operator", "session.open", { mandates })) as { sessionId: string; unit: string };
}

describe("principals", () => {
  it("are unknown for an anonymous client and any peer the configuration does not name", () => {
    const broker = new Broker(options());
    for (const peer of [null, linux(4242, "/user.slice"), linux(0, "/"), windows("S-1-5-21-9-9-9-9")] as (Peer | null)[]) {
      expect(broker.principalOf(peer)).toBeUndefined();
    }
  });

  it("name the operator by uid on Linux and by SID on Windows", () => {
    const broker = new Broker(options());
    expect(broker.principalOf(linux(OPERATOR, "/user.slice/user-1000.slice/session-3.scope"))).toBe("operator");
    expect(broker.principalOf(linux(OPERATOR, "/"))).toBe("operator");
    expect(broker.principalOf(windows(OPERATOR_SID))).toBe("operator");
  });

  it("name a service by its uid inside its unit's cgroup, or by its service SID", () => {
    const broker = new Broker(options());
    expect(broker.principalOf(linux(DRAIN, DRAIN_UNIT))).toBe("service:drain");
    expect(broker.principalOf(linux(DRAIN, "/system.slice/other.service"))).toBeUndefined();
    expect(broker.principalOf(linux(DRAIN, `${DRAIN_UNIT}/child`))).toBeUndefined();
    expect(broker.principalOf(linux(OPERATOR + 1, DRAIN_UNIT))).toBeUndefined();
    expect(broker.principalOf(windows(SEALED_SID))).toBe("service:sealed");
  });

  it("name an agent only inside the unit cgroup of a session that is open", async () => {
    const broker = new Broker(options());
    const { sessionId, unit } = await openSession(broker);
    expect(broker.principalOf(linux(AGENT, `${SLICE}/${unit}`))).toBe(`agent:${sessionId}`);
    expect(broker.principalOf(linux(AGENT, SLICE))).toBeUndefined();
    expect(broker.principalOf(linux(AGENT, `${SLICE}/${unit}/child`))).toBeUndefined();
    expect(broker.principalOf(linux(AGENT, `/elsewhere.slice/${unit}`))).toBeUndefined();
    expect(broker.principalOf(linux(AGENT, `${SLICE}/orynq-agent-${"0".repeat(32)}.service`))).toBeUndefined();
    expect(broker.principalOf(linux(OPERATOR + 7, `${SLICE}/${unit}`))).toBeUndefined();
    await call(broker, "operator", "session.close", { sessionId });
    expect(broker.principalOf(linux(AGENT, `${SLICE}/${unit}`))).toBeUndefined();
  });

  it("join a root slice without doubling the slash", async () => {
    const broker = new Broker(options({ principals: { agent: { uid: AGENT, slice: "/" } } }));
    const { sessionId, unit } = await openSession(broker);
    expect(broker.principalOf(linux(AGENT, `/${unit}`))).toBe(`agent:${sessionId}`);
    expect(broker.principalOf(linux(AGENT, `//${unit}`))).toBeUndefined();
  });

  it("refuse a configuration that gives two principals one uid or SID, or a malformed path or name", () => {
    const bad: BrokerOptions["principals"][] = [
      { operatorUid: AGENT, agent: { uid: AGENT, slice: SLICE } },
      { operatorUid: DRAIN, services: { drain: { uid: DRAIN, cgroup: DRAIN_UNIT } } },
      { services: { a: { uid: DRAIN, cgroup: "/a.service" }, b: { uid: DRAIN, cgroup: "/b.service" } } },
      { agent: { uid: AGENT, slice: SLICE }, services: { drain: { uid: AGENT, cgroup: DRAIN_UNIT } } },
      { operatorSid: SEALED_SID, services: { sealed: { sid: SEALED_SID } } },
      { operatorUid: -1 },
      { operatorUid: 1.5 },
      { agent: { uid: AGENT, slice: "orynq.slice" } },
      { agent: { uid: AGENT, slice: "/orynq.slice/" } },
      { agent: { uid: AGENT, slice: "/orynq.slice/../system.slice" } },
      { services: { drain: { uid: DRAIN, cgroup: "/system.slice//orynq-drain.service" } } },
      { services: { "Drain Service": { uid: DRAIN, cgroup: DRAIN_UNIT } } },
      { operatorSid: "S-1-5-18" },
    ];
    for (const principals of bad) expect(() => new Broker(options({ principals }))).toThrow(TypeError);
  });

  it("cap connections at 8 per agent session and 32 per other principal", () => {
    const broker = new Broker(options());
    expect(broker.connectionCap(`agent:${"ab".repeat(16)}`)).toBe(8);
    expect(broker.connectionCap("operator")).toBe(32);
    expect(broker.connectionCap("service:drain")).toBe(32);
  });
});

describe("dispatch", () => {
  it("answers PEER_UNKNOWN to a peer with no principal, whatever it calls", async () => {
    const broker = new Broker(options());
    for (const method of ["broker.hello", "session.open", "no.such"]) {
      const error = await refusal(broker, undefined, method);
      expect([error.code, error.reason]).toEqual([-32001, "PEER_UNKNOWN"]);
    }
  });

  it("answers -32601 for a method the table lacks, and for a method the principal may not call", async () => {
    const broker = new Broker(options());
    for (const [principal, method] of [
      ["operator", "no.such"],
      ["operator", "credential.list"],
      ["operator", "release.commit"],
      ["service:drain", "session.open"],
      ["service:drain", "session.close"],
    ] as const) {
      expect((await refusal(broker, principal, method, { mandates: [REGISTERED[0]] })).code).toBe(-32601);
    }
    const { sessionId } = await openSession(broker);
    expect((await refusal(broker, `agent:${sessionId}`, "session.close", { sessionId })).code).toBe(-32601);
  });

  it("checks params against the method's CDDL rule before running it", async () => {
    const broker = new Broker(options());
    const error = await refusal(broker, "operator", "broker.hello", { extra: 1 });
    expect([error.code, error.field]).toEqual([-32602, "params"]);
    const bad = await refusal(broker, "operator", "session.open", { mandates: [] });
    expect([bad.code, bad.field]).toEqual([-32602, "params.mandates"]);
  });
});

describe("broker.hello", () => {
  it("tells the operator who it is and what this broker is", async () => {
    const broker = new Broker(options());
    expect(await call(broker, "operator", "broker.hello")).toEqual({
      protocol: 2,
      brokerId: hex(sha256(RECEIPT_KEY)),
      receiptKey: hex(RECEIPT_KEY),
      policyHash: hex(sha256(POLICY)),
      principal: "operator",
      mandates: [],
      verifyMode: "replay",
      journalHead: { seq: "0", hash: "00".repeat(32) },
    });
  });

  it("gives an agent its sessionId and the mandates its session binds", async () => {
    const broker = new Broker(options());
    const { sessionId } = await openSession(broker, [REGISTERED[2]!, REGISTERED[0]!]);
    expect(await call(broker, `agent:${sessionId}`, "broker.hello")).toMatchObject({
      principal: `agent:${sessionId}`,
      sessionId,
      mandates: [REGISTERED[2], REGISTERED[0]],
    });
    expect(await call(broker, "service:drain", "broker.hello")).toMatchObject({ principal: "service:drain", mandates: [] });
  });
});

describe("sessions", () => {
  it("open with a random 128-bit sessionId and the unit L starts for it", async () => {
    const broker = new Broker(options());
    const first = await openSession(broker);
    const second = await openSession(broker);
    expect(first.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.unit).toBe(`orynq-agent-${first.sessionId}.service`);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("bind only registered mandates, each once", async () => {
    const broker = new Broker(options());
    const unknown = await refusal(broker, "operator", "session.open", { mandates: [REGISTERED[0], C(0x44)] });
    expect([unknown.code, unknown.reason, unknown.field]).toEqual([-32011, "MANDATE_REFUSED", "params.mandates[1]"]);
    const twice = await refusal(broker, "operator", "session.open", { mandates: [REGISTERED[1], REGISTERED[1]] });
    expect([twice.code, twice.field]).toEqual([-32602, "params.mandates"]);
  });

  it("close by sessionId, answering what was closed, and refuse one that is not open", async () => {
    const broker = new Broker(options());
    const opened = await openSession(broker);
    expect(await call(broker, "operator", "session.close", { sessionId: opened.sessionId })).toEqual(opened);
    const again = await refusal(broker, "operator", "session.close", { sessionId: opened.sessionId });
    expect([again.code, again.field]).toEqual([-32602, "params.sessionId"]);
    expect((await refusal(broker, `agent:${opened.sessionId}`, "broker.hello")).reason).toBe("PEER_UNKNOWN");
  });

  it("append session.bound and session.closed to a hash-chained journal whose head hello reports", async () => {
    const broker = new Broker(options());
    const { sessionId, unit } = await openSession(broker, [REGISTERED[1]!]);
    await call(broker, "operator", "session.close", { sessionId });
    const prefix = utf8("orynq:broker:journal:v1|");
    const id = Buffer.from(sessionId, "hex");
    const bound = sha256(prefix, new Uint8Array(32), cborEncode(new Map<string, unknown>([
      ["event", "session.bound"],
      ["sessionId", new Uint8Array(id)],
      ["unit", unit],
      ["mandates", [new Uint8Array(Buffer.from(REGISTERED[1]!, "hex"))]],
    ]) as never));
    const closed = sha256(prefix, bound, cborEncode(new Map<string, unknown>([
      ["event", "session.closed"],
      ["sessionId", new Uint8Array(id)],
    ]) as never));
    expect(await call(broker, "operator", "broker.hello")).toMatchObject({ journalHead: { seq: "2", hash: hex(closed) } });
  });
});
