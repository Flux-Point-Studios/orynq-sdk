import { StrictJsonError, type StrictJsonErrorCode } from "@fluxpointstudios/orynq-sdk-core/utils";
import { describe, expect, it } from "vitest";
import { RpcError } from "../src/errors.js";
import { parseJsonPayload } from "../src/strict-json.js";

const utf8 = (text: string) => new TextEncoder().encode(text);

function refusal(payload: Uint8Array): RpcError {
  try {
    parseJsonPayload(payload);
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    return error as RpcError;
  }
  throw new Error("payload accepted");
}

describe("parseJsonPayload", () => {
  it("decodes a UTF-8 JSON payload", () => {
    expect(parseJsonPayload(utf8('{"jsonrpc":"2.0","id":1,"method":"broker.hello","params":{"é":"\u{1F600}"}}')))
      .toEqual({ jsonrpc: "2.0", id: 1, method: "broker.hello", params: { "é": "\u{1F600}" } });
  });

  it("answers bytes that are not UTF-8 with -32700", () => {
    for (const bytes of [[0xff], [0x22, 0xc0, 0x80, 0x22], [0x22, 0xed, 0xa0, 0x80, 0x22], [0x22, 0xe2, 0x82]]) {
      const error = refusal(Uint8Array.from(bytes));
      expect(error.code).toBe(-32700);
      expect(error.message).toBe("Parse error");
    }
  });

  it("refuses a byte-order mark instead of stripping it", () => {
    expect(refusal(Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])).code).toBe(-32700);
  });

  it.each<[string, StrictJsonErrorCode]>([
    ['{"id":1,"id":2}', "JSON_DUPLICATE_KEY"],
    ['{"a":1,"\\u0061":2}', "JSON_DUPLICATE_KEY"],
    ['{"params":"\\ud800"}', "JSON_LONE_SURROGATE"],
    ["[".repeat(33) + "0" + "]".repeat(33), "JSON_DEPTH"],
    ['{"n":9007199254740993}', "JSON_NUMBER"],
    ['{"n":-9007199254740993}', "JSON_NUMBER"],
    ['{"n":1.0}', "JSON_NUMBER"],
    ["{", "JSON_SYNTAX"],
    ["", "JSON_SYNTAX"],
  ])("maps every strict JSON refusal of %s to -32700 (%s)", (text, code) => {
    const error = refusal(utf8(text));
    expect(error.code).toBe(-32700);
    expect(error.message).toBe("Parse error");
    expect(error.field).toBeUndefined();
    expect(error.cause).toBeInstanceOf(StrictJsonError);
    expect((error.cause as StrictJsonError).code).toBe(code);
  });

  it("refuses the largest nesting frame without building it", () => {
    const half = 8 * 1024 * 1024;
    const payload = utf8("[".repeat(half) + "]".repeat(half));
    const rss = process.memoryUsage().rss;
    const start = performance.now();
    const error = refusal(payload);
    const elapsed = performance.now() - start;
    expect((error.cause as StrictJsonError).code).toBe("JSON_DEPTH");
    expect(process.memoryUsage().rss - rss).toBeLessThan(64 * 1024 * 1024);
    expect(elapsed).toBeLessThan(400);
  });

  it("keeps the input out of the error message", () => {
    const error = refusal(utf8('{"token":"secret-canary-value","token":1}'));
    expect(error.message).not.toContain("secret-canary-value");
    expect(String(error)).not.toContain("secret-canary-value");
  });
});

describe("RpcError", () => {
  it("takes its code and message from the fixed table", () => {
    expect(new RpcError("PARSE_ERROR")).toMatchObject({ code: -32700, message: "Parse error", name: "RpcError" });
    expect(new RpcError("INVALID_REQUEST")).toMatchObject({ code: -32600, message: "Invalid Request" });
    expect(new RpcError("INVALID_PARAMS", { field: "params.mandates[0]" }))
      .toMatchObject({ code: -32602, message: "Invalid params", field: "params.mandates[0]" });
  });
});
