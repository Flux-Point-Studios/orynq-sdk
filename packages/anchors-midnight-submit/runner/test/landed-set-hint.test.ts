// A landed set's block hint only locates its transaction; it never vouches for it. Every attack
// keeps the census plan, commitment and members valid and changes only the landing-block evidence
// the hint is built from: the hinted block, its height, its canonicity and its finality proof.
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeReceiptRecord } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { parseBatchSet, rpcOnlySource, verifyBatchSet, type BlockHint, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { batchChain } from "../../../anchors-midnight/src/__tests__/batch-chain.js";
import { DEPLOY_HEIGHT } from "../../../anchors-midnight/src/__tests__/anchor-chain.js";
import { encodeJustification, signedPrecommit, testKeys, withUnknownHeaders } from "../../../anchors-midnight/src/__tests__/grandpa-chain.js";
import { headerHash, type BlockHeader } from "../../../anchors-midnight/src/substrate.js";
import { concatBytes, encodeCompact, toHex } from "../../../anchors-midnight/src/scale.js";
import { openCensusState } from "../census-state.js";
import { openStandingController } from "../standing-controller.js";
import { publishCensusPlan } from "../publisher.js";
import type { Census } from "../census.js";

type Node = MidnightSource["node"];
let fixture: Awaited<ReturnType<typeof batchChain>>, census: Census, directory: string, path: string, state: ReturnType<typeof openCensusState>;
let servers: Server[], urls: string[];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const publication = () => ({ network: "preprod" as const, targets: urls.map((url, i) => ({ url, apiKey: `test-writer-${i}` })) });
const H = () => fixture.set.midnight.blockHeight;

beforeAll(async () => {
  fixture = await batchChain({ singleBatch: true, network: "preprod" });
  const raw = JSON.parse(readFileSync(new URL("../../../core/src/__tests__/fixtures/checkpoint-receipts.json", import.meta.url), "utf8"));
  census = { genesis: fixture.batch.genesis, finalizedHeight: fixture.batch.finalizedHeight, finalizedHash: "0x" + "ab".repeat(32),
    entries: raw.receipts.map((row: { receiptId: string; raw: string }) => ({ receiptId: row.receiptId, status: "certified", record: decodeReceiptRecord(Buffer.from(row.raw, "hex")) })) };
});
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "orynq-redteam-hint-")); path = join(directory, "state.sqlite");
  state = openCensusState(path, { network: "preprod", genesis: census.genesis, registry: fixture.set.midnight.registry });
  expect(state.prepare(census, 0n)!.commitment).toBe(fixture.set.commitment);
  servers = []; urls = [];
  const copies = [new Map<string, string>(), new Map<string, string>()];
  for (let i = 0; i < 2; i++) {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
      const body = Buffer.concat(chunks).toString("utf8"), key = req.url!;
      if (req.method === "PUT") { expect(sha(body)).toBe(key.split("/").at(-1)); copies[i]!.set(key, body); res.writeHead(200).end("{}"); return; }
      const stored = copies[i]!.get(key); if (stored === undefined) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(stored);
    });
    server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); servers.push(server);
    urls.push(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  }
  await publishCensusPlan(state, publication()); state.confirm(fixture.set.commitment, census);
});
afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  state.close(); rmSync(directory, { recursive: true, force: true });
});

// The production verify factory shape (standing-service.ts), over a test node.
const rpcVerify = (node: Node) => (hints: readonly BlockHint[]) => ({
  source: rpcOnlySource({ network: "preprod", node, registries: [fixture.chain.registry], hints }),
  registries: [fixture.chain.registry], knownAuthors: fixture.authors,
});

// A node an attacker runs. It answers like Substrate (null for an unknown block) and can serve
// fork blocks, lie about the canonical hash at a height, and replace finality proofs.
function adversarialNode(o: { forks?: Map<string, BlockHeader>; canonical?: Map<number, string>; proofs?: Map<number, Uint8Array>; readProofAlias?: Map<string, string> } = {}): Node {
  const base = fixture.chain.source.node, chain = fixture.chain.chain;
  const call = async (method: string, params: unknown[] = []): Promise<unknown> => {
    const at = (value: unknown) => String(value).replace(/^0x/, "");
    if (method === "chain_getBlock") {
      const fork = o.forks?.get(at(params[0]));
      if (fork) {
        const honestBody = (await base.call<{ block: { extrinsics: string[] } }>("chain_getBlock", [`0x${toHex(headerHash(chain.header(fork.number)))}`])).block.extrinsics;
        return { block: { header: chain.rpcHeader(fork), extrinsics: honestBody }, justifications: null };
      }
      try { return await base.call(method, params); } catch { return null; }
    }
    if (method === "chain_getHeader") { const fork = o.forks?.get(at(params[0])); if (fork) return chain.rpcHeader(fork); }
    if (method === "chain_getBlockHash" && o.canonical?.has(params[0] as number)) return `0x${o.canonical.get(params[0] as number)}`;
    if (method === "grandpa_proveFinality" && o.proofs?.has(params[0] as number)) return `0x${toHex(o.proofs.get(params[0] as number)!)}`;
    if (method === "state_getReadProof" && o.readProofAlias?.has(at(params[1]))) {
      const answer = await base.call<{ at: string; proof: string[] }>(method, [params[0], `0x${o.readProofAlias.get(at(params[1]))}`]);
      return { ...answer, at: params[1] };
    }
    return base.call(method, params);
  };
  return { call: call as Node["call"], batch: (async (calls: Array<[string, unknown[]]>) => Promise.all(calls.map(([m, p]) => call(m, p)))) as Node["batch"] };
}

// A competing block at the anchor's height with the same body (so the same anchor transaction)
// and another pre-runtime digest, as a fork with another slot author would carry.
const forkOfAnchorBlock = (): BlockHeader => {
  const canonical = fixture.chain.chain.header(H());
  const preRuntime = concatBytes(Uint8Array.of(6), new Uint8Array(Buffer.from("aura")), encodeCompact(8), new Uint8Array(8).fill(1));
  return { ...canonical, digest: [...canonical.digest, preRuntime] };
};

// Runs the attack twice: verifyBatchSet directly (to name the failing boundary) and through
// publishLandedSet (to show nothing is staged, published or landed).
async function attack(midnight: Partial<BlockHint>, node: Node) {
  const set = { ...fixture.set, midnight: { ...fixture.set.midnight, ...midnight } };
  const verify = rpcVerify(node), hints = [{ txHash: set.midnight.txHash, blockHeight: set.midnight.blockHeight, blockHash: set.midnight.blockHash }];
  let direct: { status: string; reason: string; checks?: string[] | undefined };
  try {
    const result = await verifyBatchSet(set, verify(hints));
    direct = { status: result.status, reason: result.status === "valid" ? "" : result.reason, checks: result.anchor?.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`) };
  } catch (error) { direct = { status: "thrown", reason: (error as Error).message }; }
  let landing: string;
  try { await state.publishLandedSet(set, { verify, publication: publication() }); landing = "LANDED"; }
  catch (error) { landing = `rejected: ${(error as Error).message}`; }
  const after = state.currentPlan();
  const staged = after ? state.publicationObjects(after.commitment).filter(o => o.kind === "sets").length : -1;
  return { direct, landing, planState: after?.state ?? "landed", staged };
}

it("C0 control: the set's own finalized block lands through an RPC-only source", async () => {
  const r = await attack({}, adversarialNode());
  expect(r.direct.status).toBe("valid"); expect(r.landing).toBe("LANDED"); expect(r.planState).toBe("landed");
});

it("A1: an unknown block hash is refused at the hinted-block lookup", async () => {
  const r = await attack({ blockHash: "11".repeat(32) }, adversarialNode());
  expect(r.direct.status).toBe("conflict"); expect(r.direct.checks!.join("|")).toMatch(/^indexer: The hinted block is absent/);
  expect(r.landing).toMatch(/^rejected: Landed set lacks/); expect(r.planState).toBe("confirmed"); expect(r.staged).toBe(0);
});

it("A2: the right block hash at a wrong height is refused by the header check", async () => {
  const r = await attack({ blockHeight: H() + 1 }, adversarialNode());
  expect(r.direct.status).toBe("conflict"); expect(r.direct.checks!.join("|")).toMatch(/contradicts its hint/);
  expect(r.landing).toMatch(/^rejected/); expect(r.planState).toBe("confirmed"); expect(r.staged).toBe(0);
});

it("A3: a real finalized block without the transaction is refused", async () => {
  const other = fixture.chain.chain.block(H() + 1);
  const r = await attack({ blockHeight: other.height, blockHash: other.hash }, adversarialNode());
  expect(r.direct.status).toBe("conflict"); expect(r.direct.checks!.join("|")).toMatch(/exactly one matching transaction/);
  expect(r.landing).toMatch(/^rejected/); expect(r.planState).toBe("confirmed"); expect(r.staged).toBe(0);
});

it("A4a: a fork block holding the transaction, served by a node honest about its canonical chain", async () => {
  const fork = forkOfAnchorBlock(), forkHash = toHex(headerHash(fork));
  const r = await attack({ blockHash: forkHash }, adversarialNode({ forks: new Map([[forkHash, fork]]) }));
  expect(r.direct.status).toBe("conflict"); expect(r.direct.checks!.join("|")).toMatch(/^node-block:/);
  expect(r.landing).toMatch(/^rejected/); expect(r.planState).toBe("confirmed"); expect(r.staged).toBe(0);
});

it("A4b: the fork block from a node lying that the fork is canonical is refused by GRANDPA", async () => {
  const fork = forkOfAnchorBlock(), forkHash = toHex(headerHash(fork)), canonicalHash = toHex(headerHash(fixture.chain.chain.header(H())));
  const node = adversarialNode({ forks: new Map([[forkHash, fork]]), canonical: new Map([[H(), forkHash]]), readProofAlias: new Map([[forkHash, canonicalHash]]) });
  const r = await attack({ blockHash: forkHash }, node);
  expect(r.direct.status).toBe("unverified-finality"); expect(r.direct.checks!.join("|")).toMatch(/^finality: the finalized chain holds [0-9a-f]{64} at height \d+, not [0-9a-f]{64}/);
  expect(r.landing).toMatch(/^rejected/); expect(r.planState).toBe("confirmed"); expect(r.staged).toBe(0);
});

it("A4c: the lying node also relinks the finality proof's headers to the fork", async () => {
  const chain = fixture.chain.chain, fork = forkOfAnchorBlock(), forkHash = toHex(headerHash(fork)), canonicalHash = toHex(headerHash(chain.header(H())));
  const [honest] = await chain.rpc.proveFinality([H()]);
  const end = chain.endOf(chain.setOf(H()));
  const unknown = Array.from({ length: end - H() }, (_, i) => chain.header(H() + 1 + i));
  unknown[0] = { ...unknown[0]!, parentHash: headerHash(fork) };
  const node = adversarialNode({ forks: new Map([[forkHash, fork]]), canonical: new Map([[H(), forkHash]]), proofs: new Map([[H(), withUnknownHeaders(honest!, unknown)]]), readProofAlias: new Map([[forkHash, canonicalHash]]) });
  const r = await attack({ blockHash: forkHash }, node);
  expect(r.direct.status).toBe("unverified-finality"); expect(r.direct.checks!.join("|")).toMatch(/^finality: header \d+ of the finality proof does not chain/);
  expect(r.landing).toMatch(/^rejected/); expect(r.planState).toBe("confirmed"); expect(r.staged).toBe(0);
});

it("A4d: the lying node finalizes the fork with a justification signed by non-authority keys", async () => {
  const chain = fixture.chain.chain, fork = forkOfAnchorBlock(), forkHash = toHex(headerHash(fork)), canonicalHash = toHex(headerHash(chain.header(H())));
  const setId = chain.checkpoint(chain.setOf(H())).setId, target = { hash: headerHash(fork), number: H() };
  const j = encodeJustification({ round: 7n, target, precommits: testKeys("attacker", 4).map(sk => signedPrecommit(sk, target, 7n, setId)), ancestries: [] });
  const node = adversarialNode({ forks: new Map([[forkHash, fork]]), canonical: new Map([[H(), forkHash]]), proofs: new Map([[H(), chain.proof(fork, j, [])]]), readProofAlias: new Map([[forkHash, canonicalHash]]) });
  const r = await attack({ blockHash: forkHash }, node);
  expect(r.direct.status).toBe("unverified-finality"); expect(r.direct.checks!.join("|")).toMatch(/^finality: the proof for block \d+ does not verify under set \d+/);
  expect(r.landing).toMatch(/^rejected/); expect(r.planState).toBe("confirmed"); expect(r.staged).toBe(0);
});

it("A5: a set naming the registry deploy transaction at another block trips the contradictory-hint guard", async () => {
  const r = await attack({ txHash: fixture.chain.registry.deployTxHash }, adversarialNode());
  expect(r.direct.status).toBe("thrown"); expect(r.direct.reason).toMatch(/Contradictory transaction block hints/);
  expect(r.landing).toMatch(/^rejected: Contradictory transaction block hints/); expect(r.planState).toBe("confirmed"); expect(r.staged).toBe(0);
});

it("A6: a set naming the registry deploy transaction at its real block is refused as no anchor", async () => {
  const r = await attack({ txHash: fixture.chain.registry.deployTxHash, blockHeight: DEPLOY_HEIGHT, blockHash: fixture.chain.registry.deployBlockHash! }, adversarialNode());
  expect(r.direct.status).toBe("invalid"); expect(r.direct.checks!.join("|")).toMatch(/^anchor: .*deploy/);
  expect(r.landing).toMatch(/^rejected/); expect(r.planState).toBe("confirmed"); expect(r.staged).toBe(0);
});

// Composition: the real controller from a journal row to rpcOnlySource, which no existing test runs
// unmocked (publisher.test.ts mocks publishLandedSet).
function controllerWith(row: { blockHash: string; height: number }, node: Node) {
  const scope = { network: "preprod" as const, genesis: census.genesis, registry: fixture.set.midnight.registry, author: fixture.key };
  const never = (what: string) => async () => { throw new Error(`must not ${what}`); };
  const live = { txHash: fixture.set.midnight.txHash, state: "landed" as const, ttl: new Date(0), broadcasts: 1, height: row.height, blockHash: row.blockHash, bytes: new Uint8Array() };
  return openStandingController({ census: state, follower: { scope: () => ({ ...scope }), commitments: () => [] } as never,
    session: { ready: async () => ({ chainTime: 0 }) } as never, delivery: { reconcile: async () => [], submit: never("submit") } as never,
    journal: { live: () => live } as never, operator: { prepare: never("prepare") } as never, readCensus: async () => census,
    publication: publication(), verify: rpcVerify(node) });
}

it("CC0 control: the controller lands a journal-landed row through its own block", async () => {
  await expect(controllerWith({ height: H(), blockHash: fixture.set.midnight.blockHash }, adversarialNode()).turn()).resolves.toMatchObject({ state: "landed" });
  expect(state.currentPlan()).toBeNull();
});

it("CC1: a journal row naming a fork block (lying node) does not land", async () => {
  const fork = forkOfAnchorBlock(), forkHash = toHex(headerHash(fork)), canonicalHash = toHex(headerHash(fixture.chain.chain.header(H())));
  const node = adversarialNode({ forks: new Map([[forkHash, fork]]), canonical: new Map([[H(), forkHash]]), readProofAlias: new Map([[forkHash, canonicalHash]]) });
  await expect(controllerWith({ height: H(), blockHash: forkHash }, node).turn()).rejects.toThrow(/Landed set lacks a current valid consensus proof/);
  expect(state.currentPlan()!.state).toBe("confirmed"); expect(state.publicationObjects(fixture.set.commitment).some(o => o.kind === "sets")).toBe(false);
});

it("CC2: a staged set forged in the census DB (wrong block) is re-verified and never lands", async () => {
  const forged = parseBatchSet({ ...fixture.set, midnight: { ...fixture.set.midnight, blockHash: "22".repeat(32) } }), body = JSON.stringify(forged), digest = sha(body);
  const db = new DatabaseSync(path);
  db.prepare("insert into objects(key,kind,sha256,body) values(?,?,?,?)").run(`sets/${digest}`, "sets", digest, body);
  db.prepare("insert into plan_objects(commitment,key,anchor_id) values(?,?,null)").run(fixture.set.commitment, `sets/${digest}`);
  db.close();
  const controller = controllerWith({ height: H(), blockHash: fixture.set.midnight.blockHash }, adversarialNode());
  await expect(controller.turn()).rejects.toThrow(/Landed set lacks a current valid consensus proof/);
  expect(state.currentPlan()!.state).toBe("confirmed");
  // The forged staged set is immutable evidence: the honest set can no longer replace it.
  await expect(state.publishLandedSet(fixture.set, { verify: rpcVerify(adversarialNode()), publication: publication() })).rejects.toThrow(/Immutable census set evidence differs/);
  expect(state.currentPlan()!.state).toBe("confirmed");
});

it("CC3 control: an honest staged set (restart recovery) lands through the controller's staged path", async () => {
  const honest = parseBatchSet(fixture.set), body = JSON.stringify(honest), digest = sha(body);
  const db = new DatabaseSync(path);
  db.prepare("insert into objects(key,kind,sha256,body) values(?,?,?,?)").run(`sets/${digest}`, "sets", digest, body);
  db.prepare("insert into plan_objects(commitment,key,anchor_id) values(?,?,null)").run(fixture.set.commitment, `sets/${digest}`);
  db.close();
  const controller = controllerWith({ height: H(), blockHash: "33".repeat(32) }, adversarialNode());
  await expect(controller.turn()).resolves.toMatchObject({ state: "landed", txHash: fixture.set.midnight.txHash });
  expect(state.currentPlan()).toBeNull();
});

it("CP5: a node honest before staging and lying after publication cannot land; the honest staged set lands later", async () => {
  const fork = forkOfAnchorBlock(), forkHash = toHex(headerHash(fork)), canonicalHash = toHex(headerHash(fixture.chain.chain.header(H())));
  const lying = adversarialNode({ forks: new Map([[forkHash, fork]]), canonical: new Map([[H(), forkHash]]), readProofAlias: new Map([[forkHash, canonicalHash]]) });
  let calls = 0;
  const switching = (hints: readonly BlockHint[]) => rpcVerify(++calls === 1 ? adversarialNode() : lying)(hints);
  await expect(state.publishLandedSet(fixture.set, { verify: switching, publication: publication() })).rejects.toThrow(/Landed set lacks a current valid consensus proof/);
  expect(calls).toBe(2); expect(state.currentPlan()!.state).toBe("confirmed");
  const staged = state.publicationObjects(fixture.set.commitment).filter(o => o.kind === "sets");
  expect(staged).toHaveLength(1); expect(parseBatchSet(JSON.parse(staged[0]!.body)).midnight.blockHash).toBe(fixture.set.midnight.blockHash);
  await expect(controllerWith({ height: H(), blockHash: "44".repeat(32) }, adversarialNode()).turn()).resolves.toMatchObject({ state: "landed" });
  expect(state.currentPlan()).toBeNull();
});
