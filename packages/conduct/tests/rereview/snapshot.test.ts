// Discriminating snapshot tests: benign on the first pass, hostile on any later pass.
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildAllowlistRoot, compileMandatePredicate, decodeMandate, encodeMandate, mandateCommitmentHex, MandateGuard, MemoryGuardLog, type MandateV1 } from "../../src/index.js";

const base = (egress: string[] | null = null): MandateV1 => ({
  schemaVersion: 1n, mandateId: new Uint8Array(16), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321",
  didFormatVersion: 0n, spendCap: { asset: "lovelace", amount: 10n, windowSeconds: 3600n },
  counterpartyAllowlistRoot: buildAllowlistRoot(["supplier"]),
  egressPolicy: egress ? { mode: 1n, allowlistRoot: buildAllowlistRoot(egress) } : { mode: 0n, allowlistRoot: new Uint8Array(32) },
  approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: 0n, notAfter: 100_000n },
  disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n },
});
function stateful(first: string, extra: string): string[] {
  let passes = 0;
  const list = [first];
  Object.defineProperty(list, Symbol.iterator, { value: function* () { passes++; yield first; if (passes > 1) yield extra; } });
  return list;
}
const pay = { kind: "payment", asset: "lovelace", amount: 1n, counterparty: "mallory", timestamp: 7200n } as const;

it("SNAPSHOT guard counterparties: second-pass member cannot become allowed", () => {
  const log = new MemoryGuardLog();
  const g = new MandateGuard({ mandate: base(), counterpartyAllowlist: stateful("supplier", "mallory"), history: "fresh", now: () => 7200n, onEvent: (e, previous) => log.append(e, previous) });
  expect(g.enforce(pay)).toMatchObject({ allowed: false, reason: "COUNTERPARTY_NOT_ALLOWED" });
});
it("SNAPSHOT guard egress: second-pass destination cannot become allowed", () => {
  const g = new MandateGuard({ mandate: base(["api.example.com"]), counterpartyAllowlist: ["supplier"], egressAllowlist: stateful("api.example.com", "evil.example"), history: "fresh", now: () => 7200n });
  expect(g.enforce({ kind: "egress", destination: "evil.example", timestamp: 7200n })).toMatchObject({ allowed: false, reason: "EGRESS_NOT_ALLOWED" });
});
it("SNAPSHOT compiler: second-pass member cannot set counterparty_ok", () => {
  const c = compileMandatePredicate(base(), { counterpartyAllowlist: stateful("supplier", "mallory") });
  expect(c.buildArgs(pay, 0n)[9]).toBe(false);
});
it("SNAPSHOT bytes: commitment and decode use the iterator copy, never later index reads", () => {
  const wire = encodeMandate(base());
  const evil = Uint8Array.from(wire); evil[2] = 0x02;
  const p = new Proxy(wire, { get(t, k) {
    if (typeof k === "string" && /^\d+$/.test(k)) return evil[Number(k)];
    const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
  } }) as Uint8Array;
  const evilHash = createHash("sha256").update(Buffer.concat([Buffer.from("orynq:conduct:mandate:v1|"), evil])).digest("hex");
  expect(mandateCommitmentHex(p)).toBe(mandateCommitmentHex(wire));
  expect(mandateCommitmentHex(p)).not.toBe(evilHash);
  expect(() => decodeMandate(p)).not.toThrow();
  expect(decodeMandate(p).schemaVersion).toBe(1n);
});
