import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { headerFromRpc, headerHash, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { FORK, forkBlock, recorded } from "../../../anchors-midnight/src/__tests__/fork-chain.js";

// The standing service's own wiring of its delivery's send-boundary runtime, on mainnet: every
// step before it is stubbed, the delivery it opens is captured, and its runtime() is asked of a
// node replaying the recorded fork.
const AUTHOR = "02".repeat(32), REGISTRY = "438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736";
const stub = vi.hoisted(() => ({ home: "", node: undefined as unknown, delivery: undefined as undefined | { runtime: () => Promise<number> } }));
vi.mock("node:os", async (original) => ({ ...(await original<object>()), homedir: () => stub.home }));
vi.mock("@fluxpointstudios/orynq-sdk-anchors-midnight", async (original) => ({ ...(await original<object>()),
  knownAuthors: () => ({ authors: () => [{ key: AUTHOR, role: "batch" }], checkpoints: () => [] }), midnightSource: () => ({ operator: "fork", node: { call: (method: string, params?: unknown[]) => (stub.node as MidnightSource["node"]).call(method, params), batch: async () => [] }, indexer: {} }) }));
vi.mock("../../src/custody.js", async (original) => ({ ...(await original<object>()), agentDriven: () => false, MAINNET_BATCH_AUTHOR_KEYS: [AUTHOR] }));
vi.mock("../follower-block.js", async (original) => ({ ...(await original<object>()), followerPolicyDigest: () => "00".repeat(32) }));
vi.mock("../follower-state.js", async (original) => ({ ...(await original<object>()),
  openFollowerState: () => ({ scope: () => ({ network: "mainnet" }), coverage: () => null, head: () => undefined, chainView: () => ({}), close: () => {} }) }));
vi.mock("../standing-status.js", async (original) => ({ ...(await original<object>()), openStandingStatus: () => ({ phase: () => {}, hold: () => {}, sample: () => {}, record: () => {} }) }));
vi.mock("../follower-catchup.js", async (original) => ({ ...(await original<object>()), openFollowerCatchup: () => ({ start: async () => ({ authenticated: true }), turn: async () => ({}) }) }));
vi.mock("../standing-session.js", async (original) => ({ ...(await original<object>()), openStandingSession: () => ({}) }));
vi.mock("../standing-delivery.js", async (original) => ({ ...(await original<object>()), openStandingDelivery: (options: { runtime: () => Promise<number> }) => { stub.delivery = options; throw new Error("delivery captured"); } }));
vi.mock("../../src/endpoints.js", async (original) => ({ ...(await original<object>()), networkEndpoints: () => ({ headers: {} }) }));
vi.mock("../../src/preflight.js", async (original) => ({ ...(await original<object>()), assertChainIdentity: async () => ({}) }));
vi.mock("../../src/submission.js", async (original) => ({ ...(await original<object>()), registryStateOnNode: async () => true }));
vi.mock("../../src/wallet.js", async (original) => ({ ...(await original<object>()), openWallet: async () => ({ secrets: [], close: async () => ({ saved: true }) }) }));
vi.mock("../../src/operator.js", async (original) => ({ ...(await original<object>()), registryOperator: () => ({ authorKey: AUTHOR, close: () => {} }) }));
vi.mock("../../src/sync.js", async (original) => ({ ...(await original<object>()), syncWithCheckpoints: async () => {} }));
vi.mock("../publisher.js", async (original) => ({ ...(await original<object>()), readProofStoreKey: () => "store-key-0123456789" }));
vi.mock("../census-state.js", async (original) => ({ ...(await original<object>()), openCensusState: () => ({ close: () => {} }) }));
vi.mock("@fluxpointstudios/orynq-sdk-anchors-midnight/journal", async (original) => ({ ...(await original<object>()), openJournal: () => ({ close: () => {} }) }));

// A node whose best block is at `height` and holds the recorded state of mainnet block `stateOf`.
function forkedNode(height: number, stateOf: number): MidnightSource["node"] {
  const block = forkBlock(stateOf), rpcHeader = { ...block.rpcHeader, number: `0x${height.toString(16)}` };
  const hash = `0x${Buffer.from(headerHash(headerFromRpc(rpcHeader))).toString("hex")}`;
  const call = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    if (method === "chain_getHeader" && !params.length) return rpcHeader as T;
    if (method === "state_getReadProof" && params[1] === hash) return { at: hash, proof: recorded<{ proof: string[] }>("state_getReadProof", [params[0], `0x${block.blockHash}`]).proof } as T;
    if (method === "state_getRuntimeVersion") return { specVersion: 1000300 } as T;
    throw new Error(`unexpected ${method}`);
  };
  return { call, batch: async () => [] };
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); stub.delivery = undefined; });

async function deliveryRuntime() {
  const { parseStandingConfig, runStandingService } = await import("../standing-service.js");
  const root = mkdtempSync(join(tmpdir(), "standing-service-wiring-")); roots.push(root);
  stub.home = join(root, "home");
  const file = (name: string) => join(root, name);
  writeFileSync(file("authors.json"), "[]", { mode: 0o600 });
  writeFileSync(file("record.json"), JSON.stringify({ addresses: { unshielded: "u", shielded: "s", dust: "d" } }), { mode: 0o600 });
  const config = parseStandingConfig({ mode: "anchor", network: "mainnet", genesis: "01".repeat(32), registry: REGISTRY, author: AUTHOR, stateRoot: file("state"),
    materiosRpcUrl: "https://materios.example/rpc", midnightReadRpcUrl: "https://midnight.example/rpc", knownAuthorsFile: file("authors.json"),
    wallet: { mnemonic: file("mnemonic"), record: file("record.json"), state: file("wallet.state"), blockfrost: file("blockfrost"), zk: file("zk"), author: file("author") },
    stores: [{ url: "https://store-a.example/proofs", keyFile: file("store-a") }, { url: "https://store-b.example/proofs", keyFile: file("store-b") }] });
  await expect(runStandingService(config)).rejects.toThrow("delivery captured");
  return stub.delivery!.runtime;
}

it("asks the node, at the send boundary, for the runtime of the block after its best, whatever the follower last verified", async () => {
  const runtime = await deliveryRuntime();
  stub.node = forkedNode(FORK.setCode, FORK.setCode);
  await expect(runtime()).resolves.toBe(2001100);
  stub.node = forkedNode(FORK.setCode - 1, FORK.setCode - 1);
  await expect(runtime()).resolves.toBe(1000300);
});

it("binds that runtime to the registry generation's span at the block after the node's best", async () => {
  const runtime = await deliveryRuntime();
  stub.node = forkedNode(FORK.setCode - 1, FORK.firstLedger9);
  await expect(runtime()).rejects.toThrow(`the mainnet node runs runtime 2001100 at block ${FORK.setCode}, which registry generation 1 does not run there`);
});
