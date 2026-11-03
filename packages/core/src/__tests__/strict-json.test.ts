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

function refusal(text: string, maxBytes = LIMIT, maxValues?: number): StrictJsonError {
  try {
    parseStrictJson(text, maxBytes, maxValues);
  } catch (error) {
    expect(error).toBeInstanceOf(StrictJsonError);
    return error as StrictJsonError;
  }
  throw new Error(`accepted ${JSON.stringify(text.slice(0, 80))}`);
}

const code = (text: string, maxBytes = LIMIT, maxValues?: number): StrictJsonErrorCode => refusal(text, maxBytes, maxValues).code;

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

  it(`accepts a value enclosed by ${STRICT_JSON_MAX_DEPTH} containers and refuses one enclosed by more`, () => {
    const arrays = (n: number) => "[".repeat(n) + "0" + "]".repeat(n);
    const objects = (n: number) => '{"a":'.repeat(n) + "0" + "}".repeat(n);
    expect(STRICT_JSON_MAX_DEPTH).toBe(32);
    expect(() => parseStrictJson(arrays(32), LIMIT)).not.toThrow();
    expect(() => parseStrictJson(objects(32), LIMIT)).not.toThrow();
    // The innermost empty array is itself the value at level 32.
    expect(() => parseStrictJson("[".repeat(33) + "]".repeat(33), LIMIT)).not.toThrow();
    expect(code(arrays(33))).toBe("JSON_DEPTH");
    expect(code(objects(33))).toBe("JSON_DEPTH");
    expect(code("[".repeat(34) + "]".repeat(34))).toBe("JSON_DEPTH");
    expect(code("[".repeat(100_000) + "]".repeat(100_000), 1_000_000)).toBe("JSON_DEPTH");
  });

  it("judges nesting before syntax, so a deep text is refused without being parsed", () => {
    expect(code("[".repeat(40))).toBe("JSON_DEPTH");
    expect(code("{".repeat(40))).toBe("JSON_DEPTH");
    expect(code("[".repeat(20))).toBe("JSON_SYNTAX");
  });

  it("counts only brackets outside strings, whatever the strings escape", () => {
    const brackets = ["[".repeat(40), "{".repeat(40), '\\"' + "[".repeat(40), "\\\\", "\\u005b".repeat(40)];
    const shallow = `[${brackets.map(s => `"${s}"`).join(",")}]`;
    expect(parseStrictJson(shallow, LIMIT)).toEqual(JSON.parse(shallow));
    // An escaped backslash ends the string, so the brackets after it count.
    expect(code('["\\\\",' + "[".repeat(32) + "0" + "]".repeat(33))).toBe("JSON_DEPTH");
    expect(() => parseStrictJson('["\\\\",' + "[".repeat(31) + "0" + "]".repeat(32), LIMIT)).not.toThrow();
    expect(code('{"\\"":' + "[".repeat(32) + "0" + "]".repeat(32) + "}")).toBe("JSON_DEPTH");
  });

  it("refuses a 16 MiB nesting frame without building it", () => {
    const half = 8 * 1024 * 1024;
    const text = "[".repeat(half) + "]".repeat(half);
    const rss = process.memoryUsage().rss;
    const start = performance.now();
    expect(code(text, 2 * half)).toBe("JSON_DEPTH");
    const elapsed = performance.now() - start;
    expect(process.memoryUsage().rss - rss).toBeLessThan(64 * 1024 * 1024);
    expect(elapsed).toBeLessThan(400);
  });

  it("counts each container, scalar and member value, but not keys, against maxValues", () => {
    for (const [text, values] of [
      ["0", 1],
      ['"x"', 1],
      ["{}", 1],
      ["[0,0]", 3],
      ["[true,false,null]", 4],
      ['{"a":0,"b":[]}', 3],
      ['{"a:b":"c:d,[{"}', 2],
      ['[ -1.25e-3 , 2.5E-1 ,"\\"" ]', 4],
      ["[[[]],{}]", 4],
    ] as const) {
      expect(parseStrictJson(text, LIMIT, values)).toEqual(JSON.parse(text));
      expect(code(text, LIMIT, values - 1)).toBe("JSON_VALUES");
    }
    expect(refusal("[0,0]", LIMIT, 2).message).toBe("JSON exceeds its value limit");
  });

  it("leaves values unbounded unless the caller bounds them", () => {
    const wide = `[${Array(200_000).fill("0").join(",")}]`;
    expect(parseStrictJson(wide, LIMIT)).toHaveLength(200_000);
    expect(parseStrictJson(wide, LIMIT, 200_001)).toHaveLength(200_000);
    expect(code(wide, LIMIT, 200_000)).toBe("JSON_VALUES");
  });

  it.each([Number.NaN, -1, 1.5, Number.NEGATIVE_INFINITY, "16", 16n, null])(
    "refuses a limit of %s, which would otherwise bound nothing",
    limit => {
      const bad = limit as unknown as number;
      expect(() => parseStrictJson("0", bad)).toThrow(new TypeError("maxBytes must be a non-negative integer or Infinity"));
      expect(() => parseStrictJson("0", LIMIT, bad)).toThrow(new TypeError("maxValues must be a non-negative integer or Infinity"));
    },
  );

  it("takes 0 and Infinity as limits", () => {
    expect(code("0", 0)).toBe("JSON_TOO_LARGE");
    expect(code("0", LIMIT, 0)).toBe("JSON_VALUES");
    expect(parseStrictJson("[0]", Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toEqual([0]);
  });

  it("judges values before syntax, so a wide text is refused without being parsed", () => {
    expect(code("[" + "0,".repeat(10), LIMIT, 5)).toBe("JSON_VALUES");
    expect(code("[" + "0,".repeat(3), LIMIT, 5)).toBe("JSON_SYNTAX");
  });

  // The shapes that cost JSON.parse the most per byte: at 16 MiB, about a second and hundreds of
  // MiB each.
  const FRAME = 16 * 1024 * 1024;
  const wide = (unit: string) => `[${Array(Math.floor((FRAME - 1) / (unit.length + 1))).fill(unit).join(",")}]`;
  const members = () => {
    const parts: string[] = [];
    for (let i = 0, size = 2; size + 16 < FRAME; i++) {
      parts.push(`"k${i}":0`);
      size += parts[i]!.length + 1;
    }
    return `{${parts.join(",")}}`;
  };
  it.each([
    ["empty objects", () => wide("{}")],
    ["empty arrays", () => wide("[]")],
    ["32-deep arrays", () => wide("[".repeat(31) + "0" + "]".repeat(31))],
    ["zeros", () => wide("0")],
    ["fractions", () => wide("1.5")],
    ["escaped strings", () => wide('"\\u0061"')],
    ["object members", members],
  ])("refuses a 16 MiB text of %s without building it", (_, make) => {
    const text = make();
    expect(text.length).toBeGreaterThan(FRAME - 64);
    expect(text.length).toBeLessThanOrEqual(FRAME);
    const rss = process.memoryUsage().rss;
    const start = performance.now();
    expect(code(text, FRAME, 65_536)).toBe("JSON_VALUES");
    const elapsed = performance.now() - start;
    expect(process.memoryUsage().rss - rss).toBeLessThan(64 * 1024 * 1024);
    expect(elapsed).toBeLessThan(400);
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
