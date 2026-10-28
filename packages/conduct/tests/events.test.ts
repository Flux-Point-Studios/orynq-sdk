import { describe, expect, it } from "vitest";
import {
  actionDigestHex, buildAllowlistRoot, GuardConfigError, MandateGuard, MemoryGuardLog, toProcessTraceEvent,
  type GuardEvent, type MandateV1,
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

function recorded(): { allowed: GuardEvent; denial: Extract<GuardEvent, { type: "orynq.conduct.guard.denial.v1" }> } {
  const log = new MemoryGuardLog();
  const guard = new MandateGuard({ mandate: mandate(), counterpartyAllowlist: ["supplier"], history: "fresh", now: () => 7200n, onEvent: e => log.append(e) });
  guard.enforce(pay);
  guard.enforce({ ...pay, counterparty: "mallory" });
  const [allowed, denial] = log.history().events;
  return { allowed: allowed!, denial: denial as Extract<GuardEvent, { type: "orynq.conduct.guard.denial.v1" }> };
}

const restore = (events: GuardEvent[]) => () => new MandateGuard({
  mandate: mandate(), counterpartyAllowlist: ["supplier"], now: () => 7200n, history: { events, head: { count: BigInt(events.length), hash: "0".repeat(64) } },
});

describe("trace conversion validates every event field", () => {
  it("CONTROL: recorded allowed and denied events convert", () => {
    const { allowed, denial } = recorded();
    expect(toProcessTraceEvent(allowed, ctx).data).toMatchObject({ type: "orynq.conduct.guard.action.v1", seq: "0" });
    expect(toProcessTraceEvent(denial, ctx).data).toMatchObject({ reason: "COUNTERPARTY_NOT_ALLOWED", rule: "counterparty is not in the mandate allowlist" });
  });

  const cases: [string, (e: ReturnType<typeof recorded>) => unknown, RegExp][] = [
    ["forged action digest", ({ allowed }) => ({ ...allowed, actionDigest: "0".repeat(64) }), /invalid guard event fields or action digest/],
    ["event time differs from action time", ({ allowed }) => ({ ...allowed, timestamp: 7201n }), /invalid guard event fields or action digest/],
    ["event kind differs from action kind", ({ allowed }) => ({ ...allowed, actionKind: "egress" }), /invalid guard event fields or action digest/],
    ["uppercase mandate commitment", ({ allowed }) => ({ ...allowed, mandateCommitment: allowed.mandateCommitment.toUpperCase().replace(/[0-9]/g, "A") }), /invalid guard event fields or action digest/],
    ["non-string mandate commitment", ({ allowed }) => ({ ...allowed, mandateCommitment: 7 }), /invalid guard event fields or action digest/],
    ["negative seq", ({ allowed }) => ({ ...allowed, seq: -1n }), /invalid guard event fields or action digest/],
    ["seq beyond uint64", ({ allowed }) => ({ ...allowed, seq: 1n << 64n }), /invalid guard event fields or action digest/],
    ["number guard clock", ({ allowed }) => ({ ...allowed, enforcedAt: 7200 }), /invalid guard event fields or action digest/],
    ["unknown event type", ({ allowed }) => ({ ...allowed, type: "orynq.conduct.guard.other.v1" }), /invalid guard event type/],
    ["forged denial rule", ({ denial }) => ({ ...denial, rule: "forged" }), /invalid guard denial reason or rule/],
    ["unknown denial reason", ({ denial }) => ({ ...denial, reason: "NOPE" }), /invalid guard denial reason or rule/],
    ["inherited denial reason", ({ denial }) => ({ ...denial, reason: "toString" }), /invalid guard denial reason or rule/],
    ["array denial reason", ({ denial }) => ({ ...denial, reason: [denial.reason] }), /invalid guard denial reason or rule/],
    ["boxed denial reason", ({ denial }) => ({ ...denial, reason: Object(denial.reason) }), /invalid guard denial reason or rule/],
  ];
  for (const [name, forge, reason] of cases) {
    it(`${name} is refused by trace conversion and replay`, () => {
      const forged = forge(recorded()) as GuardEvent;
      expect(() => toProcessTraceEvent(forged, ctx)).toThrow(reason);
      expect(restore([forged])).toThrow(GuardConfigError);
    });
  }

  it("a consistent event whose action time is later than its guard clock is refused by replay", () => {
    const { allowed } = recorded();
    const action = { ...pay, timestamp: 7201n };
    const forged = { ...allowed, timestamp: 7201n, action, actionDigest: actionDigestHex(action) } as GuardEvent;
    expect(toProcessTraceEvent(forged, ctx).data).toMatchObject({ timestamp: "7201", enforcedAt: "7200" });
    expect(restore([forged])).toThrow(/invalid recorded guard event: action timestamp must not be later than the guard clock/);
  });
});
