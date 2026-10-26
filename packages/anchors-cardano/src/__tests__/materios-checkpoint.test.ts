import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeReceiptRecord, manifestHash, merklePath, type CertFormat } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import {
  buildMateriosAnchorV2,
  decodeMateriosAnchorRecord,
  verifyMateriosCheckpointAnchor,
  type MateriosCheckpointClaim,
  type MateriosCheckpointOptions,
  MATERIOS_CHECKPOINT_WALLET_PINS,
} from "../index.js";
import { createKoiosCheckpointSource, createKoiosProvider, KoiosError } from "../providers/index.js";

// Recorded from Cardano mainnet through api.koios.rest by scripts/record-materios-checkpoint.mjs.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/materios-checkpoint-mainnet.json", import.meta.url), "utf8"));
const { wallets, batches, koios } = fixture;
type Batch = "wrapped5" | "wrapped3" | "flat1" | "fallbackLabel1" | "legacyGenesis1";
const genesis = batches.wrapped5.genesis;
// anchor-worker-materios's hard-coded chain id, which it writes when neither the job nor its
// MATERIOS_CHAIN_ID setting names one.
const FALLBACK_CHAIN = "5663079a485b93fdc9e386b862b4cf8d25499427df6b8c5f018535acfd2e5020";
const SCALE: CertFormat = { format: "scale-v1", chainId: null };
const LABEL = "8746";
// The verifier compares addresses as strings, so any string outside the pinned set stands in for a
// wallet nobody pinned.
const FOREIGN_WALLET = "addr1v-not-an-anchor-wallet";

type Answer = unknown;
type Edit = (key: string, answer: Answer) => Answer;

// Replays the recorded Koios answers through the production Koios source; a request that was not
// recorded fails the test.
function replay(edit: Edit = (_, answer) => answer): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)} ${init?.body ?? ""}`;
    if (!Object.hasOwn(koios, key)) throw new Error(`unrecorded Koios request: ${key}`);
    return new Response(JSON.stringify(edit(key, structuredClone(koios[key]))), { status: 200 });
  }) as typeof fetch;
}

// Applies `change` to the tx_info row of `txHash` wherever a recorded answer carries it.
function editTx(txHash: string, change: (row: Record<string, any>) => void): Edit {
  return (key, answer) => {
    if (key.includes("/tx_info") && Array.isArray(answer)) for (const row of answer) if (row.tx_hash === txHash) change(row);
    return answer;
  };
}

function options(over: Partial<MateriosCheckpointOptions> = {}, edit?: Edit): MateriosCheckpointOptions {
  const out = {
    source: createKoiosCheckpointSource({ network: "mainnet", retries: 0, fetchFn: replay(edit) }),
    anchorWallets: MATERIOS_CHECKPOINT_WALLET_PINS,
    ...over,
  };
  // Existing attack vectors select wallet identities; resolve each to its explicit reviewed pin.
  return { ...out, anchorWallets: out.anchorWallets.map((pin) => typeof pin === "string" ? MATERIOS_CHECKPOINT_WALLET_PINS.find((p) => p.address === pin)! : pin) };
}

function receiptFields(receiptId: string) {
  const record = decodeReceiptRecord(Buffer.from(fixture.receipts[receiptId], "hex"));
  return { record, cert: { certFormat: SCALE, contentHash: record.contentHash, baseRootSha256: record.baseRootSha256, storageLocatorHash: record.storageLocatorHash } };
}

function claimFor(name: Batch, over: Partial<MateriosCheckpointClaim> = {}): MateriosCheckpointClaim {
  const b = batches[name];
  return {
    genesis: b.genesis,
    receiptId: b.receiptId,
    cert: receiptFields(b.receiptId).cert,
    certifiedBlock: b.certifiedBlock,
    inclusion: { leafHashes: b.leafHashes },
    manifest: { fromBlock: b.fromBlock, toBlock: b.toBlock },
    cardano: { txHash: b.txHash },
    ...over,
  };
}

// The core encoder rebuilds a dcbor-v1 Cert only for the live genesis, so legacyGenesis1's receipt is
// claimed by its cert hash.
const byCertHash = (name: Batch) => ({ cert: undefined, certHash: receiptFields(batches[name].receiptId).record.availabilityCertHash });

function wrappedEntry(row: Record<string, any>, field: string): Record<string, any> {
  return row.metadata[LABEL].map.find((e: any) => e.k.string === field);
}

const flip = (hex: string) => hex.slice(0, -1) + (Number.parseInt(hex.at(-1)!, 16) ^ 1).toString(16);
const bare = (hex: string) => hex.replace(/^0x/, "");
const recordedRow = (txHash: string) => {
  for (const [key, answer] of Object.entries(koios)) {
    if (!key.includes("/tx_info") || !Array.isArray(answer)) continue;
    const row = (answer as any[]).find((r) => r.tx_hash === txHash);
    if (row) return row;
  }
  throw new Error(`no recorded tx_info row for ${txHash}`);
};

describe("label 8746 decoding of mainnet records", () => {
  it("decodes the detailed-schema record the live worker writes", () => {
    const decoded = decodeMateriosAnchorRecord(recordedRow(batches.wrapped5.txHash).metadata[LABEL]);
    expect(decoded).toEqual({
      ok: true,
      encoding: "detailed-schema",
      record: {
        p: "materios", v: 2, chain: genesis, blocks: [batches.wrapped5.fromBlock, batches.wrapped5.toBlock], leaves: 5,
        root: "63274c072be9336905146221bb950a30434abd363000f9587fea33f390bdb486",
        manifest: "f6fcc52208e8f6c064e114617bd6c4ff9c6d2e0d82e3c4c064afa558a3e42c57",
      },
    });
  });

  it("decodes the flat record the Lucid-based worker wrote, the shape buildMateriosAnchorV2 builds", () => {
    const raw = recordedRow(batches.flat1.txHash).metadata[LABEL];
    const decoded = decodeMateriosAnchorRecord(raw);
    expect(decoded.ok && decoded.encoding).toBe("flat");
    expect(decoded.ok && decoded.record).toEqual(buildMateriosAnchorV2(raw));
  });

  it("refuses the v:3 finality record an anchor wallet wrote under the same label", () => {
    const decoded = decodeMateriosAnchorRecord(recordedRow(fixture.finalityRecordTx).metadata[LABEL]);
    expect(decoded).toEqual({ ok: false, reason: expect.stringMatching(/v 3/) });
  });

  it("refuses a detailed-schema map holding a bare value and a flat record holding a detailed-schema value", () => {
    const wrapped = structuredClone(recordedRow(batches.wrapped5.txHash).metadata[LABEL]);
    wrapped.map.find((e: any) => e.k.string === "leaves").v = 5;
    expect(decodeMateriosAnchorRecord(wrapped)).toEqual({ ok: false, reason: expect.stringMatching(/leaves.*detailed-schema/) });

    const flat = structuredClone(recordedRow(batches.flat1.txHash).metadata[LABEL]);
    flat.root = { string: flat.root };
    expect(decodeMateriosAnchorRecord(flat)).toEqual({ ok: false, reason: expect.stringMatching(/root.*flat/) });

    const keyless = structuredClone(recordedRow(batches.wrapped5.txHash).metadata[LABEL]);
    keyless.map[0].k = "p";
    expect(decodeMateriosAnchorRecord(keyless)).toEqual({ ok: false, reason: expect.stringMatching(/key/) });

    const quoted = structuredClone(recordedRow(batches.wrapped5.txHash).metadata[LABEL]);
    quoted.map.find((e: any) => e.k.string === "leaves").v = { int: "5" };
    expect(decodeMateriosAnchorRecord(quoted)).toEqual({ ok: false, reason: expect.stringMatching(/leaves.*detailed-schema/) });

    const twoTyped = structuredClone(recordedRow(batches.wrapped5.txHash).metadata[LABEL]);
    twoTyped.map.find((e: any) => e.k.string === "p").v = { string: "materios", int: 2 };
    expect(decodeMateriosAnchorRecord(twoTyped)).toEqual({ ok: false, reason: expect.stringMatching(/"p".*detailed-schema/) });

    const beside = { ...structuredClone(recordedRow(batches.wrapped5.txHash).metadata[LABEL]), p: "materios", v: 2 };
    expect(decodeMateriosAnchorRecord(beside)).toEqual({ ok: false, reason: expect.stringMatching(/unexpected field "map"/) });
  });

  it("refuses duplicated, unknown, missing and malformed fields", () => {
    const wrapped = () => structuredClone(recordedRow(batches.wrapped5.txHash).metadata[LABEL]);
    const flat = () => structuredClone(recordedRow(batches.flat1.txHash).metadata[LABEL]);
    const duplicated = wrapped();
    duplicated.map.push({ k: { string: "root" }, v: { string: "00".repeat(32) } });
    const widened = wrapped();
    widened.map[0].extra = 1;
    const cases: [unknown, RegExp][] = [
      [duplicated, /root.*twice/],
      [widened, /entry/],
      [{ ...flat(), extra: 1 }, /extra/],
      [(({ manifest: _, ...rest }) => rest)(flat()), /missing field manifest/],
      [{ ...flat(), root: `0x${flat().root}` }, /root/],
      [{ ...flat(), root: flat().root.toUpperCase() }, /root/],
      [{ ...flat(), blocks: [2, 1] }, /blocks/],
      [{ ...flat(), blocks: [-1, 2] }, /blocks/],
      [{ ...flat(), blocks: [1, 2, 3] }, /blocks/],
      [{ ...flat(), blocks: [1, 2 ** 53] }, /blocks/],
      [{ ...flat(), leaves: 0 }, /leaves/],
      [{ ...flat(), p: "other" }, /p "other"/],
      [null, /object/],
      [[flat()], /object/],
    ];
    for (const [value, reason] of cases) expect(decodeMateriosAnchorRecord(value)).toEqual({ ok: false, reason: expect.stringMatching(reason) });
  });
});

describe("manifest hash golden vectors from mainnet", () => {
  const onChain = (name: Batch) => {
    const decoded = decodeMateriosAnchorRecord(recordedRow(batches[name].txHash).metadata[LABEL]);
    if (!decoded.ok) throw new Error(decoded.reason);
    return decoded.record;
  };
  for (const name of Object.keys(batches) as Batch[]) {
    it(`reproduces the daemon's Python json.dumps preimage byte for byte (${name})`, () => {
      const b = batches[name];
      const record = onChain(name);
      expect(createHash("sha256").update(b.manifestPreimage, "utf8").digest("hex")).toBe(record.manifest);
      const fields = { cardano_network_id: "", count: b.leafHashes.length, from_block: b.fromBlock, materios_chain_id: b.genesis, root: record.root, to_block: b.toBlock };
      expect(bare(manifestHash(fields))).toBe(record.manifest);
    });
  }

  it("commits to the genesis that two windows of genuine records name wrongly in their chain field", () => {
    expect([onChain("fallbackLabel1").chain, batches.fallbackLabel1.genesis]).toEqual([FALLBACK_CHAIN, genesis]);
    expect([onChain("legacyGenesis1").chain, batches.legacyGenesis1.genesis]).toEqual([genesis, "bc0531cb311281565036fb397a376f0e0fa37005589655f97a7924b2729a164c"]);
    for (const name of ["fallbackLabel1", "legacyGenesis1"] as const) {
      expect(batches[name].manifestPreimage).toContain(`"materios_chain_id": "${batches[name].genesis}"`);
    }
  });
});

describe("verifyMateriosCheckpointAnchor against mainnet anchors", () => {
  it("verifies a receipt in a five-leaf detailed-schema anchor from its receipt fields and leaf list", async () => {
    const { record } = receiptFields(batches.wrapped5.receiptId);
    const r = await verifyMateriosCheckpointAnchor(claimFor("wrapped5"), options());
    expect(r.refusal).toBeNull();
    expect(r.verified).toBe(true);
    expect(r.encoding).toBe("detailed-schema");
    expect(r.certHash).toBe(record.availabilityCertHash);
    expect(r.rootHash).toBe("0x63274c072be9336905146221bb950a30434abd363000f9587fea33f390bdb486");
    expect(r.anchorId).toBe(batches.wrapped5.anchorId);
    expect(r.txHash).toBe(batches.wrapped5.txHash);
    const tip = koios["GET https://api.koios.rest/api/v1/tip "][0].block_height;
    expect(r.blockHeight).toBe(recordedRow(batches.wrapped5.txHash).block_height);
    expect(r.confirmations).toBe(tip - r.blockHeight! + 1);
    expect(r.confirmations).toBeGreaterThanOrEqual(15);
    expect(r.checks.map((c) => c.name)).toEqual(["input", "leaf", "root", "anchor_id", "tx", "wallet", "record", "anchored_root", "leaves", "blocks", "manifest", "confirmations"]);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("verifies the same receipt from its cert hash and a Merkle path, cross-checking the Materios anchor id", async () => {
    const b = batches.wrapped5;
    const index = b.leafHashes.indexOf(bare(b.leaf));
    const { record } = receiptFields(b.receiptId);
    const claim = claimFor("wrapped5", { cert: undefined, certHash: record.availabilityCertHash, anchorId: b.anchorId,
      inclusion: { index, count: b.leafHashes.length, path: merklePath(b.leafHashes, index) } });
    const r = await verifyMateriosCheckpointAnchor(claim, options());
    expect(r.verified).toBe(true);
    expect(r.leaf).toBe(b.leaf);
  });

  it("verifies the last leaf of a three-leaf anchor from a Merkle path", async () => {
    const b = batches.wrapped3;
    const { record } = receiptFields(b.receiptId);
    const claim = claimFor("wrapped3", { cert: undefined, certHash: record.availabilityCertHash, inclusion: { index: 2, count: 3, path: merklePath(b.leafHashes, 2) } });
    const r = await verifyMateriosCheckpointAnchor(claim, options());
    expect(r.refusal).toBeNull();
    expect(r.anchorId).toBe(b.anchorId);
  });

  it("verifies a receipt in a flat anchor the Lucid-based worker wrote", async () => {
    const r = await verifyMateriosCheckpointAnchor(claimFor("flat1"), options());
    expect(r.refusal).toBeNull();
    expect(r.encoding).toBe("flat");
    expect(r.rootHash).toBe(`0x${batches.flat1.leafHashes[0]}`);
  });

  it("verifies a receipt in a detailed-schema anchor whose chain field names the worker's fallback chain id", async () => {
    const r = await verifyMateriosCheckpointAnchor(claimFor("fallbackLabel1"), options());
    expect(r.refusal).toBeNull();
    expect(r.encoding).toBe("detailed-schema");
    expect(r.checks.find((c) => c.name === "record")?.detail).toContain(`chain ${FALLBACK_CHAIN}`);
    expect(r.checks.find((c) => c.name === "manifest")?.detail).toContain(`genesis ${genesis}`);
  });

  it("verifies a receipt whose leaf and manifest commit to the earlier genesis, in a flat anchor naming the live one", async () => {
    const b = batches.legacyGenesis1;
    const r = await verifyMateriosCheckpointAnchor(claimFor("legacyGenesis1", byCertHash("legacyGenesis1")), options());
    expect(r.refusal).toBeNull();
    expect(r.encoding).toBe("flat");
    expect(r.checks.find((c) => c.name === "manifest")?.detail).toContain(`genesis ${b.genesis}`);
  });

  it("finds the anchor by scanning the pinned wallets from a Cardano height", async () => {
    const r = await verifyMateriosCheckpointAnchor(claimFor("wrapped5", { cardano: { scanFromBlockHeight: fixture.scanFromBlockHeight } }), options());
    expect(r.refusal).toBeNull();
    expect(r.txHash).toBe(batches.wrapped5.txHash);
    const reordered = await verifyMateriosCheckpointAnchor(claimFor("wrapped5", { cardano: { scanFromBlockHeight: fixture.scanFromBlockHeight } }), options({ anchorWallets: [wallets.lucid, wallets.worker] }));
    expect(reordered.txHash).toBe(batches.wrapped5.txHash);
  });

  it("reads hashes in either case, with or without 0x", async () => {
    const b = batches.wrapped5;
    const upper = (hex: string) => `0x${bare(hex).toUpperCase()}`;
    const claim = claimFor("wrapped5", { genesis: upper(genesis), receiptId: upper(b.receiptId), anchorId: upper(b.anchorId), cardano: { txHash: upper(b.txHash) } });
    const r = await verifyMateriosCheckpointAnchor(claim, options());
    expect(r.refusal).toBeNull();
    expect(r.txHash).toBe(b.txHash);
  });

  it("takes the earliest scanned anchor that passes every check, and the earliest refusal when none does", async () => {
    const scan = claimFor("wrapped5", { cardano: { scanFromBlockHeight: fixture.scanFromBlockHeight } });
    const earliest = batches.wrapped5.txHash;
    const later = fixture.scanLaterTx;
    const reanchored = editTx(later, (row) => row.metadata = structuredClone(recordedRow(earliest).metadata));
    const reversed: Edit = (key, answer) => (key.includes("/tx_info") && Array.isArray(answer) ? answer.reverse() : answer);
    const forge = (txHash: string) => editTx(txHash, (row) => row.inputs[0].payment_addr.bech32 = FOREIGN_WALLET);

    const both = await verifyMateriosCheckpointAnchor(scan, options({}, combine(reanchored, reversed)));
    expect([both.verified, both.txHash]).toEqual([true, earliest]);
    const second = await verifyMateriosCheckpointAnchor(scan, options({}, combine(reanchored, forge(earliest))));
    expect([second.verified, second.txHash]).toEqual([true, later]);
    expect(second.checks.filter((c) => c.name === "wallet")).toHaveLength(1);
    const neither = await verifyMateriosCheckpointAnchor(scan, options({}, combine(reanchored, forge(earliest), forge(later), reversed)));
    expect([neither.refusal?.check, neither.txHash]).toEqual(["wallet", earliest]);
  });
});

function combine(...edits: Edit[]): Edit {
  return (key, answer) => edits.reduce((current, edit) => edit(key, current), answer);
}

describe("refusals", () => {
  const refusedBy = async (claim: MateriosCheckpointClaim, opts: MateriosCheckpointOptions = options()) => {
    const r = await verifyMateriosCheckpointAnchor(claim, opts);
    expect(r.verified).toBe(false);
    expect(r.checks.at(-1)).toEqual({ name: r.refusal?.check, ok: false, detail: r.refusal?.reason });
    return r.refusal?.check;
  };
  const wrapped5 = batches.wrapped5;
  const at = (b: { leafHashes: string[]; leaf: string }) => b.leafHashes.indexOf(bare(b.leaf));

  it("receipt fields that are not the receipt's: the rebuilt cert, and so the leaf, differ", async () => {
    const { cert } = receiptFields(wrapped5.receiptId);
    for (const field of ["contentHash", "baseRootSha256", "storageLocatorHash"] as const) {
      expect(await refusedBy(claimFor("wrapped5", { cert: { ...cert, [field]: flip(cert[field]) } }))).toBe("leaf");
    }
  });

  it("a flipped leaf: the receipt's own leaf missing from the list, or another leaf changed", async () => {
    const own = [...wrapped5.leafHashes];
    own[at(wrapped5)] = flip(own[at(wrapped5)]);
    expect(await refusedBy(claimFor("wrapped5", { inclusion: { leafHashes: own } }))).toBe("leaf");
    const other = [...wrapped5.leafHashes];
    other[0] = flip(other[0]);
    expect(await refusedBy(claimFor("wrapped5", { inclusion: { leafHashes: other } }))).toBe("anchored_root");
    const { record } = receiptFields(wrapped5.receiptId);
    const path = merklePath(wrapped5.leafHashes, at(wrapped5));
    const flippedCert = claimFor("wrapped5", { cert: undefined, certHash: flip(record.availabilityCertHash), inclusion: { index: at(wrapped5), count: 5, path } });
    expect(await refusedBy(flippedCert)).toBe("anchored_root");
  });

  it("a wrong count: [a,b,c,c] has the root of [a,b,c] and is refused on the anchored leaf count", async () => {
    const b = batches.wrapped3;
    const { record } = receiptFields(b.receiptId);
    const padded = [...b.leafHashes, b.leafHashes[2]];
    const byList = await verifyMateriosCheckpointAnchor(claimFor("wrapped3", { inclusion: { leafHashes: padded } }), options());
    expect(byList.rootHash).toBe(`0x${b.rootHash}`);
    expect(byList.checks.find((c) => c.name === "leaf")?.detail).toMatch(/is leaf 2 of 4$/);
    expect(byList.refusal?.check).toBe("leaves");
    const byPath = claimFor("wrapped3", { cert: undefined, certHash: record.availabilityCertHash, inclusion: { index: 2, count: 4, path: merklePath(padded, 2) } });
    expect(await refusedBy(byPath)).toBe("leaves");
    const oddSibling = claimFor("wrapped3", { cert: undefined, certHash: record.availabilityCertHash, inclusion: { index: 2, count: 3, path: [b.leafHashes[0], b.leafHashes[0]] } });
    expect(await refusedBy(oddSibling)).toBe("root");
  });

  it("an unpinned wallet: the flat anchor's wallet left out of the pinned set, or a forged funding input", async () => {
    expect(await refusedBy(claimFor("flat1"), options({ anchorWallets: [wallets.worker] }))).toBe("wallet");
    const forged = editTx(wrapped5.txHash, (row) => row.inputs[0].payment_addr.bech32 = FOREIGN_WALLET);
    expect(await refusedBy(claimFor("wrapped5"), options({}, forged))).toBe("wallet");
    const unfunded = editTx(wrapped5.txHash, (row) => row.inputs = []);
    expect(await refusedBy(claimFor("wrapped5"), options({}, unfunded))).toBe("wallet");
    const flat1 = batches.flat1.txHash;
    expect(recordedRow(flat1).inputs).toHaveLength(2);
    const coFunded = editTx(flat1, (row) => row.inputs[1].payment_addr.bech32 = FOREIGN_WALLET);
    expect(await refusedBy(claimFor("flat1"), options({}, coFunded))).toBe("wallet");
  });

  it("a v:3 record, an absent label and a flat vs wrapped mismatch", async () => {
    expect(await refusedBy(claimFor("wrapped5", { cardano: { txHash: fixture.finalityRecordTx } }))).toBe("record");
    const absent = editTx(wrapped5.txHash, (row) => delete row.metadata[LABEL]);
    const unlabelled = await verifyMateriosCheckpointAnchor(claimFor("wrapped5"), options({}, absent));
    expect(unlabelled.refusal).toEqual({ check: "record", reason: expect.stringMatching(/no label 8746/) });
    const mixed = editTx(wrapped5.txHash, (row) => wrappedEntry(row, "root").v = wrappedEntry(row, "root").v.string);
    expect(await refusedBy(claimFor("wrapped5"), options({}, mixed))).toBe("record");
  });

  it("an anchor record that differs from the claim in any one field but its chain label", async () => {
    const field = (name: string, value: unknown) => editTx(wrapped5.txHash, (row) => wrappedEntry(row, name).v = value);
    const relabelled = await verifyMateriosCheckpointAnchor(claimFor("wrapped5"), options({}, field("chain", { string: flip(genesis) })));
    expect([relabelled.verified, relabelled.checks.find((c) => c.name === "record")?.detail]).toEqual([true, expect.stringContaining(`chain ${flip(genesis)}`)]);
    expect(await refusedBy(claimFor("wrapped5"), options({}, field("root", { string: flip(batches.wrapped5.rootHash) })))).toBe("anchored_root");
    expect(await refusedBy(claimFor("wrapped5"), options({}, field("leaves", { int: 6 })))).toBe("leaves");
    expect(await refusedBy(claimFor("wrapped5"), options({}, field("blocks", { list: [{ int: wrapped5.fromBlock }, { int: wrapped5.toBlock + 1 }] })))).toBe("blocks");
    expect(await refusedBy(claimFor("wrapped5", { certifiedBlock: wrapped5.toBlock + 1 }))).toBe("blocks");
    expect(await refusedBy(claimFor("wrapped5", { manifest: { fromBlock: wrapped5.fromBlock, toBlock: wrapped5.toBlock, cardanoNetworkId: "mainnet" } }))).toBe("manifest");
  });

  it("a record whose manifest commits to the chain its label names, and a receipt claimed for that chain", async () => {
    const b = batches.fallbackLabel1;
    const labelled = { cardano_network_id: "", count: 1, from_block: b.fromBlock, materios_chain_id: FALLBACK_CHAIN, root: b.rootHash, to_block: b.toBlock };
    const rebound = editTx(b.txHash, (row) => wrappedEntry(row, "manifest").v = { string: bare(manifestHash(labelled)) });
    expect(await refusedBy(claimFor("fallbackLabel1"), options({}, rebound))).toBe("manifest");
    expect(await refusedBy(claimFor("fallbackLabel1", { genesis: FALLBACK_CHAIN, ...byCertHash("fallbackLabel1") }))).toBe("leaf");
    expect(await refusedBy(claimFor("legacyGenesis1", { genesis, ...byCertHash("legacyGenesis1") }))).toBe("leaf");
  });

  it("a claimed anchor id that the root and manifest do not produce", async () => {
    expect(await refusedBy(claimFor("wrapped5", { anchorId: flip(wrapped5.anchorId) }))).toBe("anchor_id");
  });

  it("fewer than 15 confirmations by default, counting the tx's own block", async () => {
    const height = recordedRow(wrapped5.txHash).block_height;
    const tipAt = (confirmations: number): Edit => (key, answer) => (key.endsWith("/tip ") ? [{ block_height: height + confirmations - 1 }] : answer);
    expect(await refusedBy(claimFor("wrapped5"), options({}, tipAt(14)))).toBe("confirmations");
    const settled = await verifyMateriosCheckpointAnchor(claimFor("wrapped5"), options({}, tipAt(15)));
    expect([settled.verified, settled.confirmations]).toEqual([true, 15]);
  });

  it("too few confirmations, and a tx Cardano does not have in a block", async () => {
    const settled = await verifyMateriosCheckpointAnchor(claimFor("wrapped5"), options());
    expect(await refusedBy(claimFor("wrapped5"), options({ minConfirmations: settled.confirmations! + 1 }))).toBe("confirmations");
    expect(await refusedBy(claimFor("wrapped5"), options({}, editTx(wrapped5.txHash, (row) => row.block_height = null)))).toBe("tx");
    const missing: Edit = (key, answer) => (key.includes("/tx_info") ? [] : answer);
    expect(await refusedBy(claimFor("wrapped5"), options({}, missing))).toBe("tx");
    const substituted = editTx(wrapped5.txHash, (row) => row.tx_hash = fixture.scanLaterTx);
    expect(await refusedBy(claimFor("wrapped5"), options({}, substituted))).toBe("tx");
  });

  it("a scan that finds no pinned-wallet anchor of the root", async () => {
    const scan = claimFor("wrapped5", { cardano: { scanFromBlockHeight: fixture.scanFromBlockHeight } });
    const r = await verifyMateriosCheckpointAnchor(scan, options({ anchorWallets: [wallets.lucid] }));
    expect(r.refusal?.check).toBe("tx");
    const others: Edit = (key, answer) => (key.includes("/tx_info") && Array.isArray(answer) ? answer.filter((row) => row.tx_hash !== wrapped5.txHash) : answer);
    const elsewhere = await verifyMateriosCheckpointAnchor(scan, options({}, others));
    expect([elsewhere.refusal?.check, elsewhere.txHash]).toEqual(["tx", null]);
  });

  it("malformed input", async () => {
    const { record } = receiptFields(wrapped5.receiptId);
    const cases: [Partial<MateriosCheckpointClaim>, RegExp][] = [
      [{ certHash: record.availabilityCertHash }, /exactly one/],
      [{ cert: undefined }, /exactly one/],
      [{ genesis: "00" }, /genesis/],
      [{ receiptId: `0x${"g".repeat(64)}` }, /receiptId/],
      [{ certifiedBlock: -1 }, /certifiedBlock/],
      [{ manifest: { fromBlock: 5, toBlock: 4 } }, /fromBlock/],
      [{ manifest: { fromBlock: 1.5, toBlock: 4 } }, /fromBlock/],
      [{ manifest: { fromBlock: 1, toBlock: -4 } }, /toBlock/],
      [{ manifest: { fromBlock: wrapped5.fromBlock, toBlock: wrapped5.toBlock, cardanoNetworkId: 1 as unknown as string } }, /cardanoNetworkId/],
      [{ inclusion: { leafHashes: [] } }, /leafHashes/],
      [{ inclusion: { leafHashes: ["zz"] } }, /leafHashes\[0\]/],
      [{ inclusion: { index: 5, count: 5, path: [] } }, /index/],
      [{ inclusion: { index: 0, count: 0, path: [] } }, /inclusion.count is not an integer of at least 1/],
      [{ inclusion: { index: 0, count: 2, path: ["zz"] } }, /path\[0\]/],
      [{ inclusion: { index: 0, count: 2, path: "zz" as unknown as string[] } }, /path/],
      [{ inclusion: undefined }, /inclusion/],
      [{ manifest: undefined }, /manifest/],
      [{ cardano: undefined }, /cardano/],
      [{ cert: { ...receiptFields(wrapped5.receiptId).cert, certFormat: { format: "dcbor-v1", chainId: null } } }, /cert/],
      [{ anchorId: "zz" }, /anchorId/],
      [{ cardano: { txHash: "abc" } }, /txHash/],
      [{ cardano: { scanFromBlockHeight: -1 } }, /scanFromBlockHeight/],
    ];
    for (const [over, reason] of cases) {
      const r = await verifyMateriosCheckpointAnchor(claimFor("wrapped5", over), options());
      expect(r.refusal).toEqual({ check: "input", reason: expect.stringMatching(reason) });
    }
    for (const over of [{ anchorWallets: [] }, { anchorWallets: [""] }, { minConfirmations: 0 }, { minConfirmations: 1.5 }]) {
      const r = await verifyMateriosCheckpointAnchor(claimFor("wrapped5"), options(over));
      expect(r.refusal?.check).toBe("input");
    }
  });
});

describe("Koios checkpoint source", () => {
  const answering = (answers: unknown[], seen: string[] = []) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(input)} ${init?.body ?? ""}`);
      return new Response(JSON.stringify(answers.shift()), { status: 200 });
    }) as typeof fetch;

  it("pages an address's transactions until Koios returns an empty page", async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ tx_hash: (from + i).toString(16).padStart(64, "0") }));
    const seen: string[] = [];
    const source = createKoiosCheckpointSource({ network: "mainnet", retries: 0, fetchFn: answering([page(1000, 0), page(3, 1000), []], seen) });
    expect(await source.addressTransactions(wallets.worker, 7)).toHaveLength(1003);
    expect(seen.map((s) => s.split(" ")[0])).toEqual([0, 1000, 1003].map((o) => `https://api.koios.rest/api/v1/address_txs?offset=${o}`));
    expect(JSON.parse(seen[0]!.split(" ")[1]!)).toEqual({ _addresses: [wallets.worker], _after_block_height: 7 });
  });

  it("rejects a repeated page before unbounded pagination can consume memory", async () => {
    const row = { tx_hash: "ab".repeat(32) };
    const seen: string[] = [];
    const source = createKoiosCheckpointSource({ network: "mainnet", retries: 0, fetchFn: answering([[row], [row]], seen) });
    await expect(source.addressTransactions(wallets.worker, 0)).rejects.toThrow(/repeated.*pagination/);
    expect(seen).toHaveLength(2);
  });

  it("throws on an answer that drifted from what Koios sends, rather than reporting a mismatch", async () => {
    const row = structuredClone(recordedRow(batches.wrapped5.txHash));
    const broken = [{ ...row, tx_hash: undefined }, { ...row, inputs: undefined }, { ...row, metadata: "x" }, { ...row, block_height: "1" }, { ...row, inputs: [{}] }];
    for (const answer of [...broken.map((b) => [b]), { rows: [row] }]) {
      const source = createKoiosCheckpointSource({ network: "mainnet", retries: 0, fetchFn: answering([answer]) });
      await expect(source.transactions([row.tx_hash])).rejects.toBeInstanceOf(KoiosError);
    }
    for (const answer of [{ rows: [] }, [{ block_height: 1 }]]) {
      const source = createKoiosCheckpointSource({ network: "mainnet", retries: 0, fetchFn: answering([answer, []]) });
      await expect(source.addressTransactions(wallets.worker, 0)).rejects.toBeInstanceOf(KoiosError);
    }
    const tipless = createKoiosCheckpointSource({ network: "mainnet", retries: 0, fetchFn: answering([[{}]]) });
    await expect(tipless.tipHeight()).rejects.toBeInstanceOf(KoiosError);
  });

  it("asks for at most fifty transactions per tx_info request", async () => {
    const seen: string[] = [];
    const hashes = Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(64, "0"));
    const source = createKoiosCheckpointSource({ network: "mainnet", retries: 0, fetchFn: answering([[], []], seen) });
    expect(await source.transactions(hashes)).toEqual([]);
    expect(seen.map((s) => JSON.parse(s.slice(s.indexOf(" ") + 1))._tx_hashes.length)).toEqual([50, 1]);
  });

  it("shares its transport with createKoiosProvider, whose confirmations read the tip's block_height", async () => {
    const seen: string[] = [];
    const row = { tx_hash: "ab".repeat(32), block_hash: "cd".repeat(32), block_height: 100, absolute_slot: 7, tx_timestamp: 1 };
    const provider = createKoiosProvider({ network: "mainnet", baseUrl: "https://koios.example/api/v1", retries: 0, fetchFn: answering([[row], [{ block_height: 130 }]], seen) });
    expect((await provider.getTxInfo(row.tx_hash))?.confirmations).toBe(30);
    expect(seen.map((s) => s.split(" ")[0])).toEqual(["https://koios.example/api/v1/tx_info", "https://koios.example/api/v1/tip"]);
  });

  it("reads a Koios-compatible endpoint other than the public one", async () => {
    const seen: string[] = [];
    const source = createKoiosCheckpointSource({ network: "mainnet", baseUrl: "https://koios.example/api/v1", retries: 0, fetchFn: answering([[{ block_height: 9 }]], seen) });
    expect(await source.tipHeight()).toBe(9);
    expect(seen[0]).toMatch(/^https:\/\/koios\.example\/api\/v1\/tip /);
  });
});
