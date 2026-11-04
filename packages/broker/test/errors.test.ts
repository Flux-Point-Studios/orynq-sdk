import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RPC_ERRORS, RpcError, type RpcErrorName } from "../src/errors.js";

const spec = readFileSync(new URL("../../../docs/architecture/credential-broker.md", import.meta.url), "utf8");

// §6.3 lists the v1 codes -32001…-32010 by name, in code order, and the new ones with their codes.
function specTable(): Record<string, number> {
  const paragraph = spec.split("\n").find(line => line.startsWith("Messages come from a fixed table"));
  expect(paragraph).toBeDefined();
  const v1 = /v1 codes -32001…-32010 are unchanged \((.*?)\); unknown/.exec(paragraph!);
  expect(v1).not.toBeNull();
  const names = [...v1![1]!.matchAll(/`([^`]+)`/g)].map(match => match[1]!).filter(name => /^[A-Z*][A-Z_/*]*$/.test(name));
  expect(names).toHaveLength(10);
  const table: Record<string, number> = { PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602 };
  const listed = new Set(names);
  names.forEach((name, i) => {
    const code = -32001 - i;
    if (name === "*_UNAVAILABLE") {
      // The family: every other *_UNAVAILABLE the spec names, such as §11's JOURNAL_UNAVAILABLE.
      for (const [member] of spec.matchAll(/\b[A-Z]+_UNAVAILABLE\b/g)) if (!listed.has(member)) table[member] = code;
    } else if (name.includes("/")) {
      const [first, second] = name.split("/");
      table[first!] = code;
      table[`${first!.slice(0, first!.lastIndexOf("_") + 1)}${second!}`] = code;
    } else table[name] = code;
  });
  for (const [, code, name] of paragraph!.matchAll(/(-320\d\d) `([A-Z_]+)`/g)) table[name!] = Number(code);
  return table;
}

describe("the error table", () => {
  it("holds every code and name §6.3 lists, and nothing else", () => {
    const table = specTable();
    expect(table).toMatchObject({ PEER_UNKNOWN: -32001, APPROVAL_EXPIRED: -32005, JOURNAL_UNAVAILABLE: -32007, VERIFY_REFUSED: -32012 });
    expect(Object.fromEntries(Object.entries(RPC_ERRORS).map(([name, { code }]) => [name, code]))).toEqual(table);
  });

  it("answers each name with its code and a fixed message that is unique to it", () => {
    const messages = new Set<string>();
    for (const [name, { code, message }] of Object.entries(RPC_ERRORS)) {
      const error = new RpcError(name as RpcErrorName);
      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
      expect(error.reason).toBe(name);
      messages.add(message);
    }
    expect(messages.size).toBe(Object.keys(RPC_ERRORS).length);
    expect(new RpcError("PEER_UNKNOWN").message).toBe("Peer unknown");
    expect(new RpcError("MANDATE_REFUSED", { field: "params.mandates[0]" }).field).toBe("params.mandates[0]");
  });
});
