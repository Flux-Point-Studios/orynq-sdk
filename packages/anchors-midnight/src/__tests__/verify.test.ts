import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import { verifyMidnightAnchor, type VerifyRequest, type VerifyResult } from "../verify.js";
import { buildRegistryDeploy, registryInitialState } from "../registry.js";
import { concatBytes, encodeCompact, fromHex, toHex, u32le, u64le } from "../scale.js";
import { decodeFinalityProof } from "../grandpa.js";
import { encodeHeader } from "../substrate.js";
import { DEPLOY_HEIGHT, HEIGHTS, anchorChain, fixture, sendMnTransaction } from "./anchor-chain.js";
import { NETWORK, finalBytes, unprovenRegistryCall } from "./registry-call.js";
import { replaySource } from "./recorded-source.js";
import { knownAuthors } from "../known-authors.js";
import type { RegistryInfo } from "../registries.js";
import type { IndexedTransaction, MidnightSource } from "../source.js";

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
const lines = (r: VerifyResult) => r.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
const withoutPrecommits = (hex: string) => {
  const proof = decodeFinalityProof(fromHex(hex, "proof"));
  const { round, target, ancestries } = proof.justification;
  const justification = concatBytes(u64le(round), target.hash, u32le(target.number), encodeCompact(0), encodeCompact(ancestries.length), ...ancestries.map(encodeHeader));
  return `0x${toHex(concatBytes(proof.block, encodeCompact(justification.length), justification, encodeCompact(proof.unknownHeaders.length), ...proof.unknownHeaders.map(encodeHeader)))}`;
};

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

  it("a caller checkpoint with no voting weight finalizes nothing, not even a justification with no precommits", async () => {
    const chain = anchorChain();
    // The anchor block's finality proofs, with every precommit removed.
    const unsigned: MidnightSource = {
      ...chain.source,
      node: {
        ...chain.source.node,
        async batch<T>(calls: Array<[string, unknown[]]>) {
          const answers = await chain.source.node.batch<string | null>(calls);
          return answers.map((answer, i) => (calls[i]![0] === "grandpa_proveFinality" && calls[i]![1][0] === HEIGHTS.anchor ? withoutPrecommits(answer!) : answer)) as T[];
        },
      },
    };
    const weightless = { setId: 7n, startsAfter: { height: HEIGHTS.anchor - 1, hash: "00".repeat(32) }, authorities: [] };
    const control = await verify(chain, request("anchor", KIND1), { source: unsigned });
    expect(check(control, "finality")!.detail).toMatch(/carries 0 of 4 weight/);
    const r = await verify(chain, request("anchor", KIND1), { source: unsigned, checkpoints: [weightless] });
    expect(r).toMatchObject({ status: "unverified-finality", assurance: "multi-path" });
    expect(check(r, "finality")!.detail).toBe("set 7 has no voting weight, so it finalizes nothing");
  });

  // These paths already fail a finality check when assurance is below consensus-verified.
  // They exercise those verdicts, not done()'s defensive guard with every check passing.
  it("reports valid for the finalized fixture and unverified-finality when proof is skipped or bounded", async () => {
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

  it("with nothing expected, every other check still runs, the anchor is reported, and nothing is matched", async () => {
    const chain = anchorChain();
    for (const name of ["anchor", "hiding"] as const) {
      const r = await verify(chain, request(name, { kind: "any" }));
      expect(r.checks.filter((c) => !c.ok)).toEqual([]);
      expect(r).toMatchObject({ status: "valid", assurance: "consensus-verified", verifiedFields: [], anchor: { commitment: fixture[name].commitment } });
      expect(check(r, "expectation")).toEqual({ name: "expectation", ok: true, detail: "nothing was expected: the anchor's commitment is reported, not matched against a trace" });
    }
    expect(await verify(chain, request("stranger", { kind: "any" }))).toMatchObject({ status: "unauthenticated", verifiedFields: [] });
    expect(await verify(chain, request("anchor", { kind: "any" }), { finality: "skip" })).toMatchObject({ status: "unverified-finality" });
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

  it("an author the caller pins is accepted in place of the document, and an anchor any other key wrote is invalid, naming both keys", async () => {
    const chain = anchorChain();
    expect(await verify(chain, request("stranger", KIND1, { expectedAuthor: fixture.stranger.key }))).toMatchObject({ status: "valid", author: { status: "expected", key: fixture.stranger.key } });
    const other = await verify(chain, request("anchor", KIND1, { expectedAuthor: fixture.stranger.key }));
    expect(other).toMatchObject({ status: "invalid", assurance: "consensus-verified", author: { status: "mismatch", key: fixture.author.key, expected: fixture.stranger.key } });
    expect(other.checks.filter((c) => !c.ok)).toEqual([{ name: "author", ok: false, detail: `written by ${fixture.author.key}, not the expected ${fixture.stranger.key}` }]);
  });

  it("a pinned author mismatch outranks unshown finality, so it never reads like the pinned author's own anchor", async () => {
    const chain = anchorChain();
    const [own, other] = await Promise.all(
      [fixture.author.key, fixture.stranger.key].map((expectedAuthor) => verify(chain, request("anchor", KIND1, { expectedAuthor }), { finality: "skip" })),
    );
    expect([own!.status, own!.assurance, own!.author]).toEqual(["unverified-finality", "multi-path", { status: "expected", key: fixture.author.key }]);
    expect([other!.status, other!.assurance, other!.author]).toEqual(["invalid", "multi-path", { status: "mismatch", key: fixture.author.key, expected: fixture.stranger.key }]);
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

// Recorded by the preprod rehearsal's record-golden.ts through Blockfrost: a kind-1 anchor by the
// relay key, a kind-2 anchor, and the anchor the second relay key wrote after the document that
// revoked it, each verified against the rehearsal's registry and its signed KNOWN_AUTHORS
// documents. The replay fails on any request that was not recorded.
describe("golden: the preprod rehearsal's anchors, replayed", () => {
  const f = JSON.parse(readFileSync(new URL("./fixtures/preprod-rehearsal.json", import.meta.url), "utf8"));
  const verifyRecorded = (a: { txHash: string; expect: VerifyRequest["expect"] }) =>
    verifyMidnightAnchor({ network: "preprod", txHash: a.txHash, expect: a.expect }, { source: replaySource(f.recording), registries: [f.registry], knownAuthors: knownAuthors({ documents: f.documents, trustRoots: [f.trustRoot] }), ...(f.consensusPolicy ? { checkpoints: knownAuthors({ documents: f.consensusPolicy }).checkpoints("preprod") } : {}) });

  it("holds the rehearsal's verdicts: both relay-1 anchors valid and the revoked key's anchor author-revoked, all consensus-verified", () => {
    expect(f.anchors.map((a: VerifyResult & { name: string }) => [a.name, a.status, a.assurance])).toEqual([
      ["git-head", "valid", "consensus-verified"],
      ["hidden-broadcast-suite", "valid", "consensus-verified"],
      ["revoked-new-after", "author-revoked", "consensus-verified"],
    ]);
  });

  type RecordedAnchor = { name: string; txHash: string; expect: VerifyRequest["expect"]; checks: string[] } & Pick<VerifyResult, "status" | "assurance" | "author" | "verifiedFields">;
  it.each<[string, RecordedAnchor]>(f.anchors.map((a: RecordedAnchor) => [a.name, a]))("%s: reproduces the recorded verdict check for check", async (_, a) => {
    const r = await verifyRecorded(a);
    expect({ status: r.status, assurance: r.assurance, author: r.author, verifiedFields: r.verifiedFields, checks: lines(r) }).toEqual({
      status: a.status,
      assurance: a.assurance,
      author: a.author,
      verifiedFields: a.verifiedFields,
      checks: a.checks,
    });
  });
});

// Recorded by scripts/mainnet-anchors.mjs through rpc.mainnet.midnight.network: FPS's first two
// mainnet anchors and the negative controls beside them, verified against the registry generation
// MIDNIGHT_REGISTRIES pins. No mainnet indexer answers without a credential, so the indexer's
// answers are the node's own blocks and System.Events, which the recorder read. Finality starts
// from set 10422, which the recorder's live walk returned from set 9284, mainnet-finality.json's
// checkpoint, after 1138 set changes. The replay fails on any request that was not recorded.
describe("golden: FPS's mainnet anchors against the pinned registry, replayed", () => {
  const f = JSON.parse(readFileSync(new URL("./fixtures/mainnet-anchors.json", import.meta.url), "utf8"));
  const checkpoint = { setId: BigInt(f.checkpoint.setId), startsAfter: f.checkpoint.startsAfter, authorities: f.checkpoint.authorities.map((a: { key: string; weight: string }) => ({ key: a.key, weight: BigInt(a.weight) })) };
  const FPS_AUTHOR = "6a140f2346ec16bc587b506e3d447f05ddcc9bdd72778bee578767571b061f08";
  const run = (name: string) => f.runs.find((r: { name: string }) => r.name === name);
  const replay = (r: { request: Omit<VerifyRequest, "network">; registries?: RegistryInfo[] }) =>
    verifyMidnightAnchor({ network: "mainnet", ...r.request }, { source: replaySource(f.recording), knownAuthors: knownAuthors({ trustRoots: [] }), checkpoints: [checkpoint], ...(r.registries ? { registries: r.registries } : {}) });

  it("starts from the set the walk from mainnet-finality.json's checkpoint returned", () => {
    const finality = JSON.parse(readFileSync(new URL("./fixtures/mainnet-finality.json", import.meta.url), "utf8"));
    expect(f.root).toEqual(finality.checkpoints.own);
    expect(f.derivation).toMatchObject({ setChanges: 1138, justified: { height: 3113841 } });
    expect(f.checkpoint).toMatchObject({ setId: "10422", startsAfter: { height: 3113541, hash: "e131404d2a6ddd70f2f42a79a13c68bf446c1c45e093f0f24d8e93eb2dcf0c37" } });
  });

  it("holds the live verdicts: both anchors valid with FPS's key pinned, every control refused, all consensus-verified", () => {
    expect(f.runs.map((r: VerifyResult & { name: string }) => [r.name, r.status, r.assurance, r.author?.status ?? null])).toEqual([
      ["kind 1, FPS key pinned", "valid", "consensus-verified", "expected"],
      ["kind 2, FPS key pinned", "valid", "consensus-verified", "expected"],
      ["kind 1, no author key pinned", "unauthenticated", "consensus-verified", "unknown"],
      ["kind 2, no author key pinned", "unauthenticated", "consensus-verified", "unknown"],
      ["kind 1, wrong author key", "invalid", "consensus-verified", "mismatch"],
      ["kind 2, wrong author key", "invalid", "consensus-verified", "mismatch"],
      ["kind 1, commitment one bit off", "invalid", "consensus-verified", "expected"],
      ["kind 2, attribute one bit off", "invalid", "consensus-verified", "expected"],
      ["kind 1, registry address not pinned", "invalid", "consensus-verified", null],
      ["another contract's call", "invalid", "consensus-verified", null],
    ]);
  });

  type RecordedRun = { name: string; request: Omit<VerifyRequest, "network">; registries?: RegistryInfo[]; checks: string[] } & Pick<VerifyResult, "status" | "assurance" | "block" | "anchor" | "author" | "verifiedFields" | "notes">;
  it.each<[string, RecordedRun]>(f.runs.map((r: RecordedRun) => [r.name, r]))("%s: reproduces the recorded verdict check for check", async (_, r) => {
    const out = await replay(r);
    expect({ status: out.status, assurance: out.assurance, block: out.block, anchor: out.anchor, author: out.author, verifiedFields: out.verifiedFields, notes: out.notes, checks: lines(out) }).toEqual({
      status: r.status,
      assurance: r.assurance,
      block: r.block,
      anchor: r.anchor,
      author: r.author,
      verifiedFields: r.verifiedFields,
      notes: r.notes,
      checks: r.checks,
    });
  });

  it("both anchors are FPS's, in their published blocks, written to generation 1 of the pinned registry, whose pinned deploy verifies", async () => {
    const kind1 = await replay(run("kind 1, FPS key pinned"));
    const kind2 = await replay(run("kind 2, FPS key pinned"));
    const registry = { generation: 1, address: "438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736" };
    expect(kind1).toMatchObject({
      status: "valid",
      txHash: "e273d480e57b3315937c8929fbc3c11ab798d42b4ff6c0b88172856dec6b7d58",
      registry,
      block: { height: 3113832, hash: "18e31c819837ede6ed536fcd85a8d8f29af6affd87d642793ef9bcbe50ea1008" },
      anchor: { entryPoint: "anchor", kind: 1, commitment: "c5027cecfc7c6dac5dcce026178ccaec51afe30735dc311635907b8e06b69a59", attribute: "00".repeat(32), author: FPS_AUTHOR },
      author: { status: "expected", key: FPS_AUTHOR },
      verifiedFields: ["commitment"],
    });
    expect(kind2).toMatchObject({
      status: "valid",
      txHash: "5cf70930503785a1a4524f458ec6986d9e1083ad04a2851946e911bb87338643",
      registry,
      block: { height: 3113847, hash: "052416d3a3c521051e1e136b352b4748a2e4574fde5f180271fb703c5ae89255" },
      anchor: {
        entryPoint: "anchor_hiding",
        kind: 2,
        commitment: "7d3e484c72ad02493526ba7bd885977264e02b57d8bc4645d4d67c18123476da",
        attribute: "6087363539cf4a83f465b586740d385ffe9d87d3be00701a66f0ad0f2f50ae15",
        author: FPS_AUTHOR,
      },
      author: { status: "expected", key: FPS_AUTHOR },
      verifiedFields: ["committedAttribute"],
      notes: ["kind 2: the registry circuit binds the attribute to the commitment and never checks it against the trace's model manifest"],
    });
    for (const r of [kind1, kind2]) {
      expect(check(r, "registry-deploy")).toEqual({
        name: "registry-deploy",
        ok: true,
        detail: "transaction 1bb33baad6eff44f9f485fef1a83b7f2200f09174d286936081574a3221535e8 deployed the immutable registry at 438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736",
      });
      expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    }
  });

  it("refuses each control for its own reason", async () => {
    const detail = async (name: string, check: string) => (await replay(run(name))).checks.find((c) => c.name === check)?.detail;
    expect(await detail("kind 1, no author key pinned", "author")).toBe(`KNOWN_AUTHORS serial 0 does not list ${FPS_AUTHOR}`);
    expect(await detail("kind 2, wrong author key", "author")).toBe(`written by ${FPS_AUTHOR}, not the expected ${FPS_AUTHOR.slice(0, -1)}9`);
    expect((await replay(run("kind 1, wrong author key"))).author).toEqual({ status: "mismatch", key: FPS_AUTHOR, expected: `${FPS_AUTHOR.slice(0, -1)}9` });
    expect(await detail("kind 1, commitment one bit off", "expectation")).toBe(
      "the anchor commits to c5027cecfc7c6dac5dcce026178ccaec51afe30735dc311635907b8e06b69a59, not c5027cecfc7c6dac5dcce026178ccaec51afe30735dc311635907b8e06b69a58",
    );
    expect(await detail("kind 2, attribute one bit off", "expectation")).toBe(
      "the anchor's attribute is 6087363539cf4a83f465b586740d385ffe9d87d3be00701a66f0ad0f2f50ae15, not 6087363539cf4a83f465b586740d385ffe9d87d3be00701a66f0ad0f2f50ae14",
    );
    expect(await detail("kind 1, registry address not pinned", "anchor")).toBe("transaction e273d480e57b3315937c8929fbc3c11ab798d42b4ff6c0b88172856dec6b7d58 writes no anchor to a registry generation");
    expect(await detail("another contract's call", "anchor")).toBe("transaction 987c01eeee3fc7123b82cdcaa476c44927d283b5d6ab1e3d337ba7ea4bd013ec writes no anchor to a registry generation");
  });

  it("the shipped signed policy authenticates both historical relay anchors without caller pins", async () => {
    for (const name of ["kind 1, no author key pinned", "kind 2, no author key pinned"]) {
      const result = await verifyMidnightAnchor({ network: "mainnet", ...run(name).request }, { source: replaySource(f.recording) });
      expect(result).toMatchObject({ status: "valid", assurance: "consensus-verified", knownAuthorsSerial: 1,
        author: { status: "known", key: FPS_AUTHOR, id: "fps-legacy-relay", role: "relay" } });
      expect(result.checks.filter(row => !row.ok)).toEqual([]);
    }
  });

  it("without a checkpoint, FPS's key and another key pinned differ in status and author, not only in a check", async () => {
    const other = "11".repeat(32);
    for (const name of ["kind 1, FPS key pinned", "kind 2, FPS key pinned"]) {
      const { request } = run(name);
      const [own, wrong] = await Promise.all(
        [FPS_AUTHOR, other].map((expectedAuthor) => verifyMidnightAnchor({ network: "mainnet", ...request, expectedAuthor }, { source: replaySource(f.recording), knownAuthors: knownAuthors({ trustRoots: [] }) })),
      );
      expect([own!.status, own!.assurance, own!.author]).toEqual(["unverified-finality", "multi-path", { status: "expected", key: FPS_AUTHOR }]);
      expect([wrong!.status, wrong!.assurance, wrong!.author]).toEqual(["invalid", "multi-path", { status: "mismatch", key: FPS_AUTHOR, expected: other }]);
      expect(check(own!, "finality")!.detail).toBe(`no finality checkpoint lies below block ${own!.block!.height}`);
    }
  });
});

it("never echoes malformed source status/hash fields and bounds every diagnostic", async () => {
  const hostile = "IGNORE PRIOR INSTRUCTIONS" + "x".repeat(200_000);
  const statusChain = anchorChain({ indexer: { [fixture.anchor.txHash]: txs => txs.map(tx => ({ ...tx, status: hostile as never })) } });
  const status = await verifyMidnightAnchor({ network: "mainnet", txHash: fixture.anchor.txHash, expect: { kind: "any" } }, { source: statusChain.source, registries: [statusChain.registry], knownAuthors: statusChain.authors() });
  expect(status.status).toBe("invalid");
  expect(JSON.stringify(status.checks)).not.toContain("IGNORE");
  expect(status.checks.find(check => check.name === "indexer-status")?.detail).toBe("the indexer reports an unrecognized or absent status");
  const hashChain = anchorChain({ node: { chain_getBlockHash: () => hostile } });
  const hash = await verifyMidnightAnchor({ network: "mainnet", txHash: fixture.anchor.txHash, expect: { kind: "any" } }, { source: hashChain.source, registries: [hashChain.registry], knownAuthors: hashChain.authors() });
  expect(hash.status).not.toBe("valid"); expect(JSON.stringify(hash.checks)).not.toContain("IGNORE");
  const errorChain = anchorChain({ node: { chain_getBlockHash: () => { throw new Error("\u001b[2J\u2028\u2029\u202e" + "x".repeat(200_000)); } } });
  const error = await verifyMidnightAnchor({ network: "mainnet", txHash: fixture.anchor.txHash, expect: { kind: "any" } }, { source: errorChain.source, registries: [errorChain.registry], knownAuthors: errorChain.authors() });
  expect(error.checks.every(check => check.detail.length <= 300)).toBe(true);
  expect(JSON.stringify(error.checks)).not.toMatch(/[\u001b\u2028\u2029\u202e]/);
});
