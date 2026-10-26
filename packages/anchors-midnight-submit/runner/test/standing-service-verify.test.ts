// The verify factory runStandingService hands the controller must locate a landed transaction
// through the hint publishLandedSet passes it: an RPC-only source finds a transaction by nothing
// else. Startup is stubbed as far as the controller; the factory, rpcOnlySource and the HTTP
// transport are real.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

const AUTHOR = "02".repeat(32);
const stub = vi.hoisted(() => ({ captured: null as any, hint: null as any, lookup: null as any }));
vi.mock("@fluxpointstudios/orynq-sdk-anchors-midnight", async (original) => {
  const real = await original<any>();
  return { ...real, knownAuthors: () => ({ authors: () => [{ key: AUTHOR, role: "batch" }], checkpoints: () => [] }), midnightSource: () => ({}), rpcOnlySource: vi.fn(real.rpcOnlySource) };
});
vi.mock("../follower-block.js", async (original) => ({ ...(await original<object>()), followerPolicyDigest: () => "00".repeat(32) }));
vi.mock("../follower-state.js", async (original) => ({ ...(await original<object>()), openFollowerState: () => ({ scope: () => ({ network: "preprod" }), chainView: () => ({}), head: () => null, coverage: () => ({}), close: () => {} }) }));
vi.mock("../standing-status.js", async (original) => ({ ...(await original<object>()), openStandingStatus: () => ({ phase: () => {}, record: () => {}, sample: () => {}, hold: () => {} }) }));
vi.mock("../follower-catchup.js", async (original) => ({ ...(await original<object>()), openFollowerCatchup: () => ({ start: async () => ({}), turn: async () => {
  const options = stub.captured.verify([stub.hint]);
  try { stub.lookup = { ok: await options.source.indexer.transactions(stub.hint.txHash) }; }
  catch (error) { stub.lookup = { error: (error as Error).message }; }
  throw new Error("restart required: wiring probe complete");
} }) }));
vi.mock("../standing-session.js", async (original) => ({ ...(await original<object>()), openStandingSession: () => ({}) }));
vi.mock("../standing-delivery.js", async (original) => ({ ...(await original<object>()), openStandingDelivery: () => ({}) }));
vi.mock("../standing-controller.js", async (original) => ({ ...(await original<object>()), openStandingController: (options: unknown) => { stub.captured = options; return { turn: async () => ({ state: "idle" }) }; } }));
vi.mock("../../src/endpoints.js", async (original) => ({ ...(await original<object>()), networkEndpoints: () => ({}) }));
vi.mock("../../src/preflight.js", async (original) => ({ ...(await original<object>()), assertChainIdentity: async () => ({}) }));
vi.mock("../../src/submission.js", async (original) => ({ ...(await original<object>()), registryStateOnNode: async () => true }));
vi.mock("../../src/wallet.js", async (original) => ({ ...(await original<object>()), openWallet: async () => ({ close: async () => ({ saved: true }) }) }));
vi.mock("../../src/sync.js", async (original) => ({ ...(await original<object>()), syncWithCheckpoints: async () => {} }));
vi.mock("../../src/operator.js", async (original) => ({ ...(await original<object>()), registryOperator: () => ({ authorKey: AUTHOR, close: () => {} }) }));
vi.mock("../../src/zk.js", async (original) => ({ ...(await original<object>()), provingService: () => ({}) }));

let root: string, server: Server, rpcUrl: string;
const requests: Array<[string, unknown[]]> = [];
beforeAll(async () => {
  const { batchChain } = await import("../../../anchors-midnight/src/__tests__/batch-chain.js");
  const fixture = await batchChain({ singleBatch: true, network: "preprod" });
  stub.hint = { txHash: fixture.set.midnight.txHash, blockHeight: fixture.set.midnight.blockHeight, blockHash: fixture.set.midnight.blockHash };
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const answer = async (r: { id: number; method: string; params: unknown[] }) => {
      requests.push([r.method, r.params]);
      try { return { jsonrpc: "2.0", id: r.id, result: await fixture.chain.source.node.call(r.method, r.params) }; }
      catch (error) { return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: (error as Error).message } }; }
    };
    const out = Array.isArray(body) ? await Promise.all(body.map(answer)) : await answer(body);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
  server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/rpc`;
  root = mkdtempSync(join(tmpdir(), "standing-verify-wiring-")); chmodSync(root, 0o700);
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });

it("threads publishLandedSet's block hint into the service's RPC-only source", async () => {
  const { parseStandingConfig, runStandingService } = await import("../standing-service.js");
  const { rpcOnlySource } = await import("@fluxpointstudios/orynq-sdk-anchors-midnight");
  const file = (name: string, body = "x".repeat(40)) => { const path = join(root, name); writeFileSync(path, body, { mode: 0o600 }); return path; };
  const config = parseStandingConfig({ mode: "anchor", network: "preprod", genesis: "01".repeat(32), registry: "03".repeat(32), author: AUTHOR, stateRoot: join(root, "state"),
    materiosRpcUrl: "http://127.0.0.1:9/materios", midnightReadRpcUrl: rpcUrl, knownAuthorsFile: file("authors.json", "[]"),
    wallet: { mnemonic: join(root, "mnemonic"), record: file("record.json", JSON.stringify({ addresses: { unshielded: "u", shielded: "s", dust: "d" } })), state: join(root, "wallet.state"), blockfrost: join(root, "blockfrost"), zk: join(root, "zk"), author: join(root, "author") },
    stores: [{ url: "http://127.0.0.1:10/a", keyFile: file("store-a") }, { url: "http://127.0.0.1:11/b", keyFile: file("store-b") }] });
  await expect(runStandingService(config)).rejects.toThrow(/wiring probe complete/);
  expect(vi.mocked(rpcOnlySource)).toHaveBeenLastCalledWith(expect.objectContaining({ network: "preprod", node: rpcUrl, hints: [stub.hint] }));
  expect(stub.lookup).toEqual({ ok: [expect.objectContaining({ hash: stub.hint.txHash, block: expect.objectContaining({ height: stub.hint.blockHeight, hash: stub.hint.blockHash }) })] });
  expect(requests).toContainEqual(["chain_getBlock", [`0x${stub.hint.blockHash}`]]);
});
