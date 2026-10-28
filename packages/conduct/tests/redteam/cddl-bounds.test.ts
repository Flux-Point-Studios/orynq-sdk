import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeMandate, encodeMandate, MandateError, type MandateV1 } from "../../src/index.js";

const m = (committeeId: string): MandateV1 => ({
  schemaVersion: 1n, mandateId: new Uint8Array(16), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321",
  didFormatVersion: 0n, spendCap: { asset: "lovelace", amount: 1n, windowSeconds: 1n },
  counterpartyAllowlistRoot: new Uint8Array(32), egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) },
  approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: 0n, notAfter: 1n },
  disclosurePolicy: { committeeId, threshold: 1n, committeeSize: 1n },
});

describe("committee_id: CDDL says text .size (1..128) (UTF-8 bytes)", () => {
  it("the normative CDDL states the committee_id bound in UTF-8 bytes", () => {
    const line = readFileSync(new URL("../../docs/mandate-v1.cddl", import.meta.url), "utf8").split("\n").find(l => l.includes("committee_id"));
    expect(line).toMatch(/text \.size \(1\.\.128\),\s+; committee_id \(opaque\), 1-128 UTF-8 bytes$/);
  });
  it("CONTROL: 129 ASCII characters are rejected", () => {
    expect(() => encodeMandate(m("a".repeat(129)))).toThrow(MandateError);
  });
  it("F8: committee ids over 128 UTF-8 bytes reject", () => {
    for (const id of ["a".repeat(128), "é".repeat(64), "😀".repeat(32)]) {
      expect(decodeMandate(encodeMandate(m(id))).disclosurePolicy.committeeId).toBe(id);
    }
    for (const id of ["é".repeat(128), "\u{1F600}".repeat(64), "\u{10FFFF}".repeat(64), "一".repeat(128)]) {
      const bytes = new TextEncoder().encode(id).length;
      expect(bytes).toBeGreaterThan(128);
      expect(() => encodeMandate(m(id))).toThrow(MandateError);
    }
  });
});
