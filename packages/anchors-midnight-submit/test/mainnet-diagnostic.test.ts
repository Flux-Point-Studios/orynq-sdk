import { readFileSync } from "node:fs";
import type { MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { assertChainIdentity, NETWORK_IDENTITY } from "../src/preflight.js";
import { describe, expect, it } from "vitest";
import { terminalDiagnostic, deadlineBeforeAnnouncement } from "../scripts/mainnet-session.js";

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

it("counts time spent printing the finality announcement inside its original deadline", () => {
  let now = 1000;
  const until = deadlineBeforeAnnouncement(10 * 60_000, () => { now += 11 * 60_000; }, () => now);
  expect(until).toBe(601000);
  expect(now).toBeGreaterThan(until);
});

it("accepts the captured mainnet exact-version RPC syntax only after strict normalization", async () => {
  const captured = JSON.parse(readFileSync(new URL("./fixtures/mainnet-ledger-prices.json", import.meta.url), "utf8"));
  const values: Record<string, unknown> = { system_chain: NETWORK_IDENTITY.mainnet.chain, chain_getBlockHash: `0x${captured.genesis}`, state_getRuntimeVersion: { specVersion: captured.runtimeSpecVersion }, midnight_ledgerVersion: captured.ledgerVersionRpc };
  const source = { node: { call: async (method: string) => values[method] } } as unknown as MidnightSource;
  expect((await assertChainIdentity(source, "mainnet")).ledgerVersion).toBe("8.1.2");
});
