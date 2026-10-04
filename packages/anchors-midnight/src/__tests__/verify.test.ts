import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import { verifyMidnightAnchor, type VerifyRequest, type VerifyResult } from "../verify.js";
import { buildRegistryDeploy, registryInitialState } from "../registry.js";
import { concatBytes, encodeCompact, fromHex, toHex } from "../scale.js";
import { DEPLOY_HEIGHT, HEIGHTS, anchorChain, fixture, sendMnTransaction } from "./anchor-chain.js";
import { NETWORK, finalBytes, unprovenRegistryCall } from "./registry-call.js";
import { replaySource } from "./recorded-source.js";
import type { RegistryInfo } from "../registries.js";
import type { IndexedTransaction } from "../source.js";

type Chain = ReturnType<typeof anchorChain>;
const request = (name: "anchor" | "hiding" | "stranger", expect: VerifyRequest["expect"], extra: Partial<VerifyRequest> = {}): VerifyRequest => ({
  network: "mainnet",
  txHash: fixture[name].txHash,
  expect,
  ...extra,
});
const KIND1 = { kind: 1 as const, entry: fixture.anchor.entry };
const KIND2 = { kind: 2 as const, attribute: fixture.hiding.attribute };
const verify = (chain: Chain, req: VerifyRequest, options: Partial<Parameters<typeof verifyMidnightAnchor>[1]> = {}) =>
  verifyMidnightAnchor(req, { source: chain.source, registries: [chain.registry], knownAuthors: chain.authors(), ...options });
const check = (r: VerifyResult, name: string) => r.checks.find((c) => c.name === name);

describe("a valid anchor: consensus-verified from the transaction's bytes to a GRANDPA-final block", () => {
  it("kind 1: the entry's rootHash, manifestHash and merkleRoot are what the commitment binds", async () => {
    const chain = anchorChain();
    const r = await verify(chain, request("anchor", KIND1));
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r).toMatchObject({
      status: "valid",
      assurance: "consensus-verified",
      operators: ["synthetic"],
      registry: { generation: 1, address: fixture.registry.address },
      block: chain.block("anchor"),
      anchor: { entryPoint: "anchor", kind: 1, commitment: fixture.anchor.commitment, author: fixture.author.key },
      author: { status: "known", key: fixture.author.key, id: "fluxpoint-relay", role: "relay" },
      verifiedFields: ["rootHash", "manifestHash", "merkleRoot"],
      knownAuthorsSerial: 1,
    });
    expect(r.finality).toMatchObject({ finalized: true });
  });

  it("kind 1 by commitment alone verifies only the commitment", async () => {
    const r = await verify(anchorChain(), request("anchor", { kind: 1, commitment: fixture.anchor.commitment }));
    expect(r).toMatchObject({ status: "valid", verifiedFields: ["commitment"] });
  });

  it("kind 2 with the attribute alone: the attribute is committed with the hidden entry, and the result says it is not checked against the trace", async () => {
    const r = await verify(anchorChain(), request("hiding", KIND2));
    expect(r).toMatchObject({ status: "valid", assurance: "consensus-verified", verifiedFields: ["committedAttribute"] });
    expect(r.notes).toContain("kind 2: the registry circuit binds the attribute to the commitment and never checks it against the trace's model manifest");
    expect(r.verifiedFields).not.toContain("attribute");
  });

  it("kind 2 with the private opening also verifies the hidden entry's hashes, locally", async () => {
    const r = await verify(anchorChain(), request("hiding", { ...KIND2, opening: fixture.hiding.opening }));
    expect(r).toMatchObject({ status: "valid", verifiedFields: ["committedAttribute", "rootHash", "manifestHash", "merkleRoot"] });
  });
});

describe("critique2 (f): never valid without consensus finality, and every result says how far it got", () => {
  it("skipping finality leaves the anchor unverified at multi-path, never valid", async () => {
    const r = await verify(anchorChain(), request("anchor", KIND1), { finality: "skip" });
    expect(r).toMatchObject({ status: "unverified-finality", assurance: "multi-path" });
    expect(check(r, "finality")).toEqual({ name: "finality", ok: false, detail: "skipped by the caller" });
  });

  it("a block beyond the finality budget is unverified, not valid", async () => {
    const r = await verify(anchorChain(), request("anchor", KIND1), { maxSetChanges: 0 });
    expect(r).toMatchObject({ status: "unverified-finality", assurance: "multi-path" });
    expect(check(r, "finality")!.detail).toMatch(/more than 0 GRANDPA set changes past the nearest checkpoint/);
  });

  it("no trusted checkpoint at all leaves it unverified", async () => {
    const chain = anchorChain();
    const r = await verifyMidnightAnchor(request("anchor", KIND1), { source: chain.source, registries: [chain.registry], knownAuthors: { ...chain.authors(), checkpoints: () => [] } });
    expect(r).toMatchObject({ status: "unverified-finality", assurance: "multi-path" });
    expect(check(r, "finality")!.detail).toMatch(/no finality checkpoint lies below block 2020/);
  });

  it("valid is reachable only at consensus-verified, even if every check passes below it", async () => {
    const chain = anchorChain();
    const results = await Promise.all([
      verify(chain, request("anchor", KIND1)),
      verify(chain, request("anchor", KIND1), { finality: "skip" }),
      verify(chain, request("hiding", KIND2), { maxSetChanges: 0 }),
      verify(chain, request("stranger", KIND1, { expectedAuthor: fixture.stranger.key }), { finality: "skip" }),
    ]);
    for (const r of results) if (r.status === "valid") expect(r.assurance).toBe("consensus-verified");
    expect(results.map((r) => r.status)).toEqual(["valid", "unverified-finality", "unverified-finality", "unverified-finality"]);
  });

  it("a node that cannot answer leaves only the indexer's word: single-path and unavailable", async () => {
    const down = () => {
      throw new Error("synthetic node is down");
    };
    const r = await verify(anchorChain({ node: { chain_getBlockHash: down, chain_getBlock: down } }), request("anchor", KIND1));
    expect(r).toMatchObject({ status: "unavailable", assurance: "single-path" });
  });
});

describe("critique2 (a): inclusion is a strict decode of the final block's extrinsics", () => {
  it("refuses a final block whose body carries the transaction only inside another extrinsic", async () => {
    const tx = fromHex(fixture.anchor.tx, "tx");
    const remark = concatBytes(encodeCompact(3 + encodeCompact(tx.length).length + tx.length), new Uint8Array([4, 0, 0]), encodeCompact(tx.length), tx);
    const chain = anchorChain({ bodies: new Map([[HEIGHTS.anchor, [remark]]]) });
    const r = await verify(chain, request("anchor", KIND1));
    expect(Buffer.from(remark).includes(Buffer.from(tx))).toBe(true);
    expect(check(r, "finality")!.ok).toBe(true);
    expect(check(r, "inclusion")).toMatchObject({ ok: false, detail: expect.stringMatching(/no extrinsic of block 2020 is exactly a bare Midnight.send_mn_transaction of this transaction/) });
    expect(r.status).toBe("conflict");
    expect(r.assurance).not.toBe("consensus-verified");
  });

  it("refuses a body that does not match its header's extrinsicsRoot", async () => {
    const chain = anchorChain({
      node: {
        chain_getBlock: (_, honest) => {
          const b = honest() as { block: { header: unknown; extrinsics: string[] } };
          return { ...b, block: { ...b.block, extrinsics: [...b.block.extrinsics, `0x${toHex(sendMnTransaction(new Uint8Array([1, 2, 3])))}`] } };
        },
      },
    });
    const r = await verify(chain, request("anchor", KIND1));
    expect(check(r, "extrinsics-root")).toMatchObject({ ok: false });
    expect(r.status).toBe("conflict");
  });
});

describe("the transaction, the registry and its state", () => {
  it("binds the bytes to the requested hash: an indexer that answers another transaction's bytes is refused", async () => {
    const chain = anchorChain({ indexer: { [fixture.anchor.txHash]: () => [{ ...chain.indexed.get(fixture.stranger.txHash)!, hash: fixture.anchor.txHash }] } });
    const r = await verify(chain, request("anchor", KIND1));
    expect(check(r, "transaction-hash")).toMatchObject({ ok: false, detail: expect.stringMatching(/the bytes hash to f8f39f56/) });
    expect(r.checks.map((c) => c.name)).toEqual(["registry", "indexer", "transaction-hash"]);
    expect(r).toMatchObject({ status: "invalid", assurance: "none" });
  });

  it("binds the pinned deploy's bytes to its hash too, before anything else is checked", async () => {
    const chain = anchorChain({ indexer: { [fixture.registry.txHash]: () => [{ ...chain.indexed.get(fixture.anchor.txHash)!, hash: fixture.registry.txHash }] } });
    const r = await verify(chain, request("anchor", KIND1));
    expect(check(r, "registry-deploy/transaction-hash")).toMatchObject({ ok: false, detail: expect.stringMatching(/the bytes hash to d752414e/) });
    expect(r.checks.map((c) => c.name)).not.toContain("registry-deploy/node-block");
    expect(r.status).toBe("invalid");
  });

  it("refuses a transaction that writes to no registry generation", async () => {
    const chain = anchorChain();
    const r = await verifyMidnightAnchor(request("anchor", KIND1), { source: chain.source, registries: [{ ...chain.registry, address: "ab".repeat(32) }], knownAuthors: chain.authors() });
    expect(check(r, "anchor")).toMatchObject({ ok: false, detail: expect.stringMatching(/writes no anchor to a registry generation/) });
    expect(r.status).toBe("invalid");
  });

  it("refuses a registry generation pinned to other verifier keys", async () => {
    const chain = anchorChain();
    const wrong = { ...chain.registry, circuits: { ...chain.registry.circuits, anchor: { vkSha256: "00".repeat(32) } } };
    const r = await verifyMidnightAnchor(request("anchor", KIND1), { source: chain.source, registries: [wrong], knownAuthors: chain.authors() });
    expect(check(r, "registry")).toMatchObject({ ok: false, detail: expect.stringMatching(/anchor verifier key 0{64} is not the compiled/) });
    expect(r.status).toBe("invalid");
  });

  it("refuses a registry pinned to a genuine registry deploy at another address", async () => {
    const other = buildRegistryDeploy({ networkId: NETWORK, ttl: new Date(Date.UTC(2030, 0, 1)) });
    const bytes = await finalBytes(other.tx);
    const hash = L.Transaction.deserialize("signature", "proof", "binding", bytes).transactionHash();
    const chain = anchorChain({ place: [[1460, "deploy", toHex(bytes), hash]] });
    const r = await verifyMidnightAnchor(request("anchor", KIND1), { source: chain.source, registries: [{ ...chain.registry, deployTxHash: hash, deployHeight: 1460 }], knownAuthors: chain.authors() });
    expect(other.address).not.toBe(fixture.registry.address);
    expect(check(r, "registry-deploy")).toMatchObject({ ok: false, detail: expect.stringMatching(new RegExp(`it deploys ${other.address}, not ${fixture.registry.address}`)) });
    expect(r.status).toBe("invalid");
  });

  it("refuses a registry whose pinned deploy is not a deploy of the immutable registry state", async () => {
    const chain = anchorChain();
    const r = await verifyMidnightAnchor(request("anchor", KIND1), { source: chain.source, registries: [{ ...chain.registry, deployTxHash: fixture.stranger.txHash, deployHeight: HEIGHTS.stranger }], knownAuthors: chain.authors() });
    expect(check(r, "registry-deploy")).toMatchObject({ ok: false });
    expect(r.status).toBe("invalid");
  });

  it("treats a state snapshot with a different authority as a conflict, from the indexer or the node", async () => {
    const maintained = registryInitialState();
    maintained.maintenanceAuthority = new L.ContractMaintenanceAuthority([], 1, 1n);
    const counterOne = toHex(maintained.serialize());
    const viaIndexer = anchorChain({ indexer: { [fixture.anchor.txHash]: (h) => h.map((t) => ({ ...t, contractActions: t.contractActions.map((a) => ({ ...a, state: counterOne })) })) } });
    const a = await verify(viaIndexer, request("anchor", KIND1));
    expect(check(a, "indexer-state")).toMatchObject({ ok: false, detail: expect.stringMatching(/counter must be 0, got 1/) });
    expect(a.status).toBe("conflict");
    const viaNode = anchorChain({ node: { midnight_contractState: () => `0x${counterOne}` } });
    const b = await verify(viaNode, request("anchor", KIND1));
    expect(check(b, "node-state")).toMatchObject({ ok: false, detail: expect.stringMatching(/counter must be 0, got 1/) });
    expect(b.status).toBe("conflict");
  });

  it("refuses a transaction that also carries a maintenance update aimed at the registry", async () => {
    const chain = anchorChain();
    const state = registryInitialState();
    const { tx } = unprovenRegistryCall({ address: fixture.registry.address, state, call: { circuit: "anchor", args: [new Uint8Array(32).fill(5), 1n] }, witnesses: { authorSecret: new Uint8Array(32).fill(6) } });
    const intent = [...tx.intents!.values()][0]!.addMaintenanceUpdate(new L.MaintenanceUpdate(fixture.registry.address, [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority([], 0, 1n))], 0n));
    const bytes = await finalBytes(L.Transaction.fromParts(NETWORK, undefined, undefined, intent));
    const hash = L.Transaction.deserialize("signature", "proof", "binding", bytes).transactionHash();
    const withUpdate = anchorChain({ indexer: { [hash]: () => [{ ...chain.indexed.get(fixture.anchor.txHash)!, hash, raw: toHex(bytes) }] } });
    const r = await verify(withUpdate, { network: "mainnet", txHash: hash, expect: { kind: 1, commitment: "05".repeat(32) } });
    expect(check(r, "anchor")).toMatchObject({ ok: false, detail: expect.stringMatching(/also carries a maintenance update aimed at registry/) });
    expect(r.status).toBe("invalid");
  });

  it("refuses an indexer that reports the transaction failed", async () => {
    const chain = anchorChain({ indexer: { [fixture.anchor.txHash]: (h) => h.map((t) => ({ ...t, status: "FAILURE" as const })) } });
    expect(await verify(chain, request("anchor", KIND1))).toMatchObject({ status: "invalid", checks: expect.arrayContaining([{ name: "indexer-status", ok: false, detail: "the indexer reports FAILURE" }]) });
  });

  it("reports sources that disagree about the block as a conflict", async () => {
    const chain = anchorChain({ node: { chain_getBlockHash: () => `0x${"77".repeat(32)}` } });
    const r = await verify(chain, request("anchor", KIND1));
    expect(check(r, "node-block")).toMatchObject({ ok: false });
    expect(r.status).toBe("conflict");
  });
});

describe("expectations: only what the commitment binds is reported as verified", () => {
  it("refuses an entry that is not the committed one", async () => {
    const r = await verify(anchorChain(), request("anchor", { kind: 1, entry: { ...fixture.anchor.entry, merkleRoot: "00".repeat(32) } }));
    expect(r).toMatchObject({ status: "invalid", verifiedFields: [] });
    expect(check(r, "expectation")!.detail).toMatch(/the anchor commits to [0-9a-f]{64}, not to the entry/);
  });

  it("refuses a kind-2 request against a kind-1 anchor even when the attribute matches its zero attribute, and the reverse", async () => {
    const chain = anchorChain();
    expect(check(await verify(chain, request("anchor", { kind: 2, attribute: "00".repeat(32) })), "expectation")).toMatchObject({ ok: false, detail: "the anchor is kind 1, not kind 2" });
    expect(check(await verify(chain, request("hiding", { kind: 1, commitment: fixture.hiding.commitment })), "expectation")).toMatchObject({ ok: false, detail: "the anchor is kind 2, not kind 1" });
  });

  it("refuses another attribute, a wrong opening, and the wrong kind", async () => {
    const chain = anchorChain();
    expect((await verify(chain, request("hiding", { kind: 2, attribute: "11".repeat(32) }))).status).toBe("invalid");
    expect((await verify(chain, request("hiding", { ...KIND2, opening: { ...fixture.hiding.opening, salt: "22".repeat(32) } }))).status).toBe("invalid");
    expect((await verify(chain, request("hiding", KIND1))).status).toBe("invalid");
    expect((await verify(chain, request("anchor", { kind: 3, commitment: fixture.anchor.commitment } as never))).status).toBe("invalid");
  });
});

describe("critique2 (c): authors come from the signed KNOWN_AUTHORS document", () => {
  it("an anchor by a key the document does not list is unauthenticated", async () => {
    const r = await verify(anchorChain(), request("stranger", { kind: 1, entry: fixture.anchor.entry }));
    expect(r).toMatchObject({ status: "unauthenticated", assurance: "consensus-verified", author: { status: "unknown", key: fixture.stranger.key } });
  });

  it("an anchor above the height where the document closed the author's window is author-revoked", async () => {
    const chain = anchorChain();
    const r = await verify(chain, request("anchor", KIND1), { knownAuthors: chain.authors([{ validTo: HEIGHTS.anchor - 1 }]) });
    expect(r).toMatchObject({ status: "author-revoked", author: { status: "outside-window", validTo: HEIGHTS.anchor - 1 } });
  });

  it("an author the caller pins is accepted in place of the document, and any other is not", async () => {
    const chain = anchorChain();
    expect(await verify(chain, request("stranger", KIND1, { expectedAuthor: fixture.stranger.key }))).toMatchObject({ status: "valid", author: { status: "expected", key: fixture.stranger.key } });
    expect(await verify(chain, request("anchor", KIND1, { expectedAuthor: fixture.stranger.key }))).toMatchObject({ status: "unauthenticated" });
  });

  it("refuses a registry whose pinned deploy height is not where its deploy is", async () => {
    const chain = anchorChain();
    const r = await verifyMidnightAnchor(request("anchor", KIND1), { source: chain.source, registries: [{ ...chain.registry, deployHeight: DEPLOY_HEIGHT - 10 }], knownAuthors: chain.authors() });
    expect(check(r, "registry-deploy")).toMatchObject({ ok: false, detail: expect.stringMatching(/it is in block 1450, not the pinned 1440/) });
    expect(r.status).toBe("invalid");
  });
});

// Recorded by running this verifier against Blockfrost on each network: a real contract call
// that is not an anchor, checked against a registry generation it does not call and against
// its own contract named as one. The replay fails on any request that was not recorded.
describe.each(["mainnet", "preprod"] as const)("golden: the verifier on a real %s transaction, replayed", (network) => {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/${network}-verify.json`, import.meta.url), "utf8"));
  const checkpoint = { setId: BigInt(f.checkpoint.setId), startsAfter: f.checkpoint.startsAfter, authorities: f.checkpoint.authorities.map((a: { key: string; weight: string }) => ({ key: a.key, weight: BigInt(a.weight) })) };
  const generation = (address: string): RegistryInfo => ({ ...anchorChain().registry, address, deployTxHash: "cd".repeat(32), deployHeight: 1 });
  const run = (address: string, edit?: Parameters<typeof replaySource>[1]) =>
    verifyMidnightAnchor({ network, txHash: f.txHash, expect: { kind: 1, commitment: "00".repeat(32) } }, { source: replaySource(f.recording, edit), registries: [generation(address)], checkpoints: [checkpoint] });
  const lines = (r: VerifyResult) => r.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);

  it.each([0, 1])("reproduces recorded run %i check for check", async (i) => {
    const recorded = f.runs[i];
    const r = await run(recorded.address);
    expect({ status: r.status, assurance: r.assurance, checks: lines(r) }).toEqual({ status: recorded.status, assurance: recorded.assurance, checks: recorded.checks });
  });

  it("the real transaction's inclusion is consensus-verified, and it is still not an anchor", async () => {
    const r = await run(f.runs[0].address);
    expect(r).toMatchObject({ status: "invalid", assurance: "consensus-verified" });
    expect(check(r, "inclusion")!.ok && check(r, "finality")!.ok).toBe(true);
  });

  it("a body changed in transit no longer matches the real header", async () => {
    const r = await run(f.runs[0].address, (method, _, answer) => {
      if (method !== "chain_getBlock") return answer;
      const b = answer as { block: { extrinsics: string[] } };
      const last = b.block.extrinsics.at(-1)!;
      return { ...b, block: { ...b.block, extrinsics: [...b.block.extrinsics.slice(0, -1), last.slice(0, -2) + (last.endsWith("00") ? "01" : "00")] } };
    });
    expect(check(r, "extrinsics-root")).toMatchObject({ ok: false });
    expect(check(r, "finality")).toBeUndefined();
    expect(r.assurance).toBe("single-path");
  });

  it("bytes changed in transit no longer hash to the requested transaction", async () => {
    const r = await run(f.runs[0].address, (method, _, answer) =>
      method === "indexer.transactions" ? (answer as IndexedTransaction[]).map((t) => ({ ...t, raw: t.raw.slice(0, 200) + (t.raw[200] === "0" ? "1" : "0") + t.raw.slice(201) })) : answer,
    );
    expect(r.status).toBe("invalid");
    expect(r.assurance).toBe("none");
  });
});
