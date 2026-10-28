import { describe, expect, it } from "vitest";
import {
  assetTag,
  buildAllowlistRoot,
  compileMandatePredicate,
  MandateError,
  verdictOf,
  VERDICT,
  VERDICT_NAME,
  ZERO_ROOT_32,
  type MandateV1,
} from "../src/index.js";

const COUNTERPARTIES = ["addr_alpha", "addr_beta"];
const EGRESS = ["api.example.com"];

function mandate(egressMode: 0n | 1n): MandateV1 {
  return {
    schemaVersion: 1n,
    mandateId: new Uint8Array(16).fill(0x11),
    principalDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    agentDid: "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG",
    didFormatVersion: 0n,
    spendCap: { asset: "lovelace", amount: 10_000_000n, windowSeconds: 3600n },
    counterpartyAllowlistRoot: buildAllowlistRoot(COUNTERPARTIES),
    egressPolicy:
      egressMode === 1n
        ? { mode: 1n, allowlistRoot: buildAllowlistRoot(EGRESS) }
        : { mode: 0n, allowlistRoot: new Uint8Array(ZERO_ROOT_32) },
    approvedMeasurementSetRoot: new Uint8Array(32).fill(0x44),
    validityWindow: { notBefore: 1_000_000n, notAfter: 2_000_000n },
    disclosurePolicy: { committeeId: "c1", threshold: 3n, committeeSize: 5n },
  };
}

describe("verdict code bijection", () => {
  it("maps every name to its index and back", () => {
    for (const [name, code] of Object.entries(VERDICT)) {
      expect(verdictOf(name)).toBe(code);
      expect(VERDICT_NAME[code]).toBe(name);
    }
  });
  it("ALLOW is 0 and there are exactly 8 codes", () => {
    expect(VERDICT.ALLOW).toBe(0);
    expect(VERDICT_NAME).toHaveLength(8);
  });
  it("throws on an unknown verdict name", () => {
    expect(() => verdictOf("NOPE")).toThrowError(MandateError);
  });
});

describe("assetTag", () => {
  it("is deterministic and injective over distinct assets", () => {
    expect(assetTag("lovelace")).toBe(assetTag("lovelace"));
    expect(assetTag("lovelace")).not.toBe(assetTag("tdust"));
  });
  it("always fits below the BLS12-381 scalar field (< 2^248)", () => {
    for (const a of ["lovelace", "tdust", "", "0014df105553444d", "x".repeat(200)]) {
      expect(assetTag(a)).toBeLessThan(1n << 248n);
      expect(assetTag(a)).toBeGreaterThanOrEqual(0n);
    }
  });
});

describe("compileMandatePredicate — root binding", () => {
  it("rejects a malformed mandate (same validateMandate gate as the guard)", () => {
    const m = mandate(1n);
    const degenerate: MandateV1 = {
      ...m,
      validityWindow: { notBefore: 2_000_000n, notAfter: 1_000_000n },
    };
    expect(() =>
      compileMandatePredicate(degenerate, {
        counterpartyAllowlist: COUNTERPARTIES,
        egressAllowlist: EGRESS,
      }),
    ).toThrowError(MandateError);
  });
  it("throws when the counterparty list does not hash to the committed root", () => {
    expect(() =>
      compileMandatePredicate(mandate(1n), {
        counterpartyAllowlist: [...COUNTERPARTIES, "addr_extra"],
        egressAllowlist: EGRESS,
      }),
    ).toThrowError(MandateError);
  });
  it("throws on a tampered egress list", () => {
    expect(() =>
      compileMandatePredicate(mandate(1n), {
        counterpartyAllowlist: COUNTERPARTIES,
        egressAllowlist: ["exfil.example.org"],
      }),
    ).toThrowError(MandateError);
  });
  it("requires an egress list in allowlist mode, forbids one in deny-all mode", () => {
    expect(() =>
      compileMandatePredicate(mandate(1n), { counterpartyAllowlist: COUNTERPARTIES }),
    ).toThrowError(MandateError);
    expect(() =>
      compileMandatePredicate(mandate(0n), {
        counterpartyAllowlist: COUNTERPARTIES,
        egressAllowlist: EGRESS,
      }),
    ).toThrowError(MandateError);
  });
});

describe("compileMandatePredicate — buildArgs layout", () => {
  const compiled = compileMandatePredicate(mandate(1n), {
    counterpartyAllowlist: COUNTERPARTIES,
    egressAllowlist: EGRESS,
  });

  it("encodes a payment action in PREDICATE_LAYOUT order", () => {
    const args = compiled.buildArgs(
      { kind: "payment", asset: "lovelace", amount: 5_000_000n, counterparty: "addr_alpha", timestamp: 1_500_000n },
      2_000_000n,
    );
    expect(args).toEqual([
      1_000_000n, // not_before
      2_000_000n, // not_after
      assetTag("lovelace"), // cap_asset
      10_000_000n, // cap_amount
      1n, // egress_mode
      0n, // action_kind = payment
      1_500_000n, // action_timestamp
      assetTag("lovelace"), // action_asset
      5_000_000n, // action_amount
      true, // counterparty_ok
      2_000_000n, // prior_spent
      false, // egress_ok (unused for payment)
    ]);
  });

  it("marks a non-member counterparty and a mismatched asset", () => {
    const args = compiled.buildArgs(
      { kind: "payment", asset: "tdust", amount: 1n, counterparty: "addr_stranger", timestamp: 1_500_000n },
      0n,
    );
    expect(args[7]).toBe(assetTag("tdust")); // action_asset differs from cap_asset
    expect(args[7]).not.toBe(assetTag("lovelace"));
    expect(args[9]).toBe(false); // counterparty_ok
  });

  it("encodes an egress action with membership in the egress slot", () => {
    const inList = compiled.buildArgs({ kind: "egress", destination: "api.example.com", timestamp: 1_500_000n }, 0n);
    const notInList = compiled.buildArgs({ kind: "egress", destination: "evil.example.org", timestamp: 1_500_000n }, 0n);
    expect(inList[5]).toBe(1n); // action_kind = egress
    expect(inList[11]).toBe(true); // egress_ok
    expect(notInList[11]).toBe(false);
  });

  it("rejects malformed action and prior-spend inputs before producing circuit arguments", () => {
    const action = { kind: "payment", asset: "lovelace", amount: 1n, counterparty: "addr_alpha", timestamp: 1_500_000n } as const;
    for (const invalid of [-1n, 1n << 64n]) {
      expect(() => compiled.buildArgs(action, invalid)).toThrowError(MandateError);
      expect(() => compiled.buildArgs({ ...action, amount: invalid }, 0n)).toThrowError(MandateError);
      expect(() => compiled.buildArgs({ ...action, timestamp: invalid }, 0n)).toThrowError(MandateError);
    }
  });
});
