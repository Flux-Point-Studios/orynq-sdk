import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import { encodeCompact, fromHex, toHex } from "../scale.js";
import {
  blake2b256,
  encodeHeader,
  headerFromRpc,
  headerHash,
  includedTransactionIndex,
  midnightExtrinsic,
  midnightTransactionIn,
  orderedTrieRoot,
  scheduledAuthorityChange,
  trieValueEncoding,
  type RpcHeader,
} from "../substrate.js";

interface BlockFixture {
  height: number;
  hash: string;
  header: RpcHeader;
  extrinsics: string[];
}
interface Fixture {
  network: string;
  runtime: { specVersion: number; stateVersion: number };
  blocks: BlockFixture[];
  setChanges: Array<{ hash: string; header: RpcHeader }>;
  latestJustified?: { hash: string; header: RpcHeader };
}
const fixture = (network: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/${network}-blocks.json`, import.meta.url), "utf8"));
const mainnet = fixture("mainnet");
const preprod = fixture("preprod");
const allBlocks = [...mainnet.blocks, ...preprod.blocks];
const extrinsicsOf = (b: BlockFixture) => b.extrinsics.map((e) => fromHex(e, "extrinsic"));
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const txHashOf = (bytes: Uint8Array) => L.Transaction.deserialize("signature", "proof", "binding", bytes).transactionHash();

describe("block headers, against real Midnight mainnet and preprod blocks", () => {
  it("both networks run spec 1000300 with state version 3, which Substrate reads as trie layout V1", () => {
    expect([mainnet.runtime.specVersion, preprod.runtime.specVersion]).toEqual([1000300, 1000300]);
    expect([mainnet.runtime.stateVersion, preprod.runtime.stateVersion]).toEqual([3, 3]);
  });

  it("blake2b-256 of the SCALE header is the block hash, for blocks and set-change headers", () => {
    const headers = [...allBlocks, ...mainnet.setChanges, ...preprod.setChanges, preprod.latestJustified!];
    expect(headers.length).toBe(12);
    for (const { hash, header } of headers) expect(toHex(headerHash(headerFromRpc(header)))).toBe(hash.slice(2));
  });

  it("one changed digest byte changes the hash", () => {
    const { hash, header } = mainnet.blocks[0]!;
    const logs = [...header.digest.logs];
    const last = logs.length - 1;
    logs[last] = logs[last]!.slice(0, -1) + (logs[last]!.endsWith("0") ? "1" : "0");
    expect(toHex(headerHash(headerFromRpc({ ...header, digest: { logs } })))).not.toBe(hash.slice(2));
  });

  it("refuses a digest log that is not exactly one digest item", () => {
    const { header } = mainnet.blocks[0]!;
    const trailing = { ...header, digest: { logs: [...header.digest.logs.slice(0, -1), `${header.digest.logs.at(-1)}00`] } };
    expect(() => headerFromRpc(trailing)).toThrow(/digest item has 1 trailing byte/);
    expect(() => headerFromRpc({ ...header, digest: { logs: ["0x07"] } })).toThrow(/unknown digest item 7/);
  });

  it("encodeHeader round-trips through the SCALE reader", () => {
    const h = headerFromRpc(mainnet.blocks[1]!.header);
    expect(toHex(encodeHeader(h))).toBe(toHex(encodeHeader(headerFromRpc(mainnet.blocks[1]!.header))));
    expect(h.number).toBe(mainnet.blocks[1]!.height);
  });
});

describe("the ordered trie root of a block body (extrinsicsRoot)", () => {
  it("equals the header's extrinsicsRoot for every recorded block", () => {
    for (const b of allBlocks) expect(toHex(orderedTrieRoot(extrinsicsOf(b))), `block ${b.height}`).toBe(b.header.extrinsicsRoot.slice(2));
  });

  it("changes when any extrinsic changes, moves, disappears or repeats", () => {
    const body = extrinsicsOf(preprod.blocks[1]!);
    expect(body.length).toBe(5);
    const root = toHex(orderedTrieRoot(body));
    const variants: Uint8Array[][] = [
      body.slice(0, -1),
      [...body, body[0]!],
      [body[1]!, body[0]!, ...body.slice(2)],
      body.map((e, i) => (i === 3 ? concat(e.subarray(0, -1), new Uint8Array([e.at(-1)! ^ 1])) : e)),
      body.map((e, i) => (i === 0 ? concat(e.subarray(0, 1), new Uint8Array([e[1]! ^ 0x80]), e.subarray(2)) : e)),
    ];
    for (const v of variants) expect(toHex(orderedTrieRoot(v))).not.toBe(root);
  });

  it("stores a value inline up to 32 bytes and by hash from 33, as the chain's own state trie does", () => {
    const { values, proof } = JSON.parse(readFileSync(new URL("./fixtures/mainnet-read-proof.json", import.meta.url), "utf8")) as {
      values: Record<"parentHash" | "stateKey", string>;
      proof: string[];
    };
    const nodes = proof.map((n) => Buffer.from(fromHex(n, "proof node")));
    const parentHash = fromHex(values.parentHash, "ParentHash");
    const stateKey = fromHex(values.stateKey, "StateKey");
    expect([parentHash.length, stateKey.length]).toEqual([32, 75]);
    const [inlineHashed, inline] = trieValueEncoding(parentHash);
    const [hashedHashed, hashed] = trieValueEncoding(stateKey);
    expect([inlineHashed, hashedHashed]).toEqual([false, true]);
    expect(nodes.some((n) => n.includes(Buffer.from(inline)))).toBe(true);
    expect(nodes.some((n) => n.includes(Buffer.from(hashed)))).toBe(true);
    expect(nodes.some((n) => n.equals(Buffer.from(stateKey)))).toBe(true);
    expect(nodes.some((n) => n.includes(Buffer.from(blake2b256(parentHash))))).toBe(false);
  });

  it("is injective across sizes that cross branch and two-byte-key boundaries", () => {
    const seen = new Set<string>();
    for (const n of [0, 1, 2, 15, 16, 17, 63, 64, 65, 300]) {
      const values = Array.from({ length: n }, (_, i) => new Uint8Array(Buffer.from(`value-${i}`.padEnd(i % 2 ? 40 : 8, "x"))));
      seen.add(toHex(orderedTrieRoot(values)));
      if (n > 0) seen.add(toHex(orderedTrieRoot(values.map((v, i) => (i === n - 1 ? concat(v, new Uint8Array([1])) : v)))));
    }
    expect(seen.size).toBe(19);
  });
});

describe("GRANDPA authority set changes in set-change headers", () => {
  it("each set-change header schedules the next set with no delay: 13 keys, 130 seats", () => {
    for (const { header } of [...mainnet.setChanges, ...preprod.setChanges]) {
      const next = scheduledAuthorityChange(headerFromRpc(header))!;
      expect(next.length).toBe(13);
      expect(next.reduce((s, a) => s + a.weight, 0n)).toBe(130n);
    }
  });

  it("an ordinary block, and the latest justified block of a set still running, schedule nothing", () => {
    expect(scheduledAuthorityChange(headerFromRpc(mainnet.blocks[0]!.header))).toBeNull();
    expect(scheduledAuthorityChange(headerFromRpc(preprod.latestJustified!.header))).toBeNull();
  });

  const withFrnk = (payload: Uint8Array) => {
    const { header } = mainnet.blocks[0]!;
    const log = toHex(concat(new Uint8Array([4]), new Uint8Array(Buffer.from("FRNK")), encodeCompact(payload.length), payload));
    return headerFromRpc({ ...header, digest: { logs: [...header.digest.logs, `0x${log}`] } });
  };
  const oneAuthority = concat(encodeCompact(1), new Uint8Array(32).fill(7), new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]));

  it("refuses a delayed change and a forced change rather than guessing when they apply", () => {
    expect(() => scheduledAuthorityChange(withFrnk(concat(new Uint8Array([1]), oneAuthority, new Uint8Array([5, 0, 0, 0]))))).toThrow(/delay of 5 blocks/);
    expect(() => scheduledAuthorityChange(withFrnk(concat(new Uint8Array([2, 9, 0, 0, 0]), oneAuthority, new Uint8Array(4))))).toThrow(/forced authority change/);
  });

  it("refuses a change to a set with no voting weight: no authorities, or every weight 0", () => {
    const zeroWeight = concat(encodeCompact(2), new Uint8Array(32).fill(7), new Uint8Array(8), new Uint8Array(32).fill(8), new Uint8Array(8));
    for (const seats of [encodeCompact(0), zeroWeight]) {
      expect(() => scheduledAuthorityChange(withFrnk(concat(new Uint8Array([1]), seats, new Uint8Array(4))))).toThrow(/^block \d+ schedules an authority set with no voting weight$/);
    }
  });

  it("positive control: the synthetic encoding of an immediate change decodes", () => {
    expect(scheduledAuthorityChange(withFrnk(concat(new Uint8Array([1]), oneAuthority, new Uint8Array(4))))).toEqual([{ key: "07".repeat(32), weight: 1n }]);
  });
});

describe("strict inclusion: the extrinsic must BE Midnight.send_mn_transaction(tx), not contain it", () => {
  const block = mainnet.blocks[0]!;
  const body = extrinsicsOf(block);
  const raw = midnightTransactionIn(body[3]!)!;
  const lengthPrefixed = (inner: Uint8Array) => concat(encodeCompact(inner.length), inner);
  const call = (version: number, pallet: number, callIndex: number, payload: Uint8Array) =>
    lengthPrefixed(concat(new Uint8Array([version, pallet, callIndex]), encodeCompact(payload.length), payload));

  it("golden: extrinsic 3 of mainnet block 2,772,320 is the transaction 56a425d1, framed 04 05 00", () => {
    expect(raw).not.toBeNull();
    expect(txHashOf(raw)).toMatch(/^56a425d1a6b15cb7/);
    expect(toHex(body[3]!.subarray(2, 5))).toBe("040500");
    expect(includedTransactionIndex(body, raw)).toBe(3);
    for (const i of [0, 1, 2]) expect(midnightTransactionIn(body[i]!)).toBeNull();
  });

  it("midnightExtrinsic frames a transaction exactly as the chain did, the bytes a submitter sends", () => {
    expect(toHex(midnightExtrinsic(raw))).toBe(toHex(body[3]!));
    for (const other of mainnet.blocks.slice(1)) {
      const extrinsic = extrinsicsOf(other)[3]!;
      expect(toHex(midnightExtrinsic(midnightTransactionIn(extrinsic)!))).toBe(toHex(extrinsic));
    }
  });

  it("a bare v5 send_mn_transaction is accepted too", () => {
    expect(includedTransactionIndex([call(5, 5, 0, raw)], raw)).toBe(0);
  });

  const forged: Array<[string, Uint8Array]> = [
    ["System.remark(tx)", call(4, 0, 0, raw)],
    ["MidnightSystem.send_mn_system_transaction(tx)", call(4, 6, 0, raw)],
    ["send_mn_transaction(tx ‖ 00)", call(4, 5, 0, concat(raw, new Uint8Array([0])))],
    ["send_mn_transaction(00 ‖ tx)", call(4, 5, 0, concat(new Uint8Array([0]), raw))],
    ["signed v4 extrinsic carrying tx", lengthPrefixed(concat(new Uint8Array([0x84, 5, 0]), encodeCompact(raw.length), raw))],
    ["v5 general extrinsic carrying tx", call(0x45, 5, 0, raw)],
    ["send_mn_transaction(tx) with a trailing byte inside the extrinsic", lengthPrefixed(concat(new Uint8Array([4, 5, 0]), encodeCompact(raw.length), raw, new Uint8Array([0])))],
    ["send_mn_transaction(tx) with a non-canonical length", lengthPrefixed(concat(new Uint8Array([4, 5, 0, 0x02 | (raw.length << 2) & 0xff]), new Uint8Array([(raw.length << 2) >> 8 & 0xff, (raw.length << 2) >> 16 & 0xff, 0]), raw))],
    ["a real Midnight transaction whose payload embeds tx", call(4, 5, 0, concat(body[3]!.subarray(0, 40), raw))],
  ];

  it.each(forged)("refuses %s, which a substring search would accept", (_, extrinsic) => {
    expect(Buffer.from(extrinsic).includes(Buffer.from(raw))).toBe(true);
    expect(midnightTransactionIn(extrinsic) === null || toHex(midnightTransactionIn(extrinsic)!) !== toHex(raw)).toBe(true);
    expect(includedTransactionIndex([...body.slice(0, 3), extrinsic], raw)).toBeNull();
  });

  it("refuses an extrinsic whose length prefix does not end exactly at its last byte", () => {
    const short = concat(encodeCompact(body[3]!.length - 3), body[3]!.subarray(2));
    expect(Buffer.from(short).includes(Buffer.from(raw))).toBe(true);
    expect(midnightTransactionIn(short)).toBeNull();
  });

  it("refuses a body that carries the same transaction twice", () => {
    expect(includedTransactionIndex([...body, body[3]!], raw)).toBeNull();
  });
});
