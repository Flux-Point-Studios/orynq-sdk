import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The service's own hold handlers, driven by a follower whose startup and turns fail as told:
// every network-facing step is stubbed, and what the service prints is what is asserted.
const AUTHOR = "02".repeat(32);
const PROJECT_ID = "preprod" + "Zx".repeat(16), STORE_KEY = "store-key-0123456789", RELAY_PREFIX = "fedcba9876543210".repeat(2);
const stub = vi.hoisted(() => ({ starts: [] as unknown[], turns: [] as unknown[], started: 0, turned: 0 }));
const next = (queue: unknown[]) => { const step = queue.shift(); return step instanceof Error || typeof step !== "object" || step === null ? Promise.reject(step) : Promise.resolve(step); };
vi.mock("@fluxpointstudios/orynq-sdk-anchors-midnight", async (original) => ({ ...(await original<object>()),
  knownAuthors: () => ({ authors: () => [{ key: AUTHOR, role: "batch" }], checkpoints: () => [] }), midnightSource: () => ({}) }));
vi.mock("../follower-block.js", async (original) => ({ ...(await original<object>()), followerPolicyDigest: () => "00".repeat(32) }));
vi.mock("../follower-state.js", async (original) => ({ ...(await original<object>()),
  openFollowerState: () => ({ scope: () => ({ network: "preprod" }), coverage: () => null, head: () => undefined, close: () => {} }) }));
vi.mock("../standing-status.js", async (original) => ({ ...(await original<object>()),
  openStandingStatus: () => ({ phase: () => {}, hold: () => {}, sample: () => {}, record: () => {} }) }));
vi.mock("../follower-catchup.js", async (original) => ({ ...(await original<object>()),
  openFollowerCatchup: () => ({ start: () => { stub.started++; return next(stub.starts); }, turn: () => { stub.turned++; return next(stub.turns); } }) }));
vi.mock("../../src/endpoints.js", async (original) => ({ ...(await original<object>()), networkEndpoints: () => ({ headers: { project_id: PROJECT_ID } }) }));
vi.mock("../../src/preflight.js", async (original) => ({ ...(await original<object>()), assertChainIdentity: async () => ({}) }));
vi.mock("../../src/submission.js", async (original) => ({ ...(await original<object>()), registryStateOnNode: async () => true }));
vi.mock("../../src/wallet.js", async (original) => ({ ...(await original<object>()), openWallet: async () => ({ secrets: [RELAY_PREFIX], close: async () => ({ saved: true }) }) }));
vi.mock("../../src/sync.js", async (original) => ({ ...(await original<object>()), syncWithCheckpoints: async () => {} }));
vi.mock("../publisher.js", async (original) => ({ ...(await original<object>()), readProofStoreKey: () => STORE_KEY }));
vi.mock("../census-state.js", async (original) => ({ ...(await original<object>()), openCensusState: () => ({ close: () => {} }) }));
vi.mock("@fluxpointstudios/orynq-sdk-anchors-midnight/journal", async (original) => ({ ...(await original<object>()), openJournal: () => ({ close: () => {} }) }));

const roots: string[] = [];
let printed: string[] = [];
beforeEach(() => {
  stub.starts = []; stub.turns = []; stub.started = 0; stub.turned = 0; printed = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { printed.push(String(line)); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function run(mode: "observe" | "anchor") {
  const { parseStandingConfig, runStandingService } = await import("../standing-service.js");
  const root = mkdtempSync(join(tmpdir(), "standing-service-hold-")); roots.push(root);
  const file = (name: string) => join(root, name);
  writeFileSync(file("authors.json"), "[]", { mode: 0o600 });
  writeFileSync(file("record.json"), JSON.stringify({ addresses: { unshielded: "u", shielded: "s", dust: "d" } }), { mode: 0o600 });
  const config = parseStandingConfig({ mode, network: "preprod", genesis: "01".repeat(32), registry: "03".repeat(32), author: AUTHOR, stateRoot: file("state"),
    materiosRpcUrl: "https://materios.example/rpc", midnightReadRpcUrl: "https://midnight.example/rpc", knownAuthorsFile: file("authors.json"),
    wallet: { mnemonic: file("mnemonic"), record: file("record.json"), state: file("wallet.state"), blockfrost: file("blockfrost"), zk: file("zk"), author: file("author") },
    stores: [{ url: "https://store-a.example", keyFile: file("store-a") }, { url: "https://store-b.example", keyFile: file("store-b") }] });
  let done = false;
  const stopped = runStandingService(config).then(() => null, (error: unknown) => error).finally(() => { done = true; });
  for (let waited = 0; waited < 120 && !done; waited++) await vi.advanceTimersByTimeAsync(5_000);
  return { error: await stopped, holds: printed.filter(line => /"event":"standing-(startup-)?hold"/.test(line)).map(line => JSON.parse(line)) };
}

it("prints a startup hold and each loop hold with its cause chain, and keeps retrying through a link it cannot read", async () => {
  const hostile = new Proxy({}, { get() { throw new Error("trap"); }, getPrototypeOf() { throw new Error("trap"); } });
  stub.starts = [new Error("cold source deadline", { cause: new TypeError("fetch failed") }), { authenticated: true }];
  stub.turns = [Object.assign(new Error(), { message: 404 as unknown as string }), new Error("read refused", { cause: hostile }), new Error("source drift"), new Error("process restart required")];
  const { error, holds } = await run("observe");
  expect((error as Error).message).toBe("process restart required");
  expect(stub.turned).toBe(4);
  expect(holds).toEqual([
    { event: "standing-startup-hold", loop: "follower", reason: "source", causes: [{ name: "Error", message: "cold source deadline" }, { name: "TypeError", message: "fetch failed" }] },
    { event: "standing-hold", loop: "follower", reason: "source", causes: [{ name: "Error", message: "404" }] },
    { event: "standing-hold", loop: "follower", reason: "source", causes: "unprintable" },
    { event: "standing-hold", loop: "follower", reason: "source", causes: [{ name: "Error", message: "source drift" }] },
    { event: "standing-hold", loop: "follower", reason: "source", causes: [{ name: "Error", message: "process restart required" }] },
  ]);
});

it("redacts the configured project id, proof-store keys and relay prefix from a hold, by value", async () => {
  stub.starts = [new Error(`upstream echoed ${PROJECT_ID} x${STORE_KEY}y ${encodeURIComponent(RELAY_PREFIX)}`), new Error("process restart required")];
  const { error, holds } = await run("anchor");
  expect((error as Error).message).toBe("process restart required");
  expect(holds[0]).toMatchObject({ event: "standing-startup-hold", causes: [{ name: "Error" }] });
  const line = JSON.stringify(holds);
  for (const secret of [PROJECT_ID, STORE_KEY, RELAY_PREFIX]) expect(line).not.toContain(secret);
  expect(line).toContain("upstream echoed");
});
