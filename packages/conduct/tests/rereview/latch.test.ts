// Right-reason latch tests: a transient sink failure must permanently refuse further enforcement.
import { expect, it } from "vitest";
import { buildAllowlistRoot, MandateGuard, type GuardConfig, type MandateV1 } from "../../src/index.js";

const mandate = (): MandateV1 => ({
  schemaVersion: 1n, mandateId: new Uint8Array(16), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321",
  didFormatVersion: 0n, spendCap: { asset: "lovelace", amount: 10n, windowSeconds: 3600n },
  counterpartyAllowlistRoot: buildAllowlistRoot(["supplier"]), egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) },
  approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: 0n, notAfter: 100_000n },
  disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n },
});
const pay = { kind: "payment", asset: "lovelace", amount: 1n, counterparty: "supplier", timestamp: 7200n } as const;
const cfg = (onEvent: () => unknown): GuardConfig => ({ mandate: mandate(), counterpartyAllowlist: ["supplier"], now: () => 7200n, history: "fresh", onEvent: onEvent as never });

it("LATCH sync: after one transient sink throw, a now-healthy sink still cannot authorize", () => {
  let fail = true;
  const g = new MandateGuard(cfg(() => { if (fail) { fail = false; throw new Error("transient"); } }));
  expect(() => g.enforce(pay)).toThrow("transient");
  expect(() => g.enforce(pay)).toThrow(/event sink failed; restore a new guard/);
});
it("LATCH async: after one transient async rejection, a now-healthy sink still cannot authorize", async () => {
  let fail = true;
  const g = new MandateGuard(cfg(async () => { if (fail) { fail = false; throw new Error("transient"); } }));
  await expect(g.enforceAsync(pay)).rejects.toThrow("transient");
  await expect(g.enforceAsync(pay)).rejects.toThrow(/event sink failed; restore a new guard/);
});
it("LATCH sync-promise: a resolved promise returned to sync enforce latches, even though it resolved", async () => {
  let calls = 0;
  const g = new MandateGuard(cfg(() => (++calls === 1 ? Promise.resolve() : undefined)));
  expect(() => g.enforce(pay)).toThrow(/requires enforceAsync/);
  await new Promise(r => setImmediate(r));
  expect(() => g.enforce(pay)).toThrow(/event sink failed; restore a new guard/);
});
