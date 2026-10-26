import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("advances the offline finality clock once, after broadcast and polling deadline initialization", async () => {
  const root = mkdtempSync(join(tmpdir(), "offline-finality-clock-")), path = join(root, "chain.json");
  writeFileSync(path, JSON.stringify({ network: "preprod", aheadMs: 0, sent: [], landed: {}, discarded: [] }));
  const originalNow = Date.now, originalFetch = globalThis.fetch;
  vi.stubEnv("OFFLINE_CHAIN", path); vi.stubEnv("OFFLINE_FAULT", "unfinal,expire-finality-poll");
  try {
    const { source } = await import("./offline.js");
    await source.node.call("system_chain");
    expect(JSON.parse(readFileSync(path, "utf8")).aheadMs).toBe(0);
    await source.node.call("chain_getFinalizedHead");
    const chain = JSON.parse(readFileSync(path, "utf8"));
    expect(chain.aheadMs).toBe(0);
    writeFileSync(path, JSON.stringify({ ...chain, sent: ["ab".repeat(32)] }));
    const until = Date.now() + 10 * 60_000;
    await source.node.call("chain_getFinalizedHead");
    expect(Date.now()).toBeGreaterThan(until);
    expect(JSON.parse(readFileSync(path, "utf8")).aheadMs).toBe(11 * 60_000);
    await source.node.call("chain_getFinalizedHead");
    expect(JSON.parse(readFileSync(path, "utf8")).aheadMs).toBe(11 * 60_000);
  } finally { Date.now = originalNow; globalThis.fetch = originalFetch; vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
