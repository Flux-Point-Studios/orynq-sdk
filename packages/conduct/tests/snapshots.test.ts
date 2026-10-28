import { describe, expect, it } from "vitest";
import {
  actionDigestHex, buildAllowlistRoot, compileMandatePredicate, decodeMandate, encodeMandate, MandateGuard, MemoryGuardLog,
  toProcessTraceEvent, type GuardAction, type GuardEvent, type MandateV1,
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

// An object whose `key` reads `first` once and `later` on every subsequent read.
function flipping<T extends object>(target: T, key: string, first: unknown, later: unknown): T {
  let reads = 0;
  return Object.defineProperty({ ...target }, key, { enumerable: true, get: () => (reads++ === 0 ? first : later) });
}

describe("caller-owned values are read once", () => {
  it("evaluate decides on the first read of every action field", () => {
    const guard = new MandateGuard({ mandate: mandate(), counterpartyAllowlist: ["supplier"], history: "fresh", now: () => 7200n });
    const action = flipping(pay, "counterparty", "mallory", "supplier") as GuardAction;
    expect(guard.evaluate(action)).toMatchObject({ allowed: false, reason: "COUNTERPARTY_NOT_ALLOWED" });
  });

  it("buildArgs derives membership from the first read of the counterparty", () => {
    const compiled = compileMandatePredicate(mandate(), { counterpartyAllowlist: ["supplier"] });
    const args = compiled.buildArgs(flipping(pay, "counterparty", "mallory", "supplier") as GuardAction, 0n);
    expect(args[9]).toBe(false);
  });

  it("actionDigest commits the same field values it validated", () => {
    expect(actionDigestHex(flipping(pay, "amount", 6n, 7n) as GuardAction)).toBe(actionDigestHex(pay));
  });

  it("trace conversion validates and emits one snapshot of the event action", () => {
    const log = new MemoryGuardLog();
    new MandateGuard({ mandate: mandate(), counterpartyAllowlist: ["supplier"], history: "fresh", now: () => 7200n, onEvent: e => log.append(e) }).enforce(pay);
    const event = log.history().events[0]!;
    const source = { ...event, action: flipping(event.action, "amount", 6n, 7n) } as GuardEvent;
    let data: Record<string, unknown> | undefined;
    expect(() => { data = toProcessTraceEvent(source, ctx).data; }).not.toThrow();
    expect(data?.action).toMatchObject({ amount: "6" });
    expect(data?.actionDigest).toBe(actionDigestHex(pay));
  });

  it("encodeMandate encodes the same top-level and nested field values it validated", () => {
    const top = flipping(mandate(), "principalDid", "did:key:z123456789", "did:key:zEVILEVIL1");
    expect(decodeMandate(encodeMandate(top)).principalDid).toBe("did:key:z123456789");
    const nested = { ...mandate(), spendCap: flipping(mandate().spendCap, "amount", 10n, 1n << 40n) };
    expect(decodeMandate(encodeMandate(nested)).spendCap.amount).toBe(10n);
  });

  it("the compiler binds membership to the root of the mandate it encoded", () => {
    const root = flipping(mandate(), "counterpartyAllowlistRoot", buildAllowlistRoot(["supplier"]), buildAllowlistRoot(["mallory"]));
    expect(() => compileMandatePredicate(root, { counterpartyAllowlist: ["mallory"] })).toThrow(/counterparty allowlist does not hash/);
    const window = { ...mandate(), validityWindow: flipping(mandate().validityWindow, "notBefore", 0n, 5_000n) };
    expect(compileMandatePredicate(window, { counterpartyAllowlist: ["supplier"] }).buildArgs(pay, 0n)[0]).toBe(0n);
  });

  it("buildAllowlistRoot hashes exactly the members iteration yields, as membership sets do", () => {
    const list = ["supplier"];
    Object.defineProperty(list, Symbol.iterator, { value: function* () { yield "mallory"; } });
    expect(buildAllowlistRoot(list)).toEqual(buildAllowlistRoot([...new Set(list)]));
    expect(buildAllowlistRoot(list)).toEqual(buildAllowlistRoot(["mallory"]));
    const empty: string[] = [];
    Object.defineProperty(empty, Symbol.iterator, { value: function* () { yield "mallory"; } });
    expect(buildAllowlistRoot(empty)).toEqual(buildAllowlistRoot(["mallory"]));
  });
});

describe("emitted events are immutable", () => {
  it("every sink receives a frozen event and a frozen action", () => {
    const seen: GuardEvent[] = [];
    const guard = new MandateGuard({
      mandate: mandate(), counterpartyAllowlist: ["supplier"], history: "fresh", now: () => 7200n,
      onEvent: event => {
        seen.push(event);
        expect(() => { (event as { seq: bigint }).seq = 9n; }).toThrow(TypeError);
        expect(() => { (event.action as { timestamp: bigint }).timestamp = 0n; }).toThrow(TypeError);
      },
    });
    guard.enforce(pay);
    guard.enforce({ ...pay, counterparty: "mallory" });
    expect(seen.map(e => [Object.isFrozen(e), Object.isFrozen(e.action)])).toEqual([[true, true], [true, true]]);
  });
});
