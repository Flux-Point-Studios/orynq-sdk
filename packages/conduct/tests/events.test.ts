import { describe, expect, it } from "vitest";
import {
  actionDigestHex, buildAllowlistRoot, GUARD_LOG_GENESIS, GuardConfigError, MandateGuard, MemoryGuardLog, nextGuardLogHead,
  toProcessTraceEvent, type GuardEvent, type GuardLogHead, type MandateV1,
} from "../src/index.js";

const mandate = (): MandateV1 => ({
  schemaVersion: 1n, mandateId: new Uint8Array(16), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321",
  didFormatVersion: 0n, spendCap: { asset: "lovelace", amount: 10n, windowSeconds: 3600n },
  counterpartyAllowlistRoot: buildAllowlistRoot(["supplier"]), egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) },
  approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: 0n, notAfter: 100_000n },
  disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n },
});
const pay = { kind: "payment", asset: "lovelace", amount: 6n, counterparty: "supplier", timestamp: 7200n } as const;
const ctx = { id: "x", seq: 0, timestamp: "2026-10-27T00:00:00.000Z", visibility: "private" as const };

type Denial = Extract<GuardEvent, { type: "orynq.conduct.guard.denial.v1" }>;

function recorded(): { allowed: GuardEvent; denial: Denial; heads: [GuardLogHead, GuardLogHead] } {
  const log = new MemoryGuardLog();
  const guard = new MandateGuard({ mandate: mandate(), counterpartyAllowlist: ["supplier"], history: "fresh", now: () => 7200n, onEvent: (e, previous) => log.append(e, previous) });
  guard.enforce(pay);
  guard.enforce({ ...pay, counterparty: "mallory" });
  const { events: [allowed, denial], head } = log.history();
  return { allowed: allowed!, denial: denial as Denial, heads: [nextGuardLogHead(GUARD_LOG_GENESIS, allowed!), head] };
}

// Restores the authentic log up to `position`, with `event` at that position, against the authentic head there.
function restore(r: ReturnType<typeof recorded>, position: 0 | 1, event: GuardEvent) {
  const events = position === 0 ? [event] : [r.allowed, event];
  return () => new MandateGuard({ mandate: mandate(), counterpartyAllowlist: ["supplier"], now: () => 7200n, history: { events, head: r.heads[position] } });
}

describe("trace conversion validates every event field", () => {
  it("CONTROL: recorded allowed and denied events convert", () => {
    const { allowed, denial } = recorded();
    expect(toProcessTraceEvent(allowed, ctx).data).toMatchObject({ type: "orynq.conduct.guard.action.v1", seq: "0" });
    expect(toProcessTraceEvent(denial, ctx).data).toMatchObject({ reason: "COUNTERPARTY_NOT_ALLOWED", rule: "counterparty is not in the mandate allowlist" });
  });

  const fields = "invalid guard event fields or action digest";
  const denialRule = "invalid guard denial reason or rule";
  const cases: [string, 0 | 1, (e: ReturnType<typeof recorded>) => unknown, string][] = [
    ["forged action digest", 0, ({ allowed }) => ({ ...allowed, actionDigest: "0".repeat(64) }), fields],
    ["event time differs from action time", 0, ({ allowed }) => ({ ...allowed, timestamp: 7201n }), fields],
    ["event kind differs from action kind", 0, ({ allowed }) => ({ ...allowed, actionKind: "egress" }), fields],
    ["uppercase mandate commitment", 0, ({ allowed }) => ({ ...allowed, mandateCommitment: allowed.mandateCommitment.toUpperCase().replace(/[0-9]/g, "A") }), fields],
    ["non-string mandate commitment", 0, ({ allowed }) => ({ ...allowed, mandateCommitment: 7 }), fields],
    ["negative seq", 0, ({ allowed }) => ({ ...allowed, seq: -1n }), fields],
    ["seq beyond uint64", 0, ({ allowed }) => ({ ...allowed, seq: 1n << 64n }), fields],
    ["number guard clock", 0, ({ allowed }) => ({ ...allowed, enforcedAt: 7200 }), fields],
    ["unknown event type", 0, ({ allowed }) => ({ ...allowed, type: "orynq.conduct.guard.other.v1" }), "invalid guard event type"],
    ["forged denial rule", 1, ({ denial }) => ({ ...denial, rule: "forged" }), denialRule],
    ["unknown denial reason", 1, ({ denial }) => ({ ...denial, reason: "NOPE" }), denialRule],
    ["inherited denial reason", 1, ({ denial }) => ({ ...denial, reason: "toString" }), denialRule],
    ["array denial reason", 1, ({ denial }) => ({ ...denial, reason: [denial.reason] }), denialRule],
    ["boxed denial reason", 1, ({ denial }) => ({ ...denial, reason: Object(denial.reason) }), denialRule],
  ];
  for (const [name, position, forge, reason] of cases) {
    it(`${name} is refused by trace conversion and replay`, () => {
      const r = recorded();
      const forged = forge(r) as GuardEvent;
      expect(() => toProcessTraceEvent(forged, ctx)).toThrow(reason);
      expect(restore(r, position, position === 0 ? r.allowed : r.denial)).not.toThrow();
      expect(restore(r, position, forged)).toThrow(GuardConfigError);
      expect(restore(r, position, forged)).toThrow(`invalid recorded guard event: ${reason}`);
    });
  }

  it("a consistent event whose action time is later than its guard clock is refused by replay", () => {
    const r = recorded();
    const { allowed } = r;
    const action = { ...pay, timestamp: 7201n };
    const forged = { ...allowed, timestamp: 7201n, action, actionDigest: actionDigestHex(action) } as GuardEvent;
    expect(toProcessTraceEvent(forged, ctx).data).toMatchObject({ timestamp: "7201", enforcedAt: "7200" });
    expect(restore(r, 0, r.allowed)).not.toThrow();
    expect(restore(r, 0, forged)).toThrow(/^invalid recorded guard event: action timestamp must not be later than the guard clock$/);
  });
});
