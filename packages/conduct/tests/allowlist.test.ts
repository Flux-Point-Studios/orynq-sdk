import { describe, expect, it } from "vitest";
import {
  allowlistLeaf,
  buildAllowlistRoot,
  bytesToHex,
  equalBytes,
  MandateError,
  ZERO_ROOT_32,
} from "../src/index.js";

describe("v1 allowlist root", () => {
  it("is order-independent and deduplicating (a set commitment)", () => {
    const a = buildAllowlistRoot(["alpha", "beta", "gamma"]);
    const b = buildAllowlistRoot(["gamma", "alpha", "beta", "alpha"]);
    expect(equalBytes(a, b)).toBe(true);
  });

  it("changes when membership changes", () => {
    const a = buildAllowlistRoot(["alpha", "beta"]);
    const b = buildAllowlistRoot(["alpha", "beta", "gamma"]);
    expect(equalBytes(a, b)).toBe(false);
  });

  it("empty list commits to the zero root (deny-all pairing)", () => {
    expect(equalBytes(buildAllowlistRoot([]), ZERO_ROOT_32)).toBe(true);
  });

  it("single member root is its leaf", () => {
    expect(equalBytes(buildAllowlistRoot(["only"]), allowlistLeaf("only"))).toBe(true);
  });

  it("pins a known-answer root for cross-platform stability", () => {
    expect(bytesToHex(buildAllowlistRoot(["alpha", "beta", "gamma"]))).toBe(
      "9bd81593fd22c3d0b409e875293fa84b6c43b0180b2d233d5986ad2b20b7fe51",
    );
  });

  it("rejects empty and malformed members", () => {
    expect(() => allowlistLeaf("")).toThrowError(MandateError);
    expect(() => allowlistLeaf("\ud800")).toThrowError(MandateError);
  });
});
