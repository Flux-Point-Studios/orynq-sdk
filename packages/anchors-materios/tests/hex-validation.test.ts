/**
 * Hex-validation tests for the anchors-materios SDK boundary.
 *
 * `submitReceipt` and `submitCertifiedReceipt` flow through
 * `assertHex32` for every 32-byte hash field. The goal: surface
 * malformed input as a thrown Error at the SDK boundary, BEFORE we
 * silently produce a different on-chain value than the caller intended
 * (toBytes32 pads/truncates without complaint).
 *
 * Followup tests from PR #38's security review.
 */
import { describe, it, expect } from "vitest";
import { assertHex32, stripPrefix, ensureHex } from "../src/hex.js";

describe("assertHex32", () => {
  const valid = "00".repeat(32); // 64 hex chars

  it("accepts 64-char hex without prefix", () => {
    expect(assertHex32(valid, "field")).toBe(valid);
  });

  it("accepts 0x-prefixed 64-char hex", () => {
    expect(assertHex32("0x" + valid, "field")).toBe(valid);
  });

  it("accepts mixed-case and lower-cases", () => {
    const mixed = "aB".repeat(32);
    expect(assertHex32(mixed, "field")).toBe("ab".repeat(32));
  });

  it("rejects short hex with a field-named error", () => {
    expect(() => assertHex32("00", "contentHash")).toThrow(/contentHash/);
    expect(() => assertHex32("00", "contentHash")).toThrow(/64 chars/);
  });

  it("rejects over-length hex (would silently truncate without guard)", () => {
    expect(() => assertHex32(valid + "ff", "rootHash")).toThrow(/rootHash/);
  });

  it("rejects non-hex characters (would silently produce NaN bytes)", () => {
    const withSpace = valid.slice(0, 62) + " z";
    expect(() => assertHex32(withSpace, "schemaHash")).toThrow(/schemaHash/);
  });

  it("rejects non-string input", () => {
    // @ts-expect-error: testing runtime contract
    expect(() => assertHex32(null, "manifestHash")).toThrow(/manifestHash/);
    // @ts-expect-error: testing runtime contract
    expect(() => assertHex32(undefined, "manifestHash")).toThrow(/manifestHash/);
    // @ts-expect-error: testing runtime contract
    expect(() => assertHex32(123, "manifestHash")).toThrow(/manifestHash/);
  });

  it("handles all-zero hash (legacy schema_hash sentinel)", () => {
    expect(assertHex32("0".repeat(64), "schemaHash")).toBe("0".repeat(64));
  });
});

describe("stripPrefix / ensureHex round trip", () => {
  it("preserves leading zeros across stripPrefix → ensureHex", () => {
    // Regression guard for the bug noted in hex.ts header (commit 4b4f3be).
    const h =
      "0x0000000000000000000000000000000000000000000000000000000000000001";
    expect(ensureHex(stripPrefix(h))).toBe(h);
  });
});
