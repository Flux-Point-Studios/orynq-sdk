import { bytesToHex, cborEncode, type CborValue } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import {
  array,
  bytes,
  choice,
  jsonToCbor,
  jsonToDcbor,
  literal,
  map,
  optional,
  text,
  uint,
  type Shape,
} from "../src/dcbor.js";
import { RpcError } from "../src/errors.js";

const U64_MAX = (1n << 64n) - 1n;

function refused(value: unknown, shape: Shape, field = "params"): RpcError {
  try {
    jsonToCbor(value, shape);
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(-32602);
    expect((error as RpcError).message).toBe("Invalid params");
    expect((error as RpcError).field).toBe(field);
    return error as RpcError;
  }
  throw new Error(`accepted ${JSON.stringify(value)}`);
}

const NOT_JSON_DATA = [null, true, false, 1.5, -1, -0, "x", [], {}];

describe("JSON-to-dCBOR profile", () => {
  it("orders map keys as conduct's cborEncode does, whatever the JSON order", () => {
    const shape = map({ b: uint({ max: 9n }), a: uint({ max: 9n }), aa: uint({ max: 9n }), "é": uint({ max: 9n }) });
    const expected = cborEncode(new Map<CborValue, CborValue>([["a", 2n], ["b", 1n], ["é", 4n], ["aa", 3n]]));
    expect(bytesToHex(expected)).toBe("a4" + "616102" + "616201" + "62616103" + "62c3a904");
    for (const json of ['{"b":1,"a":2,"aa":3,"é":4}', '{"é":4,"aa":3,"b":1,"a":2}', '{"aa":3,"é":4,"a":2,"b":1}']) {
      expect(jsonToDcbor(JSON.parse(json), shape)).toEqual(expected);
    }
  });

  it("encodes a nested document byte for byte as cborEncode encodes the same data", () => {
    const shape = map({
      kind: text(32),
      hash: bytes(4),
      count: uint(),
      wait: optional(uint({ max: 30n })),
      items: array(map({ n: uint({ max: 255n }), tag: literal("t") }), 1, 4),
      v: literal(1n),
    });
    const json = { v: 1, items: [{ tag: "t", n: 7 }, { n: 255, tag: "t" }], count: "18446744073709551615", hash: "00ff10ab", kind: "x.y" };
    const expected = cborEncode(new Map<CborValue, CborValue>([
      ["v", 1n],
      ["hash", Uint8Array.from([0x00, 0xff, 0x10, 0xab])],
      ["kind", "x.y"],
      ["count", U64_MAX],
      ["items", [new Map<CborValue, CborValue>([["n", 7n], ["tag", "t"]]), new Map<CborValue, CborValue>([["n", 255n], ["tag", "t"]])]],
    ]));
    expect(jsonToDcbor(json, shape)).toEqual(expected);
    expect(jsonToDcbor(json, shape)).toEqual(cborEncode(jsonToCbor(json, shape)));
  });

  describe("uint", () => {
    it("takes a JSON integer where the bound fits 2^53", () => {
      const small = uint({ max: 30n });
      expect(jsonToCbor(0, small)).toBe(0n);
      expect(jsonToCbor(30, small)).toBe(30n);
      expect(jsonToCbor(2 ** 53, uint({ max: 1n << 53n }))).toBe(1n << 53n);
      refused(31, small);
      refused("5", small);
      for (const value of NOT_JSON_DATA) refused(value, small);
    });

    it("takes a canonical decimal string for a uint64", () => {
      const u64 = uint();
      expect(jsonToCbor("0", u64)).toBe(0n);
      expect(jsonToCbor("9007199254740993", u64)).toBe(9007199254740993n);
      expect(jsonToCbor("18446744073709551615", u64)).toBe(U64_MAX);
      for (const value of [5, 0, "18446744073709551616", "007", "00", "+1", " 1", "1 ", "1e3", "", "-1", "0x1f", "1.0", "１"]) {
        refused(value, u64);
      }
      for (const value of NOT_JSON_DATA) if (value !== "x") refused(value, u64);
    });

    it("applies the lower and upper bounds", () => {
      refused("0", uint({ min: 1n }));
      expect(jsonToCbor("1", uint({ min: 1n }))).toBe(1n);
      refused(0, uint({ min: 1n, max: 15n }));
      refused(16, uint({ min: 1n, max: 15n }));
    });
  });

  describe("text", () => {
    it("bounds UTF-8 bytes and matches the whole string", () => {
      expect(jsonToCbor("éé", text(4))).toBe("éé");
      refused("ééé", text(5));
      refused("", text(4, { minBytes: 1 }));
      const pattern = text(16, { pattern: "(oc1|ca1):[0-9a-f]{4}" });
      expect(jsonToCbor("oc1:00ff", pattern)).toBe("oc1:00ff");
      for (const value of ["xoc1:00ff", "oc1:00ff0", "oc1:00FF", "oc1:00ff\n", "ca1:"]) refused(value, pattern);
      for (const value of [null, 1, true, [], {}]) refused(value, text(8));
    });
  });

  describe("bytes", () => {
    it("takes lowercase hex of the declared size", () => {
      expect(jsonToCbor("00ff", bytes(2))).toEqual(Uint8Array.from([0, 255]));
      expect(jsonToCbor("", bytes(0, 4))).toEqual(new Uint8Array());
      for (const value of ["00FF", "0ff", "00f", "zz00", "00ff00", "0x00ff", " 00ff", null, 255, ["00", "ff"]]) refused(value, bytes(2));
      refused("00", bytes(2, 4));
      refused("0011223344", bytes(2, 4));
    });
  });

  describe("literal", () => {
    it("takes exactly its value", () => {
      expect(jsonToCbor(1, literal(1n))).toBe(1n);
      expect(jsonToCbor("2.0", literal("2.0"))).toBe("2.0");
      for (const value of [2, "1", 1.5, null]) refused(value, literal(1n));
      refused("2", literal("2.0"));
    });
  });

  describe("array", () => {
    it("bounds the length and names the failing element", () => {
      const shape = array(uint({ max: 9n }), 1, 3);
      expect(jsonToCbor([1, 2, 3], shape)).toEqual([1n, 2n, 3n]);
      refused([], shape);
      refused([1, 2, 3, 4], shape);
      refused([1, 10], shape, "params[1]");
      refused({ 0: 1 }, shape);
    });
  });

  describe("map", () => {
    const shape = map({ a: uint({ max: 9n }), b: optional(text(4)), c: map({ d: bytes(1) }) });

    it("accepts present optional members and omits absent ones", () => {
      expect(jsonToCbor({ a: 1, c: { d: "00" } }, shape))
        .toEqual(new Map<CborValue, CborValue>([["a", 1n], ["c", new Map<CborValue, CborValue>([["d", Uint8Array.of(0)]])]]));
      expect((jsonToCbor({ a: 1, b: "x", c: { d: "00" } }, shape) as Map<CborValue, CborValue>).get("b")).toBe("x");
    });

    it("refuses unknown members without naming them", () => {
      const error = refused({ a: 1, c: { d: "00" }, "secret-canary": 1 }, shape);
      expect(String(error.field)).not.toContain("secret-canary");
      refused(JSON.parse('{"a":1,"c":{"d":"00"},"__proto__":{}}'), shape);
      refused({ a: 1, c: { d: "00", e: 1 } }, shape, "params.c");
    });

    it("names a missing or wrong member by its schema path", () => {
      refused({ c: { d: "00" } }, shape, "params.a");
      refused({ a: 1 }, shape, "params.c");
      refused({ a: 1, c: { d: "0000" } }, shape, "params.c.d");
      refused({ a: 1, b: null, c: { d: "00" } }, shape, "params.b");
    });

    it("takes only plain JSON objects", () => {
      for (const value of [null, [], "x", 1, new Map([["a", 1]]), new Date(0)]) refused(value, map({}));
      expect(jsonToCbor({}, map({}))).toEqual(new Map());
    });
  });

  describe("choice", () => {
    const shape = choice(map({ cap: text(8) }), map({ ca1: uint({ max: 15n }) }));

    it("takes the one option that matches", () => {
      expect(jsonToCbor({ cap: "x" }, shape)).toEqual(new Map([["cap", "x"]]));
      expect(jsonToCbor({ ca1: 1 }, shape)).toEqual(new Map([["ca1", 1n]]));
    });

    it("refuses a value no option matches at the choice's path", () => {
      refused({ cap: "x", ca1: 1 }, shape);
      refused({}, shape);
      refused({ items: [{ ca1: 16 }] }, map({ items: array(shape, 1, 1) }), "params.items[0]");
    });

    it("fails closed on a schema whose options overlap", () => {
      expect(() => jsonToCbor("x", choice(text(4), text(8)))).toThrow(/ambiguous/);
      expect(() => jsonToCbor("x", choice(text(4), text(8)))).not.toThrow(RpcError);
    });
  });

  it("names nested failures from the caller's path", () => {
    try {
      jsonToCbor({ a: "x" }, map({ a: uint({ max: 1n }) }), "params.draft");
      throw new Error("accepted");
    } catch (error) {
      expect((error as RpcError).field).toBe("params.draft.a");
    }
  });
});
