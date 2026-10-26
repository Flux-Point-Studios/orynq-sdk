import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as L from "@midnight-ntwrk/ledger-v8";
import { chainView, MIDNIGHT_GENESIS_HASHES, openJournal, type AnchorKey } from "../src/journal.js";
import { fixture } from "../src/__tests__/anchor-chain.js";
import { headerHash, midnightExtrinsic, orderedTrieRoot, type BlockHeader } from "../src/substrate.js";
import type { MidnightSource } from "../src/source.js";
import { toHex, u64le } from "../src/scale.js";
const root = mkdtempSync(join(tmpdir(), "journal-canonical-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let index = 0;
const key: AnchorKey = { network: "preprod", registry: fixture.registry.address, author: fixture.author.key, kind: 1, commitment: fixture.anchor.commitment, attribute: "00".repeat(32) };
const bytes = () => new Uint8Array(Buffer.from(fixture.anchor.tx, "hex"));
const ttl = new Date("2030-01-01T00:00:00Z");
function source() {
  let tip = 1, clock = ttl.getTime() - 60_000;
  let genesis = MIDNIGHT_GENESIS_HASHES.preprod;
  let status: "SUCCESS" | "PARTIAL_SUCCESS" | "FAILURE" | null = "SUCCESS", listed = false;
  const bodies = new Map<number, Uint8Array[]>(), reads: number[] = [];
  let mutateBody = false, badTimestamp: string | null | undefined;
  const blocks = () => {
    const out = new Map<number, { hash: string; header: BlockHeader }>();
    let parent = genesis!;
    for (let height = 1; height <= tip; height++) {
      const header: BlockHeader = { parentHash: Buffer.from(parent, "hex"), number: height, stateRoot: new Uint8Array(32).fill(height), extrinsicsRoot: orderedTrieRoot(bodies.get(height) ?? []), digest: [] };
      const hash = toHex(headerHash(header)); out.set(height, { hash, header }); parent = hash;
    }
    return out;
  };
  const get = (height: number) => blocks().get(height)!;
  const headerJson = (header: BlockHeader) => ({ parentHash: `0x${toHex(header.parentHash)}`, number: `0x${header.number.toString(16)}`, stateRoot: `0x${toHex(header.stateRoot)}`, extrinsicsRoot: `0x${toHex(header.extrinsicsRoot)}`, digest: { logs: [] } });
  const call = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const heightOf = (at: unknown) => [...blocks()].find(([, b]) => `0x${b.hash}` === at)?.[0];
    if (method === "chain_getBlockHash") return (params[0] === 0 ? `0x${genesis}` : `0x${get(params[0] as number).hash}`) as T;
    if (method === "chain_getFinalizedHead") return `0x${get(tip).hash}` as T;
    if (method === "chain_getHeader") return headerJson(get(heightOf(params[0])!).header) as T;
    if (method === "state_getStorage") return (badTimestamp === undefined ? `0x${toHex(u64le(BigInt(clock)))}` : badTimestamp) as T;
    if (method === "state_getRuntimeVersion") return { specVersion: 1000300 } as T;
    if (method === "chain_getBlock") {
      const height = heightOf(params[0])!; reads.push(height);
      return { block: { header: headerJson(get(height).header), extrinsics: (mutateBody ? [] : bodies.get(height) ?? []).map(raw => `0x${toHex(raw)}`) } } as T;
    }
    throw new Error(`Unexpected synthetic node method ${method}`);
  };
  const s = { operator: "synthetic", node: { call }, indexer: {
    transactions: async () => listed ? [{ hash: fixture.anchor.txHash, raw: fixture.anchor.tx, block: { height: 2, hash: get(2).hash, timestamp: clock }, status, contractActions: [] }] : [],
    head: async () => ({ height: 999999, hash: "ff".repeat(32), timestamp: ttl.getTime() + 365 * 24 * 3600_000 }),
  } } as unknown as MidnightSource;
  return { s, reads, block: get, head: (height: number, time = clock) => { tip = height; clock = time; }, body: (height: number, raw: Uint8Array[]) => bodies.set(height, raw), list: (value: typeof status) => { listed = true; status = value; }, foreign: () => { genesis = "ab".repeat(32); }, corrupt: () => { mutateBody = true; }, timestamp: (raw: string | null) => { badTimestamp = raw; } };
}

describe("node-confirmed finalized journal retirement", () => {
  it("uses finalized node time, never a future indexer clock", async () => {
    const net = source(); const view = chainView(net.s, "preprod");
    expect(await view.indexedThrough()).toEqual({ height: 1, hash: net.block(1).hash, time: new Date(ttl.getTime() - 60_000) });
  });
  it("binds every view to its pinned chain before reading or settling", async () => {
    const net = source(); net.foreign();
    await expect(chainView(net.s, "preprod").indexedThrough()).rejects.toThrow("not the pinned preprod");
    await expect(chainView(net.s, "preprod").lookup(fixture.anchor.txHash)).rejects.toThrow("not the pinned preprod");
  });
  it.each([null, "0x00", `0x${toHex(u64le(1n))}00`])("rejects missing or malformed finalized timestamps: %s", async raw => {
    const net = source(); net.timestamp(raw);
    await expect(chainView(net.s, "preprod").indexedThrough()).rejects.toThrow(/Timestamp.Now/);
  });
  it.each(["FAILURE", "PARTIAL_SUCCESS", null])("node inclusion keeps a guaranteed anchor landed despite indexer status %s", async status => {
    const net = source(), view = chainView(net.s, "preprod");
    const journal = openJournal(join(root, `${index++}.sqlite`));
    await journal.submitOnce(key, { prepare: async () => ({ bytes: bytes(), ttl }), broadcast: async () => { net.body(2, [midnightExtrinsic(bytes())]); net.head(3); net.list(status); }, chain: view });
    expect(await journal.reconcile(view)).toEqual([expect.objectContaining({ state: "landed", txHash: fixture.anchor.txHash, height: 2 })]);
    journal.close();
  });
  it("finds an anchor a stale lookup omits and never prepares a duplicate", async () => {
    const net = source(), view = chainView(net.s, "preprod"); const journal = openJournal(join(root, `${index++}.sqlite`)); let prepared = 0;
    await journal.submitOnce(key, { prepare: async () => { prepared++; return { bytes: bytes(), ttl }; }, broadcast: async () => { net.body(2, [midnightExtrinsic(bytes())]); net.head(3, ttl.getTime() + 3600_000); }, chain: view });
    const row = await journal.submitOnce(key, { prepare: async () => { prepared++; throw new Error("duplicate"); }, broadcast: async () => { throw new Error("duplicate"); }, chain: view });
    expect(row.state).toBe("landed"); expect(prepared).toBe(1); journal.close();
  });
  it("persists a bounded complete absence scan across process restarts before freeing a key", async () => {
    const net = source(), view = chainView(net.s, "preprod", { maxScanBlocks: 1 }); const file = join(root, `${index++}.sqlite`);
    let journal = openJournal(file);
    await journal.submitOnce(key, { prepare: async () => ({ bytes: bytes(), ttl }), broadcast: async () => { net.head(5, ttl.getTime() + 3600_000); }, chain: view });
    for (let turn = 0; turn < 4; turn++) { await journal.reconcile(view); expect(journal.live(key)?.state).toBe("pending"); journal.close(); journal = openJournal(file); }
    await journal.reconcile(view);
    expect(journal.live(key)).toBeUndefined(); expect(net.reads).toEqual([1, 2, 3, 4, 5]); journal.close();
  });
  it("never retires from a body that does not match its header's extrinsics root", async () => {
    const net = source(), view = chainView(net.s, "preprod"); const journal = openJournal(join(root, `${index++}.sqlite`));
    await journal.submitOnce(key, { prepare: async () => ({ bytes: bytes(), ttl }), broadcast: async () => { net.body(2, [midnightExtrinsic(bytes())]); net.head(3, ttl.getTime() + 3600_000); net.corrupt(); }, chain: view });
    await expect(journal.reconcile(view)).rejects.toThrow("header/body root"); expect(journal.live(key)?.state).toBe("pending"); journal.close();
  });
  it("holds unsupported wrappers carrying an original intent rather than asserting absence", async () => {
    const net = source(), view = chainView(net.s, "preprod"); const journal = openJournal(join(root, `${index++}.sqlite`));
    const tx = L.Transaction.deserialize("signature", "proof", "binding", bytes());
    const intent = [...tx.intents!.values()][0]!.serialize();
    await journal.submitOnce(key, { prepare: async () => ({ bytes: bytes(), ttl }), broadcast: async () => { net.body(2, [new Uint8Array([...intent, 255])]); net.head(3, ttl.getTime() + 3600_000); }, chain: view });
    await journal.reconcile(view); await journal.reconcile(view);
    expect(journal.live(key)?.state).toBe("pending"); journal.close();
  });
});
