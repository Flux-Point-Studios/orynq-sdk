import { describe, expect, it } from "vitest";
import {
  parseStrictJson,
  STRICT_JSON_MAX_DEPTH,
  StrictJsonError,
  type StrictJsonErrorCode,
} from "../utils/strict-json.js";
import * as utils from "../utils/index.js";
import * as root from "../index.js";

const LIMIT = 1024 * 1024;

function refusal(text: string, maxBytes = LIMIT): StrictJsonError {
  try {
    parseStrictJson(text, maxBytes);
  } catch (error) {
    expect(error).toBeInstanceOf(StrictJsonError);
    return error as StrictJsonError;
  }
  throw new Error(`accepted ${JSON.stringify(text)}`);
}

const code = (text: string, maxBytes = LIMIT): StrictJsonErrorCode => refusal(text, maxBytes).code;

describe("parseStrictJson", () => {
  it("returns what JSON.parse returns for an unambiguous document", () => {
    const text = '{"a":[1,-2,"x",{"b":null,"c":true}],"d":{"e":0.5},"f":"\\u00e9\\ud83d\\ude00"}';
    expect(parseStrictJson(text, LIMIT)).toEqual(JSON.parse(text));
  });

  it("is exported from the utils entry and the package root", () => {
    expect(utils.parseStrictJson).toBe(parseStrictJson);
    expect(root.parseStrictJson).toBe(parseStrictJson);
    expect(utils.StrictJsonError).toBe(StrictJsonError);
    expect(root.STRICT_JSON_MAX_DEPTH).toBe(32);
  });

  it("bounds the text in UTF-8 bytes, not UTF-16 units", () => {
    expect(parseStrictJson('"éé"', 6)).toBe("éé");
    expect(code('"éé"', 5)).toBe("JSON_TOO_LARGE");
    expect(code(" ".repeat(11) + "1", 11)).toBe("JSON_TOO_LARGE");
  });

  it("refuses text that is not JSON", () => {
    for (const text of ["", "{", "[1,]", "01", "'a'", "﻿{}", "{} {}", "NaN", "undefined"]) {
      expect(code(text)).toBe("JSON_SYNTAX");
    }
  });

  it("refuses duplicate decoded keys, escaped spellings included, at any depth", () => {
    for (const text of [
      '{"a":1,"a":2}',
      '{"a":1,"\\u0061":2}',
      '{"x":[{"k":"v","k":"w"}]}',
      '{"__proto__":1,"__proto__":2}',
    ]) {
      expect(code(text)).toBe("JSON_DUPLICATE_KEY");
    }
    expect(parseStrictJson('{"a":{"a":1},"b":{"a":2}}', LIMIT)).toEqual({ a: { a: 1 }, b: { a: 2 } });
  });

  it("refuses lone surrogates in keys and values, escaped or raw", () => {
    for (const text of ['"\\ud800"', '"x\\udc00"', '{"\\ud83d":1}', '["\\ude00\\ud83d"]', '"\ud800"', '{"k\udfff":0}']) {
      expect(code(text)).toBe("JSON_LONE_SURROGATE");
    }
    expect(parseStrictJson('["\\ud83d\\ude00","\u{1F600}"]', LIMIT)).toEqual(["\u{1F600}", "\u{1F600}"]);
  });

  it(`accepts values nested ${STRICT_JSON_MAX_DEPTH} containers deep and refuses one more`, () => {
    const arrays = (n: number) => "[".repeat(n) + "0" + "]".repeat(n);
    const objects = (n: number) => '{"a":'.repeat(n) + "0" + "}".repeat(n);
    expect(STRICT_JSON_MAX_DEPTH).toBe(32);
    expect(() => parseStrictJson(arrays(32), LIMIT)).not.toThrow();
    expect(() => parseStrictJson(objects(32), LIMIT)).not.toThrow();
    expect(() => parseStrictJson("[".repeat(33) + "]".repeat(33), LIMIT)).not.toThrow();
    expect(code(arrays(33))).toBe("JSON_DEPTH");
    expect(code(objects(33))).toBe("JSON_DEPTH");
    expect(code("[".repeat(34) + "]".repeat(34))).toBe("JSON_DEPTH");
    expect(code("[".repeat(100_000) + "]".repeat(100_000), 1_000_000)).toBe("JSON_DEPTH");
  });

  it("accepts integers up to ±2^53 exactly and refuses any beyond", () => {
    expect(parseStrictJson("[9007199254740992,-9007199254740992,9007199254740991,0]", LIMIT))
      .toEqual([2 ** 53, -(2 ** 53), 2 ** 53 - 1, 0]);
    for (const text of ["9007199254740993", "-9007199254740993", "18446744073709551615", "1" + "0".repeat(400), "[1e400]", '{"n":-1e400}']) {
      expect(code(text)).toBe("JSON_NUMBER");
    }
  });

  it("gives every integer one spelling and passes other numbers through", () => {
    for (const text of ["1.0", "1e3", "1E3", "1e+3", "100e-2", "-0", "0.0", "-0.0", "1e-400", "9007199254740993.0", "[2.000]"]) {
      expect(code(text)).toBe("JSON_NUMBER");
    }
    expect(parseStrictJson("[1.5,-2.25,1e-3,1.25E1]", LIMIT)).toEqual([1.5, -2.25, 0.001, 12.5]);
  });

  it("answers from a fixed message table that never quotes the input", () => {
    const secret = "private-seed-should-not-appear";
    for (const text of [secret, `{"${secret}":1,"${secret}":2}`, `"${secret}\\ud800"`, `[${"9".repeat(30)}]`]) {
      const error = refusal(text);
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain("999");
      expect(error.name).toBe("StrictJsonError");
    }
    expect(refusal("{").message).toBe("Document is not valid JSON");
    expect(refusal('{"a":1,"a":1}').message).toBe("JSON contains a duplicate object key");
    expect(refusal("[".repeat(40) + "]".repeat(40)).message).toBe("JSON exceeds the nesting limit");
  });
});
