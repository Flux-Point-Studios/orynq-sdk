import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkpointToJson } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { followerChain } from "../../../anchors-midnight/src/__tests__/follower-chain.js";
import { checkpointMaintenance } from "../../../anchors-midnight/scripts/checkpoint-advance.js";
import { batchAuthors } from "./batch-fixture.js";

const roots: string[] = [], now = 1_800_000_000_000;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(stale = false) {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-cli-")); roots.push(root);
  const chain = followerChain(undefined, height => now + (height - 1601) * 6000 - (stale ? 180_000 : 0));
  const original = chain.source.node;
  const source = { ...chain.source, network: "preprod" as const, node: { ...original, async call<T>(method: string, params: unknown[] = []) { return method === "chain_getFinalizedHead" ? `0x${chain.ref(1601).hash}` as T : original.call<T>(method, params); } } };
  const history = join(root, "history.json"), output = join(root, "next.json"); writeFileSync(history, "[]", { mode: 0o600 });
  const dependencies = { authors: () => batchAuthors({}, 1, [checkpointToJson(chain.checkpoint)]), source: vi.fn(() => source), now: () => now };
  return { root, history, output, dependencies };
}
it("produces an independently verifiable, fresh, append-only maintenance candidate without a signing key", async () => {
  const f = setup();
  const result = await checkpointMaintenance(["derive", "--network", "preprod", "--node", "http://127.0.0.1:1234", "--history", f.history, "--out", f.output], f.dependencies);
  expect(result).toMatchObject({ network: "preprod", artifacts: 1, sequence: 1, targetHeight: 1601, targetTime: now });
  expect(statSync(f.output).mode & 0o777).toBe(0o600);
  expect(readFileSync(f.history, "utf8")).toBe("[]");
  await expect(checkpointMaintenance(["verify", "--network", "preprod", "--history", f.output], f.dependencies)).resolves.toMatchObject({ artifacts: 1 });
  await expect(checkpointMaintenance(["derive", "--network", "preprod", "--node", "http://127.0.0.1:1234", "--history", f.history, "--out", f.output], f.dependencies)).rejects.toThrow(/exists/);
});
it("refuses a stale authenticated head without publishing a candidate", async () => {
  const f = setup(true);
  await expect(checkpointMaintenance(["derive", "--network", "preprod", "--node", "http://127.0.0.1:1234", "--history", f.history, "--out", f.output], f.dependencies)).rejects.toThrow(/fresh/);
  expect(existsSync(f.output)).toBe(false);
});
it.each(["missing", "malformed", "endpoint"])("refuses %s input before remote calls or output writes", async mode => {
  const f = setup();
  let history = f.history, node = "http://127.0.0.1:1234";
  if (mode === "missing") history = join(f.root, "absent.json");
  if (mode === "malformed") writeFileSync(history, "synthetic-private-mistaken-file");
  if (mode === "endpoint") node = "https://user:synthetic-secret@example.invalid";
  await expect(checkpointMaintenance(["derive", "--network", "preprod", "--node", node, "--history", history, "--out", f.output], f.dependencies)).rejects.toThrow();
  expect(f.dependencies.source).not.toHaveBeenCalled(); expect(existsSync(f.output)).toBe(false);
});
