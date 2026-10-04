import { describe, expect, it } from "vitest";
import { judge, parseCrashStatus, unrecordedAnchors } from "../gate.mjs";
import { honestRehearsal, type Rehearsal } from "./fixture.js";

const run = (r: Rehearsal) => judge({ raw: r.raw, verified: r.verified, crash: r.crash, crashStatus: parseCrashStatus(r.crashStatus.join("\n")) });
const failuresOf = (edit: (r: Rehearsal) => void) => {
  const r = honestRehearsal();
  edit(r);
  return run(r).failures;
};
const journalLanded = (r: Rehearsal) => Object.values(r.journals).flat().filter((x) => x.state === "landed").map((x) => x.tx_hash);

describe("the evidence gate", () => {
  it("passes a complete, honest rehearsal and counts what it may claim", () => {
    const r = honestRehearsal();
    const { failures, facts } = run(r);
    expect(failures).toEqual([]);
    expect(facts.anchors).toEqual({ total: 19, byKind: { 1: 16, 2: 3 }, crash: 2 });
    expect(facts.crashDrill.map((d: { mode: string; resent: number }) => [d.mode, d.resent])).toEqual([["kill-before", 1], ["kill-after", 0]]);
    expect(facts.nodeNegatives.map((n: { code: number }) => n.code)).toEqual([1010, 1010, 1010]);
    expect(facts.verifierNegatives).toBe(12);
    expect(facts.sameBlock).toMatchObject({ height: 1040, anchors: ["same-block-a-1", "same-block-b-1"] });
    expect(unrecordedAnchors(r.raw, journalLanded(r))).toEqual([]);
  });

  describe("every anchor the rehearsal wrote is verified", () => {
    it("refuses crash-drill anchors that only the crash log holds", () => {
      const failures = failuresOf((r) => {
        for (const label of ["crash-before-broadcast", "crash-after-broadcast"]) {
          delete r.raw.anchors[label];
          delete r.verified.anchors[label];
        }
      });
      expect(failures).toEqual(expect.arrayContaining([expect.stringMatching(/^crash drill anchor crash-before-broadcast \([0-9a-f]{64}\) is not among the recorded anchors$/), expect.stringMatching(/^crash drill anchor crash-after-broadcast /)]));
    });

    it("refuses a recorded anchor the verifier never checked", () => {
      expect(failuresOf((r) => delete r.verified.anchors["crash-after-broadcast"])).toContain("anchor crash-after-broadcast: not verified");
    });

    it("refuses an anchor left unverified-finality, unavailable, or valid below consensus-verified", () => {
      expect(failuresOf((r) => Object.assign(r.verified.anchors["git-head"], { status: "unverified-finality", assurance: "multi-path", failed: ["finality: no finality checkpoint lies below block 1010"] }))).toContain(
        "anchor git-head: unverified-finality at multi-path assurance (finality: no finality checkpoint lies below block 1010)",
      );
      expect(failuresOf((r) => Object.assign(r.verified.anchors["hidden-relay-suite"], { status: "unavailable", assurance: "single-path" }))[0]).toMatch(/^anchor hidden-relay-suite: unavailable at single-path/);
      expect(failuresOf((r) => Object.assign(r.verified.anchors.uname, { assurance: "multi-path" }))[0]).toMatch(/^anchor uname: valid at multi-path/);
    });

    it("refuses a verdict on another transaction than the one recorded", () => {
      expect(failuresOf((r) => (r.verified.anchors["git-log"].txHash = "ab".repeat(32)))[0]).toMatch(/^anchor git-log: the verifier checked abab/);
    });

    it("refuses fewer than 10 kind-1 or 2 kind-2 anchors", () => {
      expect(
        failuresOf((r) => {
          for (const l of ["hidden-relay-suite", "hidden-keys-suite"]) delete r.raw.anchors[l];
        }),
      ).toEqual(["1 kind-2 anchors verified valid, fewer than 2"]);
    });
  });

  describe("the node-enforced negatives count only the node's own refusal", () => {
    const negative = "VerifierKeyRemove(anchor), signed by a stranger at index 0";
    it("refuses a transport failure recorded as a rejection", () => {
      const failures = failuresOf((r) => (r.raw.negatives[negative] = { txHash: "cd".repeat(32), rejected: true, by: "node author_submitExtrinsic", error: "midnight node: fetch failed", onChain: 0 }));
      expect(failures).toEqual([`negative ${negative}: no refusal by the node was recorded (midnight node: fetch failed), not 1010 Invalid Transaction`]);
    });

    it("refuses a node answer other than 1010 Invalid Transaction", () => {
      expect(failuresOf((r) => (r.raw.negatives[negative].refusal = { code: 1012, message: "Transaction is temporarily banned" }))).toEqual([
        `negative ${negative}: the node answered 1012 Transaction is temporarily banned, not 1010 Invalid Transaction`,
      ]);
    });

    it("refuses a refused transaction the indexer lists anyway, a missing case, and a registry not re-checked", () => {
      expect(failuresOf((r) => (r.raw.negatives[negative].onChain = 1))).toEqual([`negative ${negative}: the indexer lists it 1 times`]);
      expect(failuresOf((r) => delete r.raw.negatives["ReplaceAuthority, unsigned"])).toEqual(["0 ReplaceAuthority negatives recorded, not 1"]);
      expect(failuresOf((r) => delete r.raw.negativesAfter)).toEqual(["the registry state was not re-checked after the negatives"]);
    });
  });

  describe("the rotation drill", () => {
    it("refuses a verdict other than the expected one under any document set", () => {
      expect(failuresOf((r) => (r.verified.rotation["serial 3"]["revoked-new-after"].status = "valid"))).toEqual(["rotation serial 3, revoked-new-after: valid at consensus-verified assurance, expected author-revoked"]);
      expect(failuresOf((r) => (r.verified.rotation["serial 3 with serial 1 passed again"]["rotation-old-after"].status = "valid"))).toHaveLength(1);
      expect(failuresOf((r) => (r.verified.rotation["serial 1"]["rotation-new-after"].status = "unavailable"))).toHaveLength(1);
    });

    it("refuses an accepted forged document, an anchor by the wrong key, and anchors out of order", () => {
      expect(failuresOf((r) => (r.verified.rotation.forgedSignature = "ACCEPTED"))).toEqual(["a KNOWN_AUTHORS document with a forged signature was ACCEPTED"]);
      expect(failuresOf((r) => (r.raw.anchors["rotation-new-after"].author = r.raw.rotation.keys.relay1))[0]).toMatch(/^rotation anchor rotation-new-after: written by [0-9a-f]{64}, not relay2/);
      expect(failuresOf((r) => (r.raw.anchors["rotation-old-after"].blockHeight = 1060))[0]).toMatch(/^the rotation anchors are not four anchors in increasing blocks/);
    });
  });

  describe("the verifier negatives", () => {
    const name = "a stranger as the expected author";
    it("refuses a negative that verified valid", () => {
      expect(failuresOf((r) => (r.verified.negatives[name] = { status: "valid", assurance: "consensus-verified", failed: [] }))).toEqual([`verifier negative "${name}": valid at consensus-verified assurance, expected unauthenticated from the author check`]);
    });

    it("refuses a negative that failed for another cause, such as a source that could not answer", () => {
      expect(failuresOf((r) => (r.verified.negatives["finality skipped"] = { status: "unavailable", assurance: "single-path", failed: ["node: fetch failed"] }))).toHaveLength(1);
      expect(failuresOf((r) => (r.verified.negatives["a registry at another address"].failed = ["indexer: as recorded"]))).toHaveLength(1);
      expect(failuresOf((r) => delete r.verified.negatives[name])).toEqual([`verifier negative "${name}": not verified, expected unauthenticated from the author check`]);
    });
  });

  describe("the journal crash drill", () => {
    const at = (r: Rehearsal, label: string, event: string) => r.crash.find((e) => e.label === label && e.event.startsWith(event))!;
    it("refuses a recovery that landed other bytes than the journal held", () => {
      expect(failuresOf((r) => (at(r, "crash-before-broadcast", "landed").receipt.txHash = "ef".repeat(32)))).toEqual(
        expect.arrayContaining([expect.stringMatching(/^crash drill crash-before-broadcast: the recovery landed efef/)]),
      );
    });

    it("refuses a second broadcast after the node had the bytes, and a resend missing before", () => {
      expect(failuresOf((r) => r.crash.push({ mode: "recover", label: "crash-after-broadcast", event: "broadcast", txHash: r.raw.anchors["crash-after-broadcast"].txHash }))[0]).toMatch(/^crash drill crash-after-broadcast: the recovery broadcast \["[0-9a-f]{64}"\], not \[\]/);
      expect(failuresOf((r) => r.crash.splice(r.crash.indexOf(at(r, "crash-before-broadcast", "broadcast")), 1))[0]).toMatch(/^crash drill crash-before-broadcast: the recovery broadcast \[\], not \["/);
    });

    it("refuses a kill step that was not a SIGKILL, and a death before the journal row existed", () => {
      expect(failuresOf((r) => (r.crashStatus[0] = "crash.ts kill-before crash-before-broadcast exit=0"))[0]).toMatch(/^crash drill crash-before-broadcast: steps exited \{"kill-before":0,"recover":0\}/);
      expect(failuresOf((r) => (at(r, "crash-after-broadcast", "dying").rows = []))).toEqual([expect.stringMatching(/^crash drill crash-after-broadcast: the journal held no pending row/)]);
    });
  });

  it("refuses a same-block pair that is missing, from one wallet, or in two blocks", () => {
    expect(failuresOf((r) => delete r.raw.sameBlock.coLanded)).toEqual(["no same-block pair was recorded among the anchors"]);
    expect(failuresOf((r) => (r.raw.anchors["same-block-b-1"].wallet = "walletA"))[0]).toMatch(/^same-block pair same-block-a-1 and same-block-b-1: wallets walletA and walletA/);
    expect(failuresOf((r) => (r.raw.anchors["same-block-b-1"].blockHeight = 1041))[0]).toMatch(/at heights 1040 and 1041, not two wallets in block 1040/);
  });

  it("refuses a deploy whose readback did not show the immutable state from both paths", () => {
    expect(failuresOf((r) => (r.raw.deploy.readback.byteEqual = false))).toEqual(["the registry deploy's readback did not show the same immutable state from the indexer and the node"]);
  });

  it("closes 'every anchor' over the journals: nothing landed unrecorded, nothing recorded that no journal landed", () => {
    const r = honestRehearsal();
    const landed = journalLanded(r);
    expect(unrecordedAnchors(r.raw, [...landed, "aa".repeat(32)])).toEqual([`transaction ${"aa".repeat(32)} landed through a rehearsal journal and is not among the recorded anchors`]);
    const missing = r.raw.anchors["uname"].txHash;
    expect(unrecordedAnchors(r.raw, landed.filter((t) => t !== missing))).toEqual([`anchor uname (${missing}) is in no rehearsal journal as landed`]);
  });
});
