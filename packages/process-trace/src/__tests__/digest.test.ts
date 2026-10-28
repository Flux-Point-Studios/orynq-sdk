import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sha256StringHex } from "@fluxpointstudios/orynq-sdk-core/utils";
import { sha256Hex } from "../digest.js";
import { addEvent, addSpan, closeSpan, createTrace, finalizeTrace, verifyBundle } from "../index.js";

describe("sha256Hex", () => {
  it.each([
    ["the empty string", ""],
    ["a domain-prefixed input", "poi-trace:roll:v1|genesis"],
    ["accents, combining marks and astral characters", "é é ☃ 𝄞"],
    ["a lone surrogate", "lone \ud800 surrogate"],
    ["a long input", "x".repeat(100_000)],
  ])("hashes %s as node:crypto and the Web Crypto digest do", async (_name, text) => {
    const expected = createHash("sha256").update(text, "utf8").digest("hex");
    expect(sha256Hex(text)).toBe(expected);
    expect(await sha256StringHex(text)).toBe(expected);
  });
});

describe("trace hashing", () => {
  // An asynchronous Web Crypto digest for each event, span and node made
  // verifying a fetched 8 MiB bundle take about four times as long.
  it("builds and verifies a trace without an asynchronous Web Crypto digest", async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    const unpinnedManifestWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const run = await createTrace({ agentId: "digest" });
      const span = addSpan(run, { name: "work", visibility: "public" });
      for (const command of ["build", "test", "ship"]) {
        await addEvent(run, span.id, { kind: "command", command, visibility: "public" });
      }
      await closeSpan(run, span.id);
      expect((await verifyBundle(await finalizeTrace(run))).valid).toBe(true);
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
      unpinnedManifestWarning.mockRestore();
    }
  });
});
