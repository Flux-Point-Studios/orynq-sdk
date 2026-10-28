import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  actionDigestHex, buildAllowlistRoot, GUARD_LOG_DOMAIN, GUARD_LOG_GENESIS, GuardConfigError, MandateGuard, MemoryGuardLog, nextGuardLogHead,
  toProcessTraceEvent, type GuardConfig, type GuardEvent, type GuardEventSink, type GuardHistory, type MandateV1,
} from "../src/index.js";

const pay = { kind: "payment", asset: "lovelace", amount: 6n, counterparty: "supplier", timestamp: 7200n } as const;
const mandate = (): MandateV1 => ({
  schemaVersion: 1n, mandateId: new Uint8Array(16).fill(0x42), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321",
  didFormatVersion: 0n, spendCap: { asset: "lovelace", amount: 10n, windowSeconds: 3600n },
  counterpartyAllowlistRoot: buildAllowlistRoot(["supplier"]), egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) },
  approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: 0n, notAfter: 100_000n },
  disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n },
});
const base = () => ({ mandate: mandate(), counterpartyAllowlist: ["supplier"], now: () => 7200n });
const sinkTo = (log: MemoryGuardLog): GuardEventSink => (event, previous) => log.append(event, previous);
const staleWriter = /^guard log head is 1:[0-9a-f]{64}, but the append expected 0:0{64}$/;

function threeEventLog(): { log: MemoryGuardLog; history: GuardHistory } {
  const log = new MemoryGuardLog();
  const guard = new MandateGuard({ ...base(), history: "fresh", onEvent: sinkTo(log) });
  guard.enforce(pay);
  guard.enforce({ ...pay, amount: 4n });
  guard.enforce({ ...pay, amount: 1n });
  return { log, history: log.history() };
}

describe("R-1: accounting state is an explicit constructor input", () => {
  it("a guard constructed without history is refused", () => {
    expect(() => new MandateGuard(base() as unknown as GuardConfig)).toThrow(GuardConfigError);
    expect(() => new MandateGuard(base() as unknown as GuardConfig)).toThrow(/history must be "fresh" or \{ events, head \}/);
  });

  it("malformed history declarations are refused", () => {
    const hash = GUARD_LOG_GENESIS.hash;
    const bad: unknown[] = [
      undefined, null, "", "Fresh", "restore", 0, true, [], {}, { events: [] }, { head: GUARD_LOG_GENESIS },
      { events: 5, head: GUARD_LOG_GENESIS }, { events: [], head: null }, { events: [], head: { count: 0, hash } },
      { events: [], head: { count: -1n, hash } }, { events: [], head: { count: 1n << 64n, hash } },
      { events: [], head: { count: 0n, hash: hash.toUpperCase().replace("0", "A") } }, { events: [], head: { count: 0n, hash: hash.slice(2) } },
      { events: [], head: { count: 0n } },
    ];
    for (const history of bad) {
      expect(() => new MandateGuard({ ...base(), history } as GuardConfig), JSON.stringify(history, (_, v) => typeof v === "bigint" ? `${v}n` : v)).toThrow(GuardConfigError);
    }
  });

  it("an explicit fresh declaration starts at the genesis head", () => {
    const guard = new MandateGuard({ ...base(), history: "fresh" });
    expect(guard.head).toEqual(GUARD_LOG_GENESIS);
    expect(guard.head).toEqual({ count: 0n, hash: "0".repeat(64) });
    expect(guard.spentInWindow(7200n)).toBe(0n);
  });

  it("payment enforcement without an event sink is refused before any state change, allowed or denied", () => {
    const guard = new MandateGuard({ ...base(), history: "fresh" });
    for (const payment of [pay, { ...pay, counterparty: "mallory" }, { ...pay, amount: 11n }]) {
      expect(() => guard.enforce(payment)).toThrow(/^payment enforcement requires an event sink$/);
    }
    expect(guard.spentInWindow(7200n)).toBe(0n);
    expect(guard.head).toEqual(GUARD_LOG_GENESIS);
    expect(guard.evaluate(pay)).toEqual({ allowed: true });
    expect(guard.evaluate({ ...pay, counterparty: "mallory" })).toMatchObject({ allowed: false, reason: "COUNTERPARTY_NOT_ALLOWED" });
  });

  it("egress enforcement without an event sink returns its decision and advances only the guard's head", () => {
    const destinations = ["api.example.com"];
    const guard = new MandateGuard({
      ...base(), history: "fresh", egressAllowlist: destinations,
      mandate: { ...mandate(), egressPolicy: { mode: 1n, allowlistRoot: buildAllowlistRoot(destinations) } },
    });
    const decisions: unknown[] = [];
    expect(() => decisions.push(guard.enforce({ kind: "egress", destination: "api.example.com", timestamp: 7200n }))).not.toThrow();
    expect(() => decisions.push(guard.enforce({ kind: "egress", destination: "evil.example", timestamp: 7200n }))).not.toThrow();
    expect(decisions).toEqual([{ allowed: true }, expect.objectContaining({ allowed: false, reason: "EGRESS_NOT_ALLOWED" })]);
    expect(guard.head.count).toBe(2n);
    expect(() => guard.enforce(pay)).toThrow(/^payment enforcement requires an event sink$/);
  });

  it("configuration errors keep their cause", () => {
    const failure = (config: GuardConfig): Error => {
      try {
        new MandateGuard(config);
      } catch (error) {
        return error as Error;
      }
      throw new Error("construction succeeded");
    };
    const shape = failure({ ...base(), history: { events: [], head: { count: -1n, hash: GUARD_LOG_GENESIS.hash } } });
    expect(shape).toBeInstanceOf(GuardConfigError);
    expect(shape.cause).toBeInstanceOf(Error);
    expect(shape).toHaveProperty("cause.message", "guard log head must be { count: bigint in [0, 2^64], hash: 64 lowercase hex }");
    const { history } = threeEventLog();
    const replay = failure({ ...base(), history: { events: [{ ...history.events[0]!, actionDigest: "0".repeat(64) }], head: history.head } });
    expect(replay.message).toBe("invalid recorded guard event: invalid guard event fields or action digest");
    expect(replay.cause).toBeInstanceOf(Error);
    expect(replay).toHaveProperty("cause.message", "invalid guard event fields or action digest");
  });
});

describe("R-1: the sink contract admits exactly one writer per log position", () => {
  it("MemoryGuardLog appends contiguous events and reports the guard's head", () => {
    const { log, history } = threeEventLog();
    expect(history.events.map(e => e.seq)).toEqual([0n, 1n, 2n]);
    expect(history.head.count).toBe(3n);
    const restored = new MandateGuard({ ...base(), history, onEvent: sinkTo(log) });
    expect(restored.head).toEqual(history.head);
  });

  it("MemoryGuardLog refuses an event whose seq is not the log length, without writing", () => {
    const { log, history } = threeEventLog();
    for (const event of [history.events[0]!, history.events[2]!]) {
      expect(() => log.append(event, history.head)).toThrow(/^cannot append guard event seq \d+ at log length 3$/);
    }
    expect(log.history()).toEqual(history);
    const empty = new MemoryGuardLog();
    expect(() => empty.append(history.events[1]!, GUARD_LOG_GENESIS)).toThrow(/^cannot append guard event seq 1 at log length 0$/);
    expect(empty.history()).toEqual({ events: [], head: GUARD_LOG_GENESIS });
  });

  it("appending stores a snapshot, so the caller's object cannot rewrite the log", () => {
    const { history } = threeEventLog();
    const log = new MemoryGuardLog();
    const event = { ...history.events[0]! };
    expect(log.append(event, GUARD_LOG_GENESIS)).toEqual(nextGuardLogHead(GUARD_LOG_GENESIS, history.events[0]!));
    (event as { seq: bigint }).seq = 5n;
    expect(log.history().events[0]!.seq).toBe(0n);
    expect(Object.isFrozen(log.history().events[0])).toBe(true);
    expect(log.history().head).toEqual(nextGuardLogHead(GUARD_LOG_GENESIS, history.events[0]!));
  });

  it("history() snapshots cannot be used to rewrite the log", () => {
    const { log } = threeEventLog();
    const snapshot = log.history();
    (snapshot.events as GuardEvent[]).pop();
    expect(() => { (snapshot.events[0] as { seq: bigint }).seq = 9n; }).toThrow(TypeError);
    expect(log.history().events).toHaveLength(3);
  });

  it("two live guards on one log: the second writer fails closed and is never authorized", () => {
    const log = new MemoryGuardLog();
    const first = new MandateGuard({ ...base(), history: "fresh", onEvent: sinkTo(log) });
    const second = new MandateGuard({ ...base(), history: "fresh", onEvent: sinkTo(log) });
    expect(first.enforce({ ...pay, amount: 10n })).toEqual({ allowed: true });
    expect(() => second.enforce({ ...pay, amount: 10n })).toThrow(staleWriter);
    expect(() => second.enforce({ ...pay, amount: 1n })).toThrow(/event sink failed; restore a new guard/);
    expect(log.history().events).toHaveLength(1);
    const restored = new MandateGuard({ ...base(), history: log.history(), onEvent: sinkTo(log) });
    expect(restored.enforce({ ...pay, amount: 1n })).toMatchObject({ allowed: false, reason: "SPEND_CAP_EXCEEDED" });
  });

  it("two live async guards: the slower writer is refused after its awaited sink fails", async () => {
    const log = new MemoryGuardLog();
    const delayed: GuardEventSink = (event, previous) => new Promise<void>(resolve => setTimeout(resolve, 5)).then(() => log.append(event, previous));
    const first = new MandateGuard({ ...base(), history: "fresh", onEvent: delayed });
    const second = new MandateGuard({ ...base(), history: "fresh", onEvent: delayed });
    const results = await Promise.allSettled([first.enforceAsync({ ...pay, amount: 10n }), second.enforceAsync({ ...pay, amount: 10n })]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason.message).toMatch(staleWriter);
    expect(log.history().events).toHaveLength(1);
  });

  it("restarts that declare fresh against a non-empty log cannot spend the cap again", () => {
    const log = new MemoryGuardLog();
    let executed = 0n;
    for (let restart = 0; restart < 4; restart++) {
      const guard = new MandateGuard({ ...base(), history: "fresh", onEvent: sinkTo(log) });
      try {
        if (guard.enforce({ ...pay, amount: 10n }).allowed) executed += 10n;
      } catch (error) {
        expect((error as Error).message).toMatch(staleWriter);
      }
    }
    expect(executed).toBe(10n);
    expect(log.history().events).toHaveLength(1);
  });

  it("restarts that restore the log hold the cap and record every decision", () => {
    const log = new MemoryGuardLog();
    let executed = 0n;
    for (let restart = 0; restart < 4; restart++) {
      const guard = new MandateGuard({ ...base(), history: restart === 0 ? "fresh" : log.history(), onEvent: sinkTo(log) });
      if (guard.enforce({ ...pay, amount: 10n }).allowed) executed += 10n;
    }
    expect(executed).toBe(10n);
    expect(log.history().events.map(e => e.type)).toEqual([
      "orynq.conduct.guard.action.v1", "orynq.conduct.guard.denial.v1", "orynq.conduct.guard.denial.v1", "orynq.conduct.guard.denial.v1",
    ]);
  });
});

describe("R-3: restore must end at the head the sink reports", () => {
  it("CONTROL: the complete log restores spend, sequence and head", () => {
    const { log, history } = threeEventLog();
    const guard = new MandateGuard({ ...base(), history, onEvent: sinkTo(log) });
    expect(guard.spentInWindow(7200n)).toBe(10n);
    expect(guard.head).toEqual(history.head);
    guard.enforce({ kind: "egress", destination: "api.example.com", timestamp: 7200n });
    expect(log.history().events.map(e => e.seq)).toEqual([0n, 1n, 2n, 3n]);
  });

  it("tail truncation is refused", () => {
    const { history } = threeEventLog();
    for (const events of [history.events.slice(0, 2), history.events.slice(0, 1), []]) {
      expect(() => new MandateGuard({ ...base(), history: { events, head: history.head } })).toThrow(/recorded guard events do not end at the expected log head/);
    }
  });

  it("delete-and-renumber of an allowed payment is refused", () => {
    const { history } = threeEventLog();
    const forged = [{ ...history.events[1]!, seq: 0n }];
    expect(() => new MandateGuard({ ...base(), history: { events: forged, head: history.head } })).toThrow(/do not end at the expected log head/);
  });

  it("a same-length rewrite with lower spend is refused by the hash", () => {
    const { history } = threeEventLog();
    const other = new MemoryGuardLog();
    const forger = new MandateGuard({ ...base(), history: "fresh", onEvent: sinkTo(other) });
    for (const amount of [1n, 1n, 1n]) forger.enforce({ ...pay, amount });
    const rewritten = other.history().events;
    expect(rewritten).toHaveLength(Number(history.head.count));
    expect(() => new MandateGuard({ ...base(), history: { events: rewritten, head: history.head } })).toThrow(/do not end at the expected log head/);
  });

  it("a recorded guard clock moved later is refused against the authentic head", () => {
    const { history } = threeEventLog();
    const moved = [{ ...history.events[0]!, enforcedAt: 10_799n }];
    expect(() => new MandateGuard({ ...base(), history: { events: moved, head: nextGuardLogHead(GUARD_LOG_GENESIS, history.events[0]!) } }))
      .toThrow(/do not end at the expected log head/);
  });

  it("a head whose hash matches but whose count disagrees is refused", () => {
    const { history } = threeEventLog();
    for (const count of [2n, 4n, 0n]) {
      expect(() => new MandateGuard({ ...base(), history: { events: history.events, head: { count, hash: history.head.hash } } }))
        .toThrow(/do not end at the expected log head/);
    }
  });

  it("a rewrite of a non-final event that keeps the count and the final event is refused", () => {
    const log = new MemoryGuardLog();
    const guard = new MandateGuard({ ...base(), history: "fresh", onEvent: sinkTo(log) });
    guard.enforce(pay);
    guard.enforce({ kind: "egress", destination: "api.example.com", timestamp: 7200n });
    const { events, head } = log.history();
    const action = { ...events[0]!.action, amount: 1n } as GuardEvent["action"];
    const rewritten = [{ ...events[0]!, action, actionDigest: actionDigestHex(action) } as GuardEvent, events[1]!];
    expect(() => new MandateGuard({ ...base(), history: { events, head } })).not.toThrow();
    expect(() => new MandateGuard({ ...base(), history: { events: rewritten, head } })).toThrow(/^recorded guard events do not end at the expected log head$/);
  });

  it("a head may count up to 2^64 events: larger is malformed, 2^64 is well-formed but holds no position", () => {
    const top = { count: 1n << 64n, hash: GUARD_LOG_GENESIS.hash };
    expect(() => new MandateGuard({ ...base(), history: { events: [], head: top } })).toThrow(/^recorded guard events do not end at the expected log head$/);
    const { history } = threeEventLog();
    expect(() => nextGuardLogHead(top, history.events[0]!)).toThrow(/^cannot append guard event seq 0 at log length 18446744073709551616$/);
    expect(() => nextGuardLogHead({ ...top, count: (1n << 64n) + 1n }, history.events[0]!)).toThrow(/^guard log head must be/);
  });

  it("head mismatch is checked after replay, so replay errors keep their reason", () => {
    const { history } = threeEventLog();
    const reordered = [history.events[1]!, history.events[0]!];
    expect(() => new MandateGuard({ ...base(), history: { events: reordered, head: history.head } })).toThrow(/invalid recorded guard event: event does not match replayed decision/);
  });

  it("restoring the empty log at genesis is equivalent to fresh", () => {
    const log = new MemoryGuardLog();
    const guard = new MandateGuard({ ...base(), history: log.history(), onEvent: sinkTo(log) });
    expect(guard.head).toEqual(GUARD_LOG_GENESIS);
    expect(guard.enforce(pay)).toEqual({ allowed: true });
  });
});

describe("guard log head", () => {
  const golden = [
    "7f2a8913f1287988d764eed84f94e5b2f794ca851f3e19ea808ffe826b3b4e05",
    "81d6a15a19063f4e95267d705b42e16e95f8ba3b245179306dc1c1df0e38a5b7",
    "47b4ab4b71e3475d91153aca9ea7d42edbd538ec83803ae7b1d77f6d7ca09736",
  ];
  const canon = (v: unknown): string => typeof v === "string" ? JSON.stringify(v)
    : `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;

  it("golden: heads match an independent SHA-256 chain over canonical event data", () => {
    expect(GUARD_LOG_DOMAIN).toBe("orynq:conduct:guard:log:v1|");
    const log = new MemoryGuardLog();
    const guard = new MandateGuard({ ...base(), history: "fresh", onEvent: sinkTo(log) });
    const heads: string[] = [];
    guard.enforce(pay); heads.push(guard.head.hash);
    guard.enforce({ ...pay, amount: 5n }); heads.push(guard.head.hash);
    guard.enforce({ kind: "egress", destination: "api.example.com", timestamp: 7200n }); heads.push(guard.head.hash);
    expect(heads).toEqual(golden);
    let hash = Buffer.alloc(32);
    for (const [i, event] of log.history().events.entries()) {
      const data = toProcessTraceEvent(event, { id: "x", seq: 0, timestamp: "2026-10-27T00:00:00.000Z", visibility: "private" }).data;
      hash = createHash("sha256").update("orynq:conduct:guard:log:v1|").update(hash).update(canon(data), "utf8").digest();
      expect(hash.toString("hex")).toBe(golden[i]);
    }
    expect(log.history().head).toEqual({ count: 3n, hash: golden[2] });
  });

  it("nextGuardLogHead advances one position and refuses any other", () => {
    const { history } = threeEventLog();
    const [e0, e1] = history.events;
    const h1 = nextGuardLogHead(GUARD_LOG_GENESIS, e0!);
    expect(h1.count).toBe(1n);
    expect(Object.isFrozen(h1)).toBe(true);
    expect(nextGuardLogHead(h1, e1!).count).toBe(2n);
    expect(() => nextGuardLogHead(GUARD_LOG_GENESIS, e1!)).toThrow(/cannot append guard event seq 1 at log length 0/);
    expect(() => nextGuardLogHead(h1, e0!)).toThrow(/cannot append guard event seq 0 at log length 1/);
    expect(() => nextGuardLogHead(GUARD_LOG_GENESIS, { ...e0!, actionDigest: "0".repeat(64) })).toThrow(/action digest/);
    for (const head of [{ count: 0n, hash: "zz".repeat(32) }, { count: 0n, hash: "00" }, { count: -1n, hash: "0".repeat(64) }, { count: 0, hash: "0".repeat(64) }]) {
      expect(() => nextGuardLogHead(head as never, e0!)).toThrow(/guard log head must be/);
    }
    expect(Object.isFrozen(GUARD_LOG_GENESIS)).toBe(true);
  });

  it("the guard head counts every recorded decision and equals the sink head", () => {
    const log = new MemoryGuardLog();
    const guard = new MandateGuard({ ...base(), history: "fresh", onEvent: sinkTo(log) });
    guard.enforce(pay);
    guard.enforce({ ...pay, counterparty: "mallory" });
    guard.enforce({ kind: "egress", destination: "api.example.com", timestamp: 7200n });
    expect(guard.head).toEqual(log.history().head);
    expect(guard.head.count).toBe(3n);
  });
});
