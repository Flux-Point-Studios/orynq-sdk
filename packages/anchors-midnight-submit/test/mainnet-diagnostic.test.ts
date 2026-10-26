import { describe, expect, it } from "vitest";
import { terminalDiagnostic } from "../scripts/mainnet-session.js";

describe("mainnet provider diagnostics", () => {
  it("escapes a full fake confirmation block and control characters to one physical line", () => {
    const hostile = "provider failure\nnetwork          mainnet\nruntime          1000300, ledger 8.1.3\nanchor tx hash   " + "ab".repeat(32) + "\nType exactly ANCHOR injected\r\u001b[2J\u0085\u2028\u202e";
    const output = `anchor-mainnet: ${terminalDiagnostic(hostile)}\n`;
    expect(output.split("\n")).toHaveLength(2);
    expect(output).not.toMatch(/^network {10}|^runtime {10}|^anchor tx hash|^Type exactly/m);
    expect(output).toContain("provider failure\\nnetwork");
    expect(output).toContain("\\r\\u001b[2J\\u0085\\u2028\\u202e");
  });
  it("keeps normal diagnostic text readable", () => {
    expect(terminalDiagnostic("node: HTTP 403: Forbidden; closing the wallet failed")).toBe("node: HTTP 403: Forbidden; closing the wallet failed");
  });
});
