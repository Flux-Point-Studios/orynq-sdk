import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ed25519PublicKey, ed25519Sign } from "../ed25519.js";
import { concatBytes, toHex, u32le, u64le } from "../scale.js";
import { headerHash } from "../substrate.js";
import { DEFAULT_MAX_SET_CHANGES, decodeFinalityProof, decodeJustification, justifiedTarget, supermajority, verifyFinality, type FinalityCheckpoint, type FinalityRpc } from "../grandpa.js";
import { finalityRpc } from "../source.js";
import { replaySource } from "./recorded-source.js";
import { syntheticChain, testKeys, withUnknownHeaders } from "./grandpa-chain.js";

const uniform = (setCount: number, extra: Partial<Parameters<typeof syntheticChain>[0]> = {}) =>
  syntheticChain({ firstSetId: 100n, genesisEnd: 1000, setLengths: () => 300, setCount, ...extra });

describe("justifiedTarget: a supermajority of the set's weight signed for this set id", () => {
  const chain = uniform(3);
  const target = chain.header(chain.endOf(0));
  const j = () => decodeJustification(chain.justification(0, target));
  const set = { setId: 100n, authorities: chain.authorities(0) };

  it("finality-grandpa's threshold: 87 of 130, 3 of 4", () => {
    expect([supermajority(130n), supermajority(4n), supermajority(1n)]).toEqual([87n, 3n, 1n]);
  });

  it("positive control: the set's own justification finalizes its target", () => {
    expect(justifiedTarget(j(), set)).toEqual({ hash: headerHash(target), number: target.number });
  });

  it("refuses the same signatures under another set id", () => {
    for (const setId of [99n, 101n]) expect(justifiedTarget(j(), { ...set, setId })).toEqual({ error: expect.stringMatching(/carries 0 of 4 weight under set/) });
  });

  it("refuses a justification whose signers are not the set's voters", () => {
    expect(justifiedTarget(j(), { setId: 100n, authorities: chain.authorities(0).map((a) => ({ ...a, key: toHex(ed25519PublicKey(testKeys("stranger", 1)[0]!)) })) })).toEqual({
      error: expect.stringMatching(/carries 0 of/),
    });
  });

  it("counts a flipped signature, a repeated voter and a non-descendant precommit as no weight", () => {
    const flipped = j();
    flipped.precommits[0]!.signature[5]! ^= 1;
    expect(justifiedTarget(flipped, set)).toEqual({ error: expect.stringMatching(/carries 2 of 4 weight under set 100; finality needs 3/) });

    const repeated = j();
    repeated.precommits[2] = repeated.precommits[0]!;
    expect(justifiedTarget(repeated, set)).toEqual({ error: expect.stringMatching(/carries 2 of 4/) });

    const elsewhere = j();
    const other = chain.header(chain.endOf(0) - 5);
    const sk = testKeys("authority", 4)[2]!;
    const message = concatBytes(new Uint8Array([1]), headerHash(other), u32le(other.number), u64le(elsewhere.round), u64le(100n));
    elsewhere.precommits[2] = { target: { hash: headerHash(other), number: other.number }, signature: ed25519Sign(message, sk), id: ed25519PublicKey(sk) };
    expect(justifiedTarget(elsewhere, set)).toEqual({ error: expect.stringMatching(/carries 2 of 4/) });
  });

  it("counts a precommit for a descendant of the target when the ancestry headers link it", () => {
    const base = uniform(3);
    const child = base.header(base.endOf(0) + 1);
    const grandchild = base.header(base.endOf(0) + 2);
    const linked = { ...grandchild, parentHash: headerHash(child) };
    const parentOfChild = { ...child, parentHash: headerHash(target) };
    const sk = testKeys("authority", 4)[2]!;
    const just = j();
    const message = concatBytes(new Uint8Array([1]), headerHash(linked), u32le(linked.number), u64le(just.round), u64le(100n));
    just.precommits[2] = { target: { hash: headerHash(linked), number: linked.number }, signature: ed25519Sign(message, sk), id: ed25519PublicKey(sk) };
    expect(justifiedTarget(just, set)).toEqual({ error: expect.stringMatching(/carries 2 of 4/) });
    const withAncestry = { ...just, ancestries: [{ ...linked, parentHash: headerHash(parentOfChild) }, parentOfChild] };
    withAncestry.precommits[2] = {
      ...withAncestry.precommits[2]!,
      target: { hash: headerHash(withAncestry.ancestries[0]!), number: linked.number },
      signature: ed25519Sign(
        concatBytes(new Uint8Array([1]), headerHash(withAncestry.ancestries[0]!), u32le(linked.number), u64le(just.round), u64le(100n)),
        sk,
      ),
    };
    expect(justifiedTarget(withAncestry, set)).toEqual({ hash: headerHash(target), number: target.number });
  });
});

describe("verifyFinality on a synthetic chain", () => {
  it("finalizes a block inside the checkpoint's own set with one request", async () => {
    const chain = uniform(4);
    const r = await verifyFinality({ rpc: chain.rpc, block: chain.block(1100), checkpoints: [chain.checkpoint(0)] });
    expect(r).toMatchObject({ finalized: true, setChanges: 0, requests: 1, justified: { height: chain.endOf(0) } });
  });

  it("walks five set changes in two batched requests and proves the block under the sixth set", async () => {
    const chain = uniform(8);
    const block = chain.block(chain.endOf(4) + 17);
    const r = await verifyFinality({ rpc: chain.rpc, block, checkpoints: [chain.checkpoint(0)] });
    expect(r).toMatchObject({ finalized: true, setChanges: 5, justified: { height: chain.endOf(5) } });
    expect(r.requests).toBe(3);
    if (r.finalized) expect(r.checkpoint).toMatchObject({ setId: 105n, startsAfter: { height: chain.endOf(4) } });
  });

  it("starts from the nearest checkpoint below the block, and never from one above it", async () => {
    const chain = uniform(8);
    const block = chain.block(chain.endOf(4) + 17);
    const r = await verifyFinality({ rpc: chain.rpc, block, checkpoints: [chain.checkpoint(0), chain.checkpoint(4), chain.checkpoint(6)] });
    expect(r).toMatchObject({ finalized: true, setChanges: 1 });
    expect(await verifyFinality({ rpc: chain.rpc, block, checkpoints: [chain.checkpoint(6)] })).toMatchObject({ finalized: false, reason: expect.stringMatching(/no finality checkpoint lies below block/) });
  });

  it("follows sets whose lengths change, resyncing where a predicted end is wrong", async () => {
    const lengths = [300, 250, 250, 400, 120, 300, 300];
    const chain = syntheticChain({ firstSetId: 9n, genesisEnd: 50, setLengths: (k) => lengths[k]!, setCount: lengths.length });
    const block = chain.block(chain.endOf(4) + 3);
    expect(await verifyFinality({ rpc: chain.rpc, block, checkpoints: [chain.checkpoint(0)] })).toMatchObject({ finalized: true, setChanges: 5 });
  });

  it("follows a change of authorities, and refuses a set signed by the authorities it replaced", async () => {
    const chain = uniform(6, { keysFor: (k) => testKeys(k < 3 ? "old" : "new", 4) });
    const block = chain.block(chain.endOf(2) + 1);
    expect(await verifyFinality({ rpc: chain.rpc, block, checkpoints: [chain.checkpoint(0)] })).toMatchObject({ finalized: true, setChanges: 3 });
    const stale = uniform(6, { keysFor: () => testKeys("old", 4) });
    expect(await verifyFinality({ rpc: stale.rpc, block: stale.block(block.height), checkpoints: [chain.checkpoint(3)] })).toMatchObject({
      finalized: false,
      reason: expect.stringMatching(/the end of set 103 does not verify: .*carries 0 of 4 weight under set 103/),
    });
  });

  it("refuses to follow a forced authority change", async () => {
    const chain = uniform(6, { forcedAt: 2 });
    expect(await verifyFinality({ rpc: chain.rpc, block: chain.block(chain.endOf(3) + 1), checkpoints: [chain.checkpoint(0)] })).toMatchObject({
      finalized: false,
      reason: expect.stringMatching(/forced authority change/),
    });
  });

  it("reports a block the finalized chain does not hold, and one past the latest justified block", async () => {
    const chain = uniform(4);
    const block = chain.block(chain.endOf(1) + 9);
    expect(await verifyFinality({ rpc: chain.rpc, block: { ...block, hash: "11".repeat(32) }, checkpoints: [chain.checkpoint(0)] })).toMatchObject({
      finalized: false,
      reason: expect.stringMatching(/the finalized chain holds [0-9a-f]{64} at height/),
    });
    expect(await verifyFinality({ rpc: chain.rpc, block: { height: chain.endOf(3) + 1, hash: "22".repeat(32) }, checkpoints: [chain.checkpoint(2)] })).toMatchObject({
      finalized: false,
      reason: "set 103 has not ended: its latest justified block is 2200, below block 2201",
    });
  });

  it("never adopts an authority set from a set-change header that does not hash to the justified block", async () => {
    const honest = uniform(8);
    const attacker = uniform(8, { keysFor: (k) => testKeys(k < 2 ? "authority" : "attacker", 4) });
    const honestEnd1 = toHex(headerHash(honest.header(honest.endOf(1))));
    // Honest proofs up to the end of set 1, which the checkpoint's keys sign; for that block a
    // forged header whose FRNK log hands set 2 to the attacker's keys; the attacker's own
    // proofs and headers after it.
    const forged: FinalityRpc = {
      proveFinality: async (heights) => Promise.all(heights.map(async (h) => (await (h <= honest.endOf(1) ? honest : attacker).rpc.proveFinality([h]))[0]!)),
      headers: async (hashes) =>
        Promise.all(hashes.map(async (h) => (h === honestEnd1 ? attacker.rpcHeader(attacker.header(attacker.endOf(1))) : (await (await honest.rpc.headers([h]).catch(() => attacker.rpc.headers([h]))))[0]!))),
    };
    const r = await verifyFinality({ rpc: forged, block: attacker.block(honest.endOf(4) + 3), checkpoints: [honest.checkpoint(0)] });
    expect(r).toMatchObject({ finalized: false, reason: expect.stringMatching(/the end of set 102 does not verify/) });
  });

  it("never adopts an authority set from a forged last header in a resync's finality proof", async () => {
    // Ten-block sets: the walk's first predicted end (300 blocks on) is wrong, so it resyncs.
    const short = (keysFor?: (k: number) => Uint8Array[]) =>
      syntheticChain({ firstSetId: 100n, genesisEnd: 1000, setLengths: () => 10, setCount: 8, ...(keysFor ? { keysFor } : {}) });
    const honest = short();
    const attacker = short((k) => testKeys(k < 1 ? "authority" : "attacker", 4));
    const forged: FinalityRpc = {
      proveFinality: async (heights) =>
        Promise.all(
          heights.map(async (h) => {
            if (h > honest.endOf(0)) return (await attacker.rpc.proveFinality([h]))[0]!;
            const raw = (await honest.rpc.proveFinality([h]))[0]!;
            const headers = decodeFinalityProof(raw).unknownHeaders;
            return withUnknownHeaders(raw, [...headers.slice(0, -1), attacker.header(attacker.endOf(0))]);
          }),
        ),
      headers: attacker.rpc.headers,
    };
    const r = await verifyFinality({ rpc: forged, block: attacker.block(attacker.endOf(3) + 2), checkpoints: [honest.checkpoint(0)] });
    expect(r).toMatchObject({ finalized: false, reason: expect.stringMatching(/does not hash to its justified hash/) });
  });

  it("refuses a proof whose headers do not chain from the justified block down to the block", async () => {
    const chain = uniform(4);
    const block = chain.block(chain.endOf(0) - 20);
    const tampered: FinalityRpc = {
      proveFinality: async (heights) =>
        (await chain.rpc.proveFinality(heights)).map((raw) => {
          if (!raw) return raw;
          const headers = decodeFinalityProof(raw).unknownHeaders;
          headers[3] = { ...headers[3]!, stateRoot: new Uint8Array(32) };
          return withUnknownHeaders(raw, headers);
        }),
      headers: chain.rpc.headers,
    };
    expect(await verifyFinality({ rpc: tampered, block, checkpoints: [chain.checkpoint(0)] })).toMatchObject({
      finalized: false,
      reason: expect.stringMatching(/does not chain to block/),
    });
  });
});

// The cost of consensus-verified finality must not grow with the chain's age: an anchor a
// year past the nearest checkpoint costs no more than the bound, and is reported not final.
// The sets here are 10 blocks long so the synthetic chain is cheap to generate; the bound
// counts set changes, whatever their length. The walk first predicts Midnight's 300-block
// sets, so it spends one batch and one resync learning the length: three requests.
describe("verifyFinality's cost is bounded by maxSetChanges, not by chain age", () => {
  const SETS_PER_DAY = 48;
  const year = () => syntheticChain({ firstSetId: 100n, genesisEnd: 1000, setLengths: () => 10, setCount: 365 * SETS_PER_DAY + 2 });

  it(`an anchor 365 days past its checkpoint stops after ${DEFAULT_MAX_SET_CHANGES} set changes, in a bounded number of requests and seconds`, async () => {
    const chain = year();
    const block = { height: chain.endOf(365 * SETS_PER_DAY) + 5, hash: "33".repeat(32) };
    const started = performance.now();
    const r = await verifyFinality({ rpc: chain.rpc, block, checkpoints: [chain.checkpoint(0)] });
    const verifierSeconds = (performance.now() - started - chain.answering().millis) / 1000;
    expect(r).toMatchObject({ finalized: false, reason: expect.stringMatching(/more than 2016 GRANDPA set changes past the nearest checkpoint/) });
    expect(r.setChanges).toBe(DEFAULT_MAX_SET_CHANGES + 1);
    expect(r.requests).toBe(chain.answering().requests);
    expect(r.requests).toBeLessThanOrEqual(2 * Math.ceil((DEFAULT_MAX_SET_CHANGES + 1) / 64) + 3);
    expect(chain.answering().items).toBeLessThanOrEqual(2 * (DEFAULT_MAX_SET_CHANGES + 1) + 2 * 64 + 1);
    process.stdout.write(`\n365-day anchor: ${r.requests} requests, ${chain.answering().items} items, verifier ${verifierSeconds.toFixed(2)} s\n`);
    expect(verifierSeconds).toBeLessThan(10);
  }, 120_000);

  it("the same anchor a day past a newer checkpoint is final after at most a day of set changes", async () => {
    const chain = year();
    const k = 365 * SETS_PER_DAY;
    const block = chain.block(chain.endOf(k - 1) + 5);
    const r = await verifyFinality({ rpc: chain.rpc, block, checkpoints: [chain.checkpoint(0), chain.checkpoint(k - SETS_PER_DAY)] });
    expect(r).toMatchObject({ finalized: true, setChanges: SETS_PER_DAY });
    expect(r.requests).toBe(3 + 3);
  }, 120_000);
});

// Recorded from Blockfrost by running this verifier against the live networks; each checkpoint
// is the set named by a real set-change header's FRNK log, and the replay fails on any request
// that was not recorded.
describe.each(["mainnet", "preprod"])("golden: real %s finality, replayed", (network) => {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/${network}-finality.json`, import.meta.url), "utf8"));
  const checkpoint = (c: { setId: string; startsAfter: { height: number; hash: string }; authorities: Array<{ key: string; weight: string }> }): FinalityCheckpoint => ({
    setId: BigInt(c.setId),
    startsAfter: c.startsAfter,
    authorities: c.authorities.map((a) => ({ key: a.key, weight: BigInt(a.weight) })),
  });
  const own = checkpoint(f.checkpoints.own);
  const rpc = () => finalityRpc(replaySource(f.recording));

  it("the checkpoint is a real 13-key, 130-seat GRANDPA set", () => {
    expect(own.authorities.length).toBe(13);
    expect(own.authorities.reduce((s, a) => s + a.weight, 0n)).toBe(130n);
  });

  it("proves the block final under its own set in one request, and from ten sets back in three", async () => {
    expect(await verifyFinality({ rpc: rpc(), block: f.block, checkpoints: [own] })).toMatchObject({
      finalized: true,
      setChanges: 0,
      requests: 1,
      justified: { height: f.setEnd },
    });
    const walked = await verifyFinality({ rpc: rpc(), block: f.block, checkpoints: [checkpoint(f.checkpoints.tenBack)] });
    expect(walked).toMatchObject({ finalized: true, setChanges: 10, requests: 3, justified: { height: f.setEnd } });
    if (walked.finalized) expect(walked.checkpoint.setId).toBe(own.setId);
  });

  it("the real justification carries no weight under a neighbouring set id, and too little with one voter replaced", async () => {
    const [raw] = await rpc().proveFinality([f.block.height]);
    const j = decodeFinalityProof(raw!).justification;
    expect(justifiedTarget(j, own)).toMatchObject({ number: f.setEnd });
    for (const setId of [own.setId - 1n, own.setId + 1n]) expect(justifiedTarget(j, { ...own, setId })).toEqual({ error: expect.stringMatching(/carries 0 of 130 weight/) });
    const signer = toHex(j.precommits[0]!.id);
    const replaced = own.authorities.map((a) => (a.key === signer ? { ...a, key: "ee".repeat(32) } : a));
    expect(justifiedTarget(j, { ...own, authorities: replaced })).toEqual({ error: expect.stringMatching(/carries \d+ of 130 weight under set \d+; finality needs 87/) });
    const flipped = decodeFinalityProof(raw!).justification;
    flipped.precommits[0]!.signature[0]! ^= 1;
    expect(justifiedTarget(flipped, own)).toEqual({ error: expect.stringMatching(/finality needs 87/) });
  });

  it("refuses a block hash the finalized chain does not hold at that height", async () => {
    const forged = { ...f.block, hash: f.block.hash.replace(/^./, (c: string) => (c === "0" ? "1" : "0")) };
    expect(await verifyFinality({ rpc: rpc(), block: forged, checkpoints: [own] })).toMatchObject({
      finalized: false,
      reason: `the finalized chain holds ${f.block.hash} at height ${f.block.height}, not ${forged.hash}`,
    });
  });
});
