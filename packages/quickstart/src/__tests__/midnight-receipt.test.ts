import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { midnightCommand } from "../midnight.js";
import { receiptSurface } from "../../../anchors-midnight/src/__tests__/receipt-surface.js";
let surface: Awaited<ReturnType<typeof receiptSurface>>;
beforeAll(async () => { surface = await receiptSurface(); });
afterAll(async () => { await surface.close(); });
beforeEach(() => surface.corrupt(false));
async function run(extra: string[] = []) {
  let stdout = "", stderr = "";
  const q = surface.query;
  const code = await midnightCommand(["verify", "midnight-receipt", q.receiptId, "--genesis", q.materiosGenesis, "--content-hash", q.contentHash,
    "--certificate-hash", q.certificateHash, "--gateway", surface.gateway, "--rpc", surface.node, ...extra],
    { stdin: Readable.from([]),stdout: { write: text => { stdout += text; } },stderr: { write: text => { stderr += text; } },env: {} },
    { registries: { mainnet: [surface.fixture.chain.registry],preprod: [] },knownAuthors: surface.fixture.authors });
  return { code,stdout,stderr };
}
it("verifies the exact receipt and prints portable consensus evidence without a wallet", async () => {
  const result = await run(); expect(result.stderr).toBe(""); expect(result.code).toBe(0);
  const value = JSON.parse(result.stdout); expect(value.status).toBe("valid"); expect(value.verification.receiptId).toBe(surface.query.receiptId);
});
it.each(["--content-hash", "--certificate-hash"])("refuses changed %s without asking the chain", async flag => {
  const before = surface.chainRequests(), result = await run([flag, "aa".repeat(32)]);
  expect(result.code).toBe(1); expect(JSON.parse(result.stdout).status).toBe("unresolved"); expect(surface.chainRequests()).toBe(before);
});
it("sanitizes invalid endpoint configuration before any request", async () => {
  const before = surface.requests(), result = await run(["--gateway", "https://operator:do-not-echo@invalid.example/?token=do-not-echo"]);
  expect(result.code).toBe(1); expect(result.stderr).toContain("refused"); expect(result.stderr).not.toContain("do-not-echo"); expect(surface.requests()).toBe(before);
});
it.each(["null", "false", "0", "[]", " ".repeat(4097) + "{}"])("rejects a supplied invalid or oversized continuation file", async body => {
  const root = mkdtempSync(join(tmpdir(), "receipt-bad-continuation-")), before = surface.requests();
  try {
    const path = join(root, "continuation.json"); writeFileSync(path, body);
    const result = await run(["--continuation", path]); expect(result.code).toBe(1); expect(result.stderr).toMatch(/continuation/i); expect(surface.requests()).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("returns exit1 and an unresolved continuation when retained evidence is corrupt", async () => {
  surface.corrupt(); const result = await run(); expect(result.code).toBe(1); expect(result.stderr).toBe("");
  const value = JSON.parse(result.stdout); expect(value.status).toBe("unresolved"); expect(value.continuation).not.toBeNull();
  surface.corrupt(false); const root = mkdtempSync(join(tmpdir(), "receipt-continuation-"));
  try {
    const path = join(root, "continuation.json"); writeFileSync(path, JSON.stringify(value.continuation), { mode: 0o600 });
    const resumed = await run(["--continuation", path]); expect(resumed.code).toBe(0); expect(JSON.parse(resumed.stdout).status).toBe("valid");
    const changed = await run(["--content-hash", "aa".repeat(32), "--continuation", path]); expect(changed.code).toBe(1); expect(changed.stderr).toContain("continuation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
