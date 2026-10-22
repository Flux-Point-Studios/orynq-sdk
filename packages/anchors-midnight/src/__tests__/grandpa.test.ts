import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ed25519PublicKey, ed25519Verify } from "../ed25519.js";
import { compactAt, concatBytes, fromHex, toHex, u32le } from "../scale.js";
import { encodeHeader, headerHash, type BlockHeader } from "../substrate.js";
import {
  DEFAULT_MAX_SET_CHANGES,
  decodeFinalityProof,
  decodeJustification,
  justifiedTarget,
  supermajority,
  verifyFinality,
  type AuthoritySet,
  type FinalityCheckpoint,
  type FinalityRpc,
  type GrandpaJustification,
} from "../grandpa.js";
import { finalityRpc } from "../source.js";
import { replaySource } from "./recorded-source.js";
import { encodeJustification, signedPrecommit, syntheticChain, testKeys, withUnknownHeaders } from "./grandpa-chain.js";

// Every Ed25519 verification is still performed, and counted.
vi.mock("../ed25519.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ed25519.js")>();
  return { ...real, ed25519Verify: vi.fn(real.ed25519Verify) };
});
beforeEach(() => {
  vi.mocked(ed25519Verify).mockClear();
});

// A justification's work: its Ed25519 verifications, and its reads of an ancestry header's
// parent link (one to hash the header, one for each step a walk takes from it to its parent).
function work(j: GrandpaJustification, set: AuthoritySet) {
  const tally = { links: 0 };
  const ancestries = j.ancestries.map(
    (h): BlockHeader => ({
      ...h,
      get parentHash() {
        tally.links++;
        return h.parentHash;
      },
    }),
  );
  const started = performance.now();
  const result = justifiedTarget({ ...j, ancestries }, set);
  const millis = performance.now() - started;
  const bytes = 44 + 132 * j.precommits.length + j.ancestries.reduce((n, h) => n + encodeHeader(h).length, 0);
  return { result, verifications: vi.mocked(ed25519Verify).mock.calls.length, links: tally.links, millis, bytes };
}
const report = (label: string, w: ReturnType<typeof work>) =>
  process.stdout.write(`\njustification work, ${label}: ${(w.bytes / 1e6).toFixed(2)} MB, ${w.verifications} Ed25519, ${w.links} parent links, ${w.millis.toFixed(1)} ms\n`);

const uniform = (setCount: number, extra: Partial<Parameters<typeof syntheticChain>[0]> = {}) =>
  syntheticChain({ firstSetId: 100n, genesisEnd: 1000, setLengths: () => 300, setCount, ...extra });
const keys = testKeys("authority", 4);

// A precommit in the synthetic chain's round 7 of set 100, and a justification of that round for
// `target`, or for its number under `hash`.
const vote = (sk: Uint8Array, header: BlockHeader) => signedPrecommit(sk, { hash: headerHash(header), number: header.number }, 7n, 100n);
const justificationOf = (target: BlockHeader, precommits: GrandpaJustification["precommits"], ancestries: BlockHeader[], hash = headerHash(target)): GrandpaJustification => ({
  round: 7n,
  target: { hash, number: target.number },
  precommits,
  ancestries,
});
const forged = <P extends { signature: Uint8Array }>(p: P): P => ({ ...p, signature: p.signature.map((b, i) => (i === 0 ? b ^ 1 : b)) });

// The finality proof with its justification's unsigned target number set to `number`, every
// signed byte kept, and no headers between the target and the block.
const relabeled = (proof: Uint8Array, number: number) => {
  const at = compactAt(proof, 32);
  if ("error" in at) throw new Error(at.error);
  const out = withUnknownHeaders(proof, []);
  out.set(u32le(number), at.next + 8 + 32);
  return out;
};

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
    flipped.precommits[0] = forged(flipped.precommits[0]!);
    expect(justifiedTarget(flipped, set)).toEqual({ error: expect.stringMatching(/carries 2 of 4 weight under set 100; finality needs 3/) });

    const repeated = j();
    repeated.precommits[2] = repeated.precommits[0]!;
    expect(justifiedTarget(repeated, set)).toEqual({ error: expect.stringMatching(/carries 2 of 4/) });

    const elsewhere = j();
    elsewhere.precommits[2] = vote(keys[2]!, chain.header(chain.endOf(0) - 5));
    expect(justifiedTarget(elsewhere, set)).toEqual({ error: expect.stringMatching(/carries 2 of 4/) });
  });

  it("refuses a target number the precommits did not sign, above or below the signed one", () => {
    for (const number of [target.number + 1, target.number - 1]) {
      const relabel = j();
      relabel.target = { ...relabel.target, number };
      expect(justifiedTarget(relabel, set)).toEqual({ error: `the justification for block ${number} carries 0 of 4 weight under set 100; finality needs 3` });
    }
  });

  it("refuses a set with no voting weight, under which a justification without one precommit would finalize anything", () => {
    const unsigned = { ...j(), precommits: [] };
    for (const authorities of [[], chain.authorities(0).map((a) => ({ ...a, weight: 0n }))]) {
      expect(justifiedTarget(unsigned, { setId: 100n, authorities })).toEqual({ error: "set 100 has no voting weight, so it finalizes nothing" });
    }
  });

  it("refuses a negative weight, which shrinks the total a supermajority is measured against", () => {
    // Total 1: one voter's precommit would be a supermajority of the four.
    const authorities = chain.authorities(0).map((a, i) => ({ ...a, weight: i === 3 ? -2n : 1n }));
    const one = { ...j(), precommits: j().precommits.slice(0, 1) };
    expect(justifiedTarget(one, { setId: 100n, authorities })).toEqual({ error: "set 100 gives an authority a negative weight" });
  });

  it("counts a precommit for a descendant of the target when the ancestry headers link it", () => {
    const base = uniform(3);
    const child = base.header(base.endOf(0) + 1);
    const grandchild = base.header(base.endOf(0) + 2);
    const linked = { ...grandchild, parentHash: headerHash(child) };
    const parentOfChild = { ...child, parentHash: headerHash(target) };
    const just = j();
    just.precommits[2] = vote(keys[2]!, linked);
    expect(justifiedTarget(just, set)).toEqual({ error: expect.stringMatching(/carries 2 of 4/) });
    const withAncestry = { ...just, ancestries: [{ ...linked, parentHash: headerHash(parentOfChild) }, parentOfChild] };
    withAncestry.precommits[2] = vote(keys[2]!, withAncestry.ancestries[0]!);
    expect(justifiedTarget(withAncestry, set)).toEqual({ hash: headerHash(target), number: target.number });
  });

  // Ten blocks before the end of set 0, each the parent of the next, and a sibling of the
  // second that forks off the first.
  const inner = chain.header(target.number - 10);
  const route = Array.from({ length: 10 }, (_, i) => chain.header(inner.number + 1 + i));
  const fork = { ...route[1]!, stateRoot: new Uint8Array(32) };
  const toInner = (precommits: GrandpaJustification["precommits"]) => justificationOf(inner, precommits, [...route, fork]);

  it("counts precommits for different descendants of the target, a fork's included, when the ancestry links each", () => {
    const precommits = [vote(keys[0]!, route[9]!), vote(keys[1]!, route[4]!), vote(keys[2]!, fork)];
    expect(justifiedTarget(toInner(precommits), set)).toEqual({ hash: headerHash(inner), number: inner.number });
    expect(justifiedTarget(toInner(precommits.slice(1)), set)).toEqual({ error: expect.stringMatching(/carries 2 of 4 weight/) });
  });

  it("finalizes with a commit in which every voter equivocated, as finality-grandpa keeps both of an equivocator's precommits", () => {
    const equivocated = keys.flatMap((sk) => [vote(sk, route[9]!), vote(sk, fork)]);
    expect(equivocated).toHaveLength(8);
    expect(justifiedTarget(toInner(equivocated), set)).toEqual({ hash: headerHash(inner), number: inner.number });
  });

  it("counts a non-voter's precommits and repeated precommits as no weight, however many there are", () => {
    const strangers = testKeys("stranger", 9).map((sk) => vote(sk, target));
    const padded = (precommits: GrandpaJustification["precommits"]) => ({ ...j(), precommits: [...precommits, ...strangers, ...precommits, ...precommits] });
    expect(justifiedTarget(padded(j().precommits), set)).toEqual({ hash: headerHash(target), number: target.number });
    expect(justifiedTarget(padded(j().precommits.slice(1)), set)).toEqual({ error: expect.stringMatching(/carries 2 of 4 weight/) });
  });

  it("follows ancestry headers however many there are, repeated or not", () => {
    const long = syntheticChain({ firstSetId: 100n, genesisEnd: 1000, setLengths: () => 1000, setCount: 1 });
    const base = long.header(1001);
    const route = Array.from({ length: 700 }, (_, i) => long.header(base.number + 1 + i));
    const withVoter2 = (at: BlockHeader, ancestries: BlockHeader[]) => justificationOf(base, [...keys.slice(0, 2).map((sk) => vote(sk, base)), vote(keys[2]!, at)], ancestries);
    expect(justifiedTarget(withVoter2(route.at(-1)!, route), set)).toEqual({ hash: headerHash(base), number: base.number });
    expect(justifiedTarget(withVoter2(route[0]!, Array(601).fill(route[0]!)), set)).toEqual({ hash: headerHash(base), number: base.number });
  });

  // finality-grandpa counts the weight of a voter that signed two different precommits in the
  // round for every block of the round's vote graph, and a node's commit lists both, in the order
  // they reached it. The graph's base is the commit's lowest precommit, every precommit must
  // descend from it, and the target must lead to a voter's precommit.
  describe("an equivocator", () => {
    const below = (n: number) => chain.header(target.number - n);
    const withVoter2 = (...precommits: GrandpaJustification["precommits"]) => ({ ...j(), precommits: [...j().precommits.slice(0, 2), ...precommits] });
    const final = { hash: headerHash(target), number: target.number };
    const short = { error: expect.stringMatching(/carries 2 of 4 weight/) };
    // Another block at a header's height, with the same parent.
    const sibling = (header: BlockHeader): BlockHeader => ({ ...header, stateRoot: new Uint8Array(32) });
    // A fork that leaves the target's chain above block T-3: a block at T-2 and its child at T-1.
    const forkAt2 = sibling(below(2));
    const forkAt1 = { ...below(1), parentHash: headerHash(forkAt2) };
    const forkPair = [vote(keys[2]!, forkAt1), vote(keys[2]!, below(1))];
    const forkAncestries = [target, below(1), below(2), below(3), below(4), forkAt2, forkAt1];

    it("counts when its precommit for an ancestor of the target comes before its precommit for the target", () => {
      expect(justifiedTarget({ ...withVoter2(vote(keys[2]!, below(1)), vote(keys[2]!, target)), ancestries: [target] }, set)).toEqual(final);
    });

    it("counts when both its precommits are for ancestors of the target, as in Substrate's justification_with_equivocation", () => {
      const upstream = { ...withVoter2(vote(keys[2]!, below(2)), vote(keys[2]!, below(1))), ancestries: [target, below(1)] };
      expect(justifiedTarget(upstream, set)).toEqual(final);
      // With its whole weight: 2 of 5 seats, and 4 of 5 are needed.
      expect(justifiedTarget(upstream, { ...set, authorities: set.authorities.map((a, i) => ({ ...a, weight: i === 2 ? 2n : 1n })) })).toEqual(final);
    });

    it("finds the target's chain only through headers at their own numbers", () => {
      // The target relabeled one block up, with byzantine precommits signed for those numbers: the
      // headers below it sit one block lower than the relabel says, so none of them is on its chain.
      const up = (header: BlockHeader) => signedPrecommit(keys[2]!, { hash: headerHash(header), number: header.number + 1 }, 7n, 100n);
      const relabeled = { ...j(), target: { hash: headerHash(target), number: target.number + 1 }, ancestries: [target, below(1)] };
      const precommits = [...keys.slice(0, 2).map((sk) => signedPrecommit(sk, relabeled.target, 7n, 100n)), up(below(1)), up(below(2))];
      expect(justifiedTarget({ ...relabeled, precommits }, set)).toEqual({ error: expect.stringMatching(/carries 2 of 4 weight/) });
    });

    it("is not made by one precommit below the target, listed once or twice, on the target's chain or not", () => {
      for (const ancestries of [[], [target]]) {
        expect(justifiedTarget({ ...withVoter2(vote(keys[2]!, below(1))), ancestries }, set)).toEqual(short);
        expect(justifiedTarget({ ...withVoter2(vote(keys[2]!, below(1)), vote(keys[2]!, below(1))), ancestries }, set)).toEqual(short);
      }
    });

    it("is not made by two precommits when either is forged, or signed for another set id or round", () => {
      const ancestries = [target, below(1)];
      expect(justifiedTarget({ ...withVoter2(vote(keys[2]!, below(1)), vote(keys[2]!, below(2))), ancestries }, set)).toEqual(final);
      for (const pair of [
        [vote(keys[2]!, below(1)), forged(vote(keys[2]!, below(2)))],
        [forged(vote(keys[2]!, below(1))), vote(keys[2]!, below(2))],
        [vote(keys[2]!, below(1)), signedPrecommit(keys[2]!, { hash: headerHash(below(2)), number: below(2).number }, 7n, 101n)],
        [vote(keys[2]!, below(1)), signedPrecommit(keys[2]!, { hash: headerHash(below(2)), number: below(2).number }, 8n, 100n)],
      ]) {
        expect(justifiedTarget({ ...withVoter2(...pair), ancestries }, set)).toEqual(short);
      }
    });

    it("adds no weight when it is not a voter", () => {
      const [stranger] = testKeys("stranger", 1);
      expect(justifiedTarget({ ...withVoter2(vote(stranger!, below(1)), vote(stranger!, below(2))), ancestries: [target, below(1)] }, set)).toEqual(short);
    });

    it("counts with two blocks at one height when both descend from the lowest precommit, and not when one of them is it", () => {
      const pair = [vote(keys[2]!, below(1)), vote(keys[2]!, sibling(below(1)))];
      const ancestries = [target, below(1), sibling(below(1))];
      expect(justifiedTarget({ ...withVoter2(...pair, vote(keys[3]!, below(2))), ancestries }, set)).toEqual(final);
      expect(justifiedTarget({ ...withVoter2(...pair), ancestries }, set)).toEqual(short);
    });

    it("counts with a precommit on a fork only when the fork leaves the target's chain at or above the lowest signed precommit on that chain", () => {
      expect(justifiedTarget({ ...withVoter2(...forkPair, vote(keys[3]!, below(3))), ancestries: forkAncestries }, set)).toEqual(final);
      // A precommit off the target's chain, however low, is no base.
      const offChain = sibling(below(4));
      for (const base of [vote(keys[3]!, below(2)), forged(vote(keys[3]!, below(3))), vote(keys[3]!, offChain)]) {
        expect(justifiedTarget({ ...withVoter2(...forkPair, base), ancestries: [...forkAncestries, offChain] }, set)).toEqual(short);
      }
    });

    it("takes no base from an authority with no weight, which finality-grandpa's voter set leaves out", () => {
      const [silent] = testKeys("silent", 1);
      const withSilent = { ...set, authorities: [...set.authorities, { key: toHex(ed25519PublicKey(silent!)), weight: 0n }] };
      expect(justifiedTarget({ ...withVoter2(...forkPair, vote(silent!, below(3))), ancestries: forkAncestries }, withSilent)).toEqual(short);
      expect(justifiedTarget({ ...withVoter2(...forkPair, vote(keys[3]!, below(3))), ancestries: forkAncestries }, withSilent)).toEqual(final);
    });

    it("adds nothing to a target no voter's precommit is for or descends from", () => {
      const ancestries = [target, below(1)];
      const equivocators = keys.slice(0, 3).flatMap((sk) => [vote(sk, below(2)), vote(sk, below(1))]);
      expect(justifiedTarget({ ...j(), precommits: equivocators, ancestries }, set)).toEqual({ error: expect.stringMatching(/carries 0 of 4 weight/) });
      expect(justifiedTarget({ ...j(), precommits: [...equivocators, vote(keys[3]!, target)], ancestries }, set)).toEqual(final);
    });

    // GRANDPA signs neither a chain nor its genesis: a key used on two chains with the same set id
    // and round signs precommits that verify on both.
    describe("made of one key's precommits on two chains", () => {
      // `other` shares only the block both chains build on, 1000, with `chain`.
      const other = uniform(3, { extrinsicsRootOf: (n) => testKeys(`other-${n}`, 1)[0]! });
      const shared = fromHex(chain.checkpoint(0).startsAfter.hash, "block 1000");
      const pairs = keys.slice(0, 3).flatMap((sk) => [vote(sk, chain.header(1250)), vote(sk, other.header(1250))]);
      const fabricated: BlockHeader = { ...target, stateRoot: new Uint8Array(32) };
      const forgedTarget = { hash: headerHash(fabricated), number: fabricated.number };
      const routeOf = (c: typeof chain, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => c.header(from + i));
      const bothChains = [fabricated, ...routeOf(chain, 1001, 1299), ...routeOf(other, 1001, 1250)];

      it("finalizes no fabricated block, whatever the ancestry headers show", () => {
        expect(justifiedTarget({ round: 7n, target: forgedTarget, precommits: pairs, ancestries: [] }, set)).toEqual({ error: expect.stringMatching(/carries 0 of 4 weight/) });
        // With a byzantine voter's precommit for it, and headers linking it down through one chain or both.
        const byzantine = vote(keys[3]!, fabricated);
        for (const ancestries of [[fabricated, ...routeOf(chain, 1251, 1299)], bothChains]) {
          expect(justifiedTarget({ round: 7n, target: forgedTarget, precommits: [...pairs, byzantine], ancestries }, set)).toEqual({ error: expect.stringMatching(/carries 1 of 4 weight/) });
        }
      });

      it("is reported not final by verifyFinality", async () => {
        const proof = chain.proof(fabricated, encodeJustification({ round: 7n, target: forgedTarget, precommits: pairs, ancestries: [] }), []);
        const rpc: FinalityRpc = { proveFinality: async (heights) => heights.map(() => proof), headers: chain.rpc.headers };
        expect(await verifyFinality({ rpc, block: { height: 1300, hash: toHex(forgedTarget.hash) }, checkpoints: [chain.checkpoint(0)] })).toMatchObject({ finalized: false });
      });

      it("counts the pairs once a precommit for the block both chains share is the lowest, as finality-grandpa does", () => {
        const sharedVote = signedPrecommit(keys[3]!, { hash: shared, number: 1000 }, 7n, 100n);
        expect(justifiedTarget({ round: 7n, target: forgedTarget, precommits: [...pairs, vote(keys[3]!, fabricated), sharedVote], ancestries: bothChains }, set)).toEqual(forgedTarget);
      });
    });
  });

  it("counts no precommit whose signed number is not its block's, even where another voter's walk passed that block", () => {
    const [child, grandchild] = [chain.header(target.number + 1), chain.header(target.number + 2)];
    for (const number of [child.number - 1, child.number + 4]) {
      const precommits = [vote(keys[0]!, grandchild), vote(keys[1]!, target), signedPrecommit(keys[2]!, { hash: headerHash(child), number }, 7n, 100n)];
      expect(justifiedTarget({ ...j(), precommits, ancestries: [grandchild, child] }, set)).toEqual({ error: expect.stringMatching(/carries 2 of 4 weight/) });
    }
  });
});

// The work is counted, not timed (the times are only reported): at most two Ed25519
// verifications for each voter, and at most two reads of each ancestry header's parent link, one
// to hash the header and one to walk from it, however the source repeats or arranges what it sends.
describe("justifiedTarget's work is linear in the justification, whatever the source sends", () => {
  const chain = syntheticChain({ firstSetId: 100n, genesisEnd: 1000, setLengths: () => 700, setCount: 1 });
  const set = { setId: 100n, authorities: chain.authorities(0) };
  const base = chain.header(1001);
  const route = Array.from({ length: 600 }, (_, i) => chain.header(base.number + 1 + i));
  const tip = route.at(-1)!;
  const quorum = keys.slice(0, 3).map((sk) => vote(sk, base));
  const final = { hash: headerHash(base), number: base.number };
  const refused = { error: "the justification for block 1001 carries 0 of 4 weight under set 100; finality needs 3" };
  // A voter's signature for the tip, moved onto every block of the route.
  const moved = (sk: Uint8Array) => {
    const p = vote(sk, tip);
    return route.map((h) => ({ ...p, target: { hash: headerHash(h), number: h.number } }));
  };
  const stranger = (i: number) => ({ ...quorum[0]!, id: concatBytes(u32le(i), new Uint8Array(28)) });

  it.each([
    ["one genuine precommit repeated 3000 times over 600 headers, under a target its route never reaches", () => justificationOf(base, Array(3000).fill(vote(keys[0]!, tip)), route, new Uint8Array(32)), refused, 1],
    ["each voter's signature moved onto all 600 blocks of the route", () => justificationOf(base, keys.flatMap(moved), route), refused, 8],
    ["3000 non-voters' precommits ahead of the quorum's", () => justificationOf(base, [...Array.from({ length: 3000 }, (_, i) => stranger(i)), ...quorum], route), final, 3],
    ["the quorum's precommits with 20,000 ancestry headers", () => justificationOf(base, quorum, Array(20_000).fill(route[0]!)), final, 3],
    ["every voter equivocating along the route", () => justificationOf(base, keys.flatMap((sk) => [vote(sk, tip), vote(sk, route[299]!)]), route), final, 8],
  ] as const)("%s", (label, justification, result, verifications) => {
    const j = justification();
    const w = work(j, set);
    report(`synthetic, ${label}`, w);
    expect(w.result).toEqual(result);
    expect(w.verifications).toBe(verifications);
    expect(w.links).toBeLessThanOrEqual(2 * j.ancestries.length);
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

  it("walks through a set end whose justification lists an equivocator's ancestor precommit first, or carries repeats and non-voters' precommits", async () => {
    const chain = uniform(4);
    const end = chain.header(chain.endOf(0));
    const signedEnd = { hash: headerHash(end), number: end.number };
    const reshaped = (change: (j: GrandpaJustification) => GrandpaJustification): FinalityRpc => ({
      proveFinality: async (heights) =>
        (await chain.rpc.proveFinality(heights)).map((raw) => {
          const proof = raw && decodeFinalityProof(raw);
          return proof && proof.justification.target.number === end.number ? chain.proof(end, encodeJustification(change(proof.justification)), proof.unknownHeaders) : raw;
        }),
      headers: chain.rpc.headers,
    });
    const equivocated = reshaped((j) => ({ ...j, precommits: [...j.precommits.slice(0, 2), vote(keys[2]!, chain.header(end.number - 1)), j.precommits[2]!], ancestries: [end] }));
    const strangers = testKeys("stranger", 9).map((sk) => signedPrecommit(sk, signedEnd, 7n, 100n));
    const padded = reshaped((j) => ({ ...j, precommits: [...j.precommits, ...strangers, ...j.precommits, ...j.precommits] }));
    for (const rpc of [equivocated, padded]) {
      expect(await verifyFinality({ rpc, block: chain.block(chain.endOf(1) + 9), checkpoints: [chain.checkpoint(0)] })).toMatchObject({ finalized: true, setChanges: 2 });
    }
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

  describe("never adopts an authority set from a set-change block at or before the start of the set that justified it", () => {
    // Ten-block sets, each with its own keys, and set 3 trusted. A justification may be relabeled
    // down to an ancestor of the blocks its precommits signed, so the source can present set 3's
    // own justification of its last block as one of an earlier set-change block. That block's
    // FRNK log names a set whose keys are not set 4's; if the walk adopted them under set 4's id,
    // those keys could sign a fabricated block as set 4.
    const chain = syntheticChain({ firstSetId: 100n, genesisEnd: 1000, setLengths: () => 10, setCount: 6, keysFor: (k) => testKeys(`set-${k}`, 4) });
    const trusted = chain.checkpoint(3);
    const fabricated: BlockHeader = { ...chain.header(chain.endOf(3) + 5), stateRoot: new Uint8Array(32) };

    it("control: the walk from set 3 finalizes the real block at that height", async () => {
      expect(await verifyFinality({ rpc: chain.rpc, block: chain.block(fabricated.number), checkpoints: [trusted] })).toMatchObject({ finalized: true, setChanges: 1 });
    });

    it.each([
      ["the block set 3 starts after", 2],
      ["an earlier set's last block", 1],
      ["the oldest set's last block", 0],
    ])("refuses set 3's last justification relabeled as %s", async (_label, k) => {
      const end = chain.header(chain.endOf(k));
      const genuine = decodeJustification(chain.justification(3, chain.header(chain.endOf(3))));
      const between = Array.from({ length: chain.endOf(3) - end.number }, (_, i) => chain.header(end.number + 1 + i));
      const relabeled = chain.proof(end, encodeJustification({ ...genuine, target: { hash: headerHash(end), number: end.number }, ancestries: between }), [end]);
      // The keys that end's FRNK log names, signing the fabricated block under set 4's id.
      const forgedBy = (unknown: BlockHeader[]) => chain.proof(fabricated, chain.justification(4, fabricated, testKeys(`set-${k + 1}`, 4)), unknown);
      let relabelSent = false;
      const rpc: FinalityRpc = {
        proveFinality: async (heights) =>
          heights.map((h) => {
            if (h === trusted.startsAfter.height + 1 && !relabelSent) {
              relabelSent = true;
              return relabeled;
            }
            if (h === fabricated.number) return forgedBy([]);
            return h === end.number + 1 ? forgedBy([fabricated]) : null;
          }),
        headers: chain.rpc.headers,
      };
      expect(decodeFinalityProof(relabeled).justification.precommits).toEqual(genuine.precommits);
      expect(await verifyFinality({ rpc, block: { height: fabricated.number, hash: toHex(headerHash(fabricated)) }, checkpoints: [trusted] })).toMatchObject({
        finalized: false,
        reason: `the end of set 103 is justified at block ${end.number}, not after its start ${trusted.startsAfter.height}`,
      });
    });
  });

  it("never reports a block's hash at a height above it: a justification relabeled within the set's predicted range", async () => {
    // Set 1 is 250 blocks long, so the walk's first prediction (300) covers the block after its end.
    const lengths = [300, 250, 300, 300];
    const chain = syntheticChain({ firstSetId: 9n, genesisEnd: 50, setLengths: (k) => lengths[k]!, setCount: lengths.length });
    const end = chain.endOf(1);
    const relabeling: FinalityRpc = {
      proveFinality: async (heights) => Promise.all(heights.map(async (h) => (h === end + 1 ? relabeled((await chain.rpc.proveFinality([end]))[0]!, end + 1) : (await chain.rpc.proveFinality([h]))[0]!))),
      headers: chain.rpc.headers,
    };
    expect(await verifyFinality({ rpc: relabeling, block: { height: end + 1, hash: chain.block(end).hash }, checkpoints: [chain.checkpoint(1)] })).toMatchObject({
      finalized: false,
      reason: expect.stringMatching(/carries 0 of 4 weight/),
    });
    expect(await verifyFinality({ rpc: relabeling, block: chain.block(end), checkpoints: [chain.checkpoint(1)] })).toMatchObject({ finalized: true, justified: chain.block(end) });
  });

  it("refuses a checkpoint with no voting weight, or a negative weight, before asking the source anything", async () => {
    const chain = uniform(4);
    const at = chain.checkpoint(0);
    for (const [authorities, reason] of [
      [[], "set 100 has no voting weight, so it finalizes nothing"],
      [at.authorities.map((a) => ({ ...a, weight: 0n })), "set 100 has no voting weight, so it finalizes nothing"],
      [at.authorities.map((a, i) => ({ ...a, weight: i === 0 ? -1n : 1n })), "set 100 gives an authority a negative weight"],
    ] as const) {
      expect(await verifyFinality({ rpc: chain.rpc, block: chain.block(1100), checkpoints: [{ ...at, authorities: [...authorities] }] })).toEqual({ finalized: false, reason, setChanges: 0, requests: 0 });
    }
  });

  it("refuses to follow a set change that schedules a set with no voting weight", async () => {
    const chain = uniform(6, { keysFor: (k) => (k === 2 ? [] : testKeys("authority", 4)) });
    expect(await verifyFinality({ rpc: chain.rpc, block: chain.block(chain.endOf(3) + 1), checkpoints: [chain.checkpoint(0)] })).toMatchObject({
      finalized: false,
      reason: `block ${chain.endOf(1)} schedules an authority set with no voting weight`,
    });
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
    flipped.precommits[0] = forged(flipped.precommits[0]!);
    expect(justifiedTarget(flipped, own)).toEqual({ error: expect.stringMatching(/finality needs 87/) });
  });

  it("the real justification relabeled one block up carries no weight, and its hash is never reported final at that height", async () => {
    const [raw] = await rpc().proveFinality([f.block.height]);
    const j = decodeFinalityProof(raw!).justification;
    expect(justifiedTarget({ ...j, target: { ...j.target, number: f.setEnd + 1 } }, own)).toEqual({ error: expect.stringMatching(/carries 0 of 130 weight/) });
    // The recorded justification is for a set's last block; the live attack relabeled the latest
    // justified block of a running set. A trusted checkpoint one block later puts the relabeled
    // height inside the set's predicted range, as the running set did.
    const forged = relabeled(raw!, f.setEnd + 1);
    const lying: FinalityRpc = { proveFinality: async (heights) => heights.map(() => forged), headers: rpc().headers };
    const shifted = { ...own, startsAfter: { ...own.startsAfter, height: own.startsAfter.height + 1 } };
    expect(await verifyFinality({ rpc: lying, block: { height: f.setEnd + 1, hash: toHex(j.target.hash) }, checkpoints: [shifted] })).toMatchObject({
      finalized: false,
      reason: expect.stringMatching(/carries 0 of 130 weight/),
    });
  });

  it("the real precommits finalize the block through its real headers, walking each header once", async () => {
    const [raw] = await rpc().proveFinality([f.block.height]);
    const proof = decodeFinalityProof(raw!);
    const { precommits } = proof.justification;
    const headers = proof.unknownHeaders;
    expect(headers.length).toBe(f.setEnd - f.block.height);
    const w = work({ ...proof.justification, target: { hash: fromHex(f.block.hash, "block hash"), number: f.block.height }, ancestries: headers }, own);
    report(`${network}, ${precommits.length} real precommits over ${headers.length} real headers`, w);
    expect(w.result).toEqual({ hash: fromHex(f.block.hash, "block hash"), number: f.block.height });
    expect(w.verifications).toBe(precommits.length);
    expect(w.links).toBeLessThanOrEqual(2 * headers.length);
  });

  it("the real precommits repeated to 0.6 MB over those headers, under a target they never reach, cost one Ed25519 check for each voter", async () => {
    const [raw] = await rpc().proveFinality([f.block.height]);
    const proof = decodeFinalityProof(raw!);
    const { precommits } = proof.justification;
    const headers = proof.unknownHeaders;
    const room = 600_000 - headers.reduce((n, h) => n + encodeHeader(h).length, 0);
    const repeated = Array.from({ length: Math.floor(room / 132) }, (_, i) => precommits[i % precommits.length]!);
    const w = work({ ...proof.justification, target: { hash: new Uint8Array(32), number: f.block.height }, precommits: repeated, ancestries: headers }, own);
    report(`${network}, real precommits x ${repeated.length} over ${headers.length} real headers`, w);
    expect(w.result).toEqual({ error: `the justification for block ${f.block.height} carries 0 of 130 weight under set ${own.setId}; finality needs 87` });
    expect(w.verifications).toBe(precommits.length);
    expect(w.links).toBeLessThanOrEqual(2 * headers.length);
  });

  it("the real justification still finalizes with its precommits repeated and non-voters' precommits added", async () => {
    const [raw] = await rpc().proveFinality([f.block.height]);
    const j = decodeFinalityProof(raw!).justification;
    const strangers = testKeys("stranger", 18).map((sk) => signedPrecommit(sk, j.target, j.round, own.setId));
    expect(justifiedTarget({ ...j, precommits: [...j.precommits, ...strangers, ...j.precommits, ...j.precommits] }, own)).toEqual(j.target);
  });

  it("refuses a block hash the finalized chain does not hold at that height", async () => {
    const forged = { ...f.block, hash: f.block.hash.replace(/^./, (c: string) => (c === "0" ? "1" : "0")) };
    expect(await verifyFinality({ rpc: rpc(), block: forged, checkpoints: [own] })).toMatchObject({
      finalized: false,
      reason: `the finalized chain holds ${f.block.hash} at height ${f.block.height}, not ${forged.hash}`,
    });
  });
});
