import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../src/bytes.js";
import { cborDecode, cborEncode, type CborValue } from "../src/cbor.js";
import { MandateError } from "../src/errors.js";

const hex = (v: CborValue): string => bytesToHex(cborEncode(v));

function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(MandateError);
  expect((thrown as MandateError).code).toBe(code);
}

describe("canonical CBOR encoder", () => {
  it("preserves a leading Unicode BOM as text data", () => {
    const text = "\ufeffconduct";
    const bytes = cborEncode(text);
    expect(cborDecode(bytes)).toBe(text);
    expect(cborEncode(cborDecode(bytes))).toEqual(bytes);
  });

  it("encodes uints minimally at every width boundary", () => {
    expect(hex(0n)).toBe("00");
    expect(hex(23n)).toBe("17");
    expect(hex(24n)).toBe("1818");
    expect(hex(255n)).toBe("18ff");
    expect(hex(256n)).toBe("190100");
    expect(hex(65535n)).toBe("19ffff");
    expect(hex(65536n)).toBe("1a00010000");
    expect(hex(4294967295n)).toBe("1affffffff");
    expect(hex(4294967296n)).toBe("1b0000000100000000");
    expect(hex((1n << 64n) - 1n)).toBe("1bffffffffffffffff");
  });

  it("rejects integers outside uint64", () => {
    expectCode(() => cborEncode(-1n), "CBOR_RANGE");
    expectCode(() => cborEncode(1n << 64n), "CBOR_RANGE");
  });

  it("sorts map keys bytewise regardless of insertion order", () => {
    const outOfOrder = new Map<CborValue, CborValue>([
      [10n, 0n],
      [2n, 0n],
      ["a", 0n],
      [new Uint8Array([1]), 0n],
    ]);
    // 02 < 0a < 41 01 (bstr) < 61 61 (tstr) in bytewise encoded order.
    expect(hex(outOfOrder)).toBe("a402000a00410100616100");
  });

  it("rejects duplicate map keys even when values differ", () => {
    const dup = new Map<CborValue, CborValue>();
    dup.set(new Uint8Array([7]), 1n);
    dup.set(new Uint8Array([7]), 2n);
    // Map dedupes identical primitives but distinct Uint8Arrays survive.
    expect(dup.size).toBe(2);
    expectCode(() => cborEncode(dup), "CBOR_DUPLICATE_KEY");
  });

  it("rejects lone surrogates in text", () => {
    expectCode(() => cborEncode("\ud800"), "CBOR_UTF8");
  });

  it("encodes booleans, byte strings, text, arrays", () => {
    expect(hex(true)).toBe("f5");
    expect(hex(false)).toBe("f4");
    expect(hex(new Uint8Array([1, 2, 3]))).toBe("43010203");
    expect(hex("héllo")).toBe("6668c3a96c6c6f");
    expect(hex([1n, "a"])).toBe("82016161");
  });
});

describe("strict CBOR decoder", () => {
  const roundtrip = (v: CborValue): CborValue => cborDecode(cborEncode(v));

  it("roundtrips the value domain", () => {
    expect(roundtrip(0n)).toBe(0n);
    expect(roundtrip((1n << 64n) - 1n)).toBe((1n << 64n) - 1n);
    expect(roundtrip("orynq")).toBe("orynq");
    expect(roundtrip(true)).toBe(true);
    expect(roundtrip(new Uint8Array([9, 8]))).toEqual(new Uint8Array([9, 8]));
    expect(roundtrip([1n, [2n]])).toEqual([1n, [2n]]);
  });

  it("rejects each non-minimal integer width", () => {
    expectCode(() => cborDecode(hexToBytes("1817")), "CBOR_NONMINIMAL"); // 23 as 1-byte arg
    expectCode(() => cborDecode(hexToBytes("1900ff")), "CBOR_NONMINIMAL"); // 255 as 2-byte
    expectCode(() => cborDecode(hexToBytes("1a0000ffff")), "CBOR_NONMINIMAL"); // 65535 as 4-byte
    expectCode(
      () => cborDecode(hexToBytes("1b00000000ffffffff")),
      "CBOR_NONMINIMAL",
    ); // 2^32-1 as 8-byte
  });

  it("rejects non-minimal LENGTH arguments too", () => {
    // "a" as tstr with 1-byte length argument instead of immediate.
    expectCode(() => cborDecode(hexToBytes("780161")), "CBOR_NONMINIMAL");
  });

  it("rejects indefinite lengths, tags, negatives, floats, null", () => {
    expectCode(() => cborDecode(hexToBytes("9fff")), "CBOR_INDEFINITE");
    expectCode(() => cborDecode(hexToBytes("5fff")), "CBOR_INDEFINITE");
    expectCode(() => cborDecode(hexToBytes("c100")), "CBOR_FORBIDDEN");
    expectCode(() => cborDecode(hexToBytes("20")), "CBOR_FORBIDDEN");
    expectCode(() => cborDecode(hexToBytes("f93c00")), "CBOR_FORBIDDEN");
    expectCode(() => cborDecode(hexToBytes("fb3ff0000000000000")), "CBOR_FORBIDDEN");
    expectCode(() => cborDecode(hexToBytes("f6")), "CBOR_FORBIDDEN");
    expectCode(() => cborDecode(hexToBytes("f7")), "CBOR_FORBIDDEN");
  });

  it("rejects unsorted and duplicate map keys", () => {
    expectCode(() => cborDecode(hexToBytes("a201000000")), "CBOR_KEY_ORDER");
    expectCode(() => cborDecode(hexToBytes("a200000001")), "CBOR_KEY_ORDER");
  });

  it("rejects truncation, trailing bytes, invalid UTF-8, reserved heads", () => {
    expectCode(() => cborDecode(hexToBytes("42ff")), "CBOR_TRUNCATED");
    expectCode(() => cborDecode(hexToBytes("0000")), "CBOR_TRAILING");
    expectCode(() => cborDecode(hexToBytes("61ff")), "CBOR_UTF8");
    expectCode(() => cborDecode(hexToBytes("1c")), "CBOR_MALFORMED");
    expectCode(() => cborDecode(hexToBytes("5b7fffffffffffffff00")), "CBOR_TRUNCATED");
  });

  it("rejects nesting beyond the depth limit", () => {
    let deep: CborValue = 0n;
    for (let i = 0; i < 40; i++) deep = [deep];
    expectCode(() => cborEncode(deep), "CBOR_DEPTH");
    // 40 nested arrays of one element, then a zero.
    const bytes = hexToBytes("81".repeat(40) + "00");
    expectCode(() => cborDecode(bytes), "CBOR_DEPTH");
  });
});
