import { describe, expect, it } from "vitest";
import {
  computeEventHash,
  initRollingHash,
  updateRollingHash,
  type CustomEvent,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import {
  buildAllowlistRoot,
  MandateGuard,
  toProcessTraceEvent,
  type GuardEvent,
  type MandateV1,
} from "../src/index.js";

function mandate(): MandateV1 {
  return {
    schemaVersion: 1n,
    mandateId: new Uint8Array(16),
    principalDid: "did:key:z123456789",
    agentDid: "did:key:z987654321",
    didFormatVersion: 0n,
    spendCap: { asset: "lovelace", amount: 10n, windowSeconds: 60n },
    counterpartyAllowlistRoot: buildAllowlistRoot(["supplier"]),
    egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) },
    approvedMeasurementSetRoot: new Uint8Array(32),
    validityWindow: { notBefore: 0n, notAfter: (1n << 64n) - 1n },
    disclosurePolicy: { committeeId: "conduct-test", threshold: 2n, committeeSize: 3n },
  };
}

const payment = { kind: "payment", asset: "lovelace", amount: 6n, counterparty: "supplier", timestamp: 100n } as const;

describe("process-trace integration", () => {
  it("hashes an allowed action and a denial through the existing rolling trace", async () => {
    const events: CustomEvent[] = [];
    const guard = new MandateGuard({
      mandate: mandate(),
      counterpartyAllowlist: ["supplier"],
      onEvent: (event) => events.push(toProcessTraceEvent(event, {
        id: `550e8400-e29b-41d4-a716-${String(events.length).padStart(12, "0")}`,
        seq: events.length + 7,
        timestamp: "2026-10-27T00:00:00.000Z",
        visibility: "private",
      })),
    });
    expect(guard.enforce(payment)).toEqual({ allowed: true });
    expect(guard.enforce(payment)).toMatchObject({ allowed: false, reason: "SPEND_CAP_EXCEEDED" });
    expect(events.map((event) => event.kind)).toEqual(["custom", "custom"]);
    expect(events.map((event) => event.eventType)).toEqual(["orynq.conduct.guard.v1", "orynq.conduct.guard.v1"]);
    expect(events.map((event) => event.seq)).toEqual([7, 8]);
    expect(events.map((event) => event.data.seq)).toEqual(["0", "1"]);
    expect(events[1]?.data).toMatchObject({ type: "orynq.conduct.guard.denial.v1", reason: "SPEND_CAP_EXCEEDED" });
    const hashes = await Promise.all(events.map(computeEventHash));
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[0]).not.toBe(hashes[1]);
    let state = await initRollingHash();
    for (const hash of hashes) state = await updateRollingHash(state, hash);
    expect(state.itemCount).toBe(2);
    for (const event of events) {
      expect(await computeEventHash(JSON.parse(JSON.stringify(event)))).toBe(await computeEventHash(event));
    }
  });

  it("preserves uint64 action timestamps without converting them to a JavaScript Date", () => {
    const events: GuardEvent[] = [];
    const guard = new MandateGuard({ mandate: mandate(), counterpartyAllowlist: ["supplier"], onEvent: (e) => events.push(e) });
    guard.enforce({ ...payment, timestamp: (1n << 64n) - 2n });
    const event = toProcessTraceEvent(events[0]!, { id: "test", seq: 0, timestamp: "2026-10-27T00:00:00.000Z", visibility: "private" });
    expect(event.data.timestamp).toBe("18446744073709551614");
    expect(event.data.action).toMatchObject({ amount: "6", timestamp: "18446744073709551614" });
  });
});

describe("guard state integrity", () => {
  it("keeps the committed mandate stable when caller-owned fields are changed", () => {
    const original = mandate();
    const guard = new MandateGuard({ mandate: original, counterpartyAllowlist: ["supplier"] });
    Object.assign(original.spendCap, { amount: 100n });
    expect(guard.enforce(payment)).toEqual({ allowed: true });
    expect(guard.enforce(payment)).toMatchObject({ allowed: false, reason: "SPEND_CAP_EXCEEDED" });
  });

  it("rejects malformed actions before spending or emitting", () => {
    const events: GuardEvent[] = [];
    const guard = new MandateGuard({ mandate: mandate(), counterpartyAllowlist: ["supplier"], onEvent: (e) => events.push(e) });
    for (const amount of [-1n, 1n << 64n]) {
      expect(() => guard.enforce({ ...payment, amount })).toThrow();
      expect(() => guard.evaluate({ ...payment, amount })).toThrow();
    }
    expect(guard.spentInWindow(100n)).toBe(0n);
    expect(events).toHaveLength(0);
    guard.enforce(payment);
    expect(events[0]?.seq).toBe(0n);
  });

  it("keeps emitted action data stable after caller mutation", () => {
    const events: GuardEvent[] = [];
    const guard = new MandateGuard({ mandate: mandate(), counterpartyAllowlist: ["supplier"], onEvent: (e) => events.push(e) });
    const action = { ...payment };
    guard.enforce(action);
    Object.assign(action, { amount: 999n });
    expect(events[0]?.action).toMatchObject({ amount: 6n });
  });
});
