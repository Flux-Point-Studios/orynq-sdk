import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Anchor-mode startup on preprod with every network-facing step stubbed, so the wallet record
// read and the final wallet save run for real against files this test writes.
const AUTHOR = "02".repeat(32);
const stub = vi.hoisted(() => ({ closed: null as unknown, syncFailure: new Error("the preprod wallet did not sync within 10800 s") }));
vi.mock("@fluxpointstudios/orynq-sdk-anchors-midnight", async (original) => ({ ...(await original<object>()),
  knownAuthors: () => ({ authors: () => [{ key: AUTHOR, role: "batch" }], checkpoints: () => [] }), midnightSource: () => ({}) }));
vi.mock("../follower-block.js", async (original) => ({ ...(await original<object>()), followerPolicyDigest: () => "00".repeat(32) }));
vi.mock("../follower-state.js", async (original) => ({ ...(await original<object>()), openFollowerState: () => ({ scope: () => ({ network: "preprod" }), close: () => {} }) }));
vi.mock("../standing-status.js", async (original) => ({ ...(await original<object>()), openStandingStatus: () => ({ phase: () => {} }) }));
vi.mock("../follower-catchup.js", async (original) => ({ ...(await original<object>()), openFollowerCatchup: () => ({}) }));
vi.mock("../../src/endpoints.js", async (original) => ({ ...(await original<object>()), networkEndpoints: () => ({}) }));
vi.mock("../../src/preflight.js", async (original) => ({ ...(await original<object>()), assertChainIdentity: async () => ({}) }));
vi.mock("../../src/submission.js", async (original) => ({ ...(await original<object>()), registryStateOnNode: async () => true }));
vi.mock("../../src/wallet.js", async (original) => ({ ...(await original<object>()), openWallet: async () => ({ close: async () => stub.closed }) }));
vi.mock("../../src/sync.js", async (original) => ({ ...(await original<object>()), syncWithCheckpoints: async () => { throw stub.syncFailure; } }));

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const stopped = async (record: string, mode = 0o600) => {
  const { parseStandingConfig, runStandingService } = await import("../standing-service.js");
  const root = mkdtempSync(join(tmpdir(), "standing-service-stop-")); roots.push(root);
  const file = (name: string) => join(root, name);
  writeFileSync(file("authors.json"), "[]", { mode: 0o600 });
  writeFileSync(file("record.json"), record); chmodSync(file("record.json"), mode);
  const config = parseStandingConfig({ mode: "anchor", network: "preprod", genesis: "01".repeat(32), registry: "03".repeat(32), author: AUTHOR, stateRoot: file("state"),
    materiosRpcUrl: "https://materios.example/rpc", midnightReadRpcUrl: "https://midnight.example/rpc", knownAuthorsFile: file("authors.json"),
    wallet: { mnemonic: file("mnemonic"), record: file("record.json"), state: file("wallet.state"), blockfrost: file("blockfrost"), zk: file("zk"), author: file("author") },
    stores: [{ url: "https://store-a.example", keyFile: file("store-a") }, { url: "https://store-b.example", keyFile: file("store-b") }] });
  try { await runStandingService(config); } catch (error) { return { error: error as Error, record: file("record.json") }; }
  throw new Error("expected the service to stop");
};
const RECORD = JSON.stringify({ addresses: { unshielded: "u", shielded: "s", dust: "d" } });

it("stops on a wallet record others can read and names the file and why", async () => {
  const { error, record } = await stopped(RECORD, 0o644);
  expect(error.message).toBe("Standing wallet record is unreadable");
  expect((error.cause as Error).message).toBe(`${record} can be read or written by group or others`);
});

it("never quotes a wallet record that is not JSON", async () => {
  const { error } = await stopped("abandon ability able");
  expect(error.message).toBe("Standing wallet record is not JSON");
  expect(error.cause).toBeUndefined();
});

it("keeps why the service stopped when the unsynced wallet cannot save at close", async () => {
  stub.closed = null;
  const { error } = await stopped(RECORD);
  expect(error.message).toBe("Standing final wallet save failed");
  expect(error.cause).toBe(stub.syncFailure);
});

it("stops with the original failure itself when the wallet saves at close", async () => {
  stub.closed = { saved: true };
  expect((await stopped(RECORD)).error).toBe(stub.syncFailure);
});
