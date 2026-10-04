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

// The verify package's own answers: Ed25519 verification refuses the first two, the trust-root
// allow-list the third, and the control shows the forged document is otherwise well-formed.
const SIGNATURE_FAILS = "refused: the known-authors document's signature by a trust root does not verify";
const NO_TRUST_ROOT = "refused: the known-authors document carries no signature by a trust root";
const REOPENED = "serial 3 with every author window reopened, under the trust root's signature on serial 3";
const UNDER_ROOT_KEY = "that document signed by a stranger, under the trust root's key";
const FORGED: Record<string, string> = {
  [REOPENED]: SIGNATURE_FAILS,
  [UNDER_ROOT_KEY]: SIGNATURE_FAILS,
  "that document signed by a stranger, under the stranger's key": NO_TRUST_ROOT,
  "positive control: that document signed by a stranger, with the stranger as the trust root": "opened",
};

describe("the evidence gate", () => {
  it("passes a complete, honest rehearsal and counts what it may claim", () => {
    const r = honestRehearsal();
    const { failures, facts } = run(r);
    expect(failures).toEqual([]);
    expect(facts.anchors).toEqual({ total: 19, byKind: { 1: 16, 2: 3 }, crash: 2 });
    expect(facts.crashDrill.map((d: { label: string; mode: string; said: string; resent: number }) => [d.label, d.mode, d.said, d.resent])).toEqual([
      ["crash-before-broadcast", "kill-before", "dying before broadcast", 1],
      ["crash-after-broadcast", "kill-after", "dying after the node accepted the bytes", 0],
    ]);
    expect(facts.nodeNegatives.map((n: { name: string; refusal: unknown; refusedBy: string }) => [n.name, n.refusal, n.refusedBy])).toEqual([
      ["ReplaceAuthority, unsigned", { code: 1010, message: "Invalid Transaction", data: "Custom error: 136" }, "ThresholdMissed"],
      ["VerifierKeyRemove(anchor), signed by a stranger at index 0", { code: 1010, message: "Invalid Transaction", data: "Custom error: 134" }, "KeyNotInCommittee"],
      ["VerifierKeyInsert(rewrite), signed by a stranger at index 0", { code: 1010, message: "Invalid Transaction", data: "Custom error: 134" }, "KeyNotInCommittee"],
    ]);
    expect(facts.verifierNegatives).toBe(12);
    expect(facts.sameBlock).toEqual({ height: 1040, hash: r.raw.anchors["same-block-a-1"].blockHash, anchors: ["same-block-a-1", "same-block-b-1"], wallets: ["walletA", "walletB"], round: 1 });
    expect(facts.forgedDocuments).toEqual(Object.entries(FORGED).map(([name, outcome]) => ({ name, outcome })));
    expect(facts.package).toEqual(r.verified.package);
    expect(facts.trustRoot).toBe(r.root);
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

    it("counts distinct transactions: refuses one transaction recorded under two names, and a kind the registry never writes", () => {
      const r = honestRehearsal();
      const twice = r.raw.anchors["hidden-relay-suite"].txHash;
      r.raw.anchors["hidden-keys-suite"] = { ...r.raw.anchors["hidden-relay-suite"] };
      r.verified.anchors["hidden-keys-suite"] = { ...r.verified.anchors["hidden-relay-suite"] };
      expect(run(r).failures).toEqual([`anchors hidden-relay-suite and hidden-keys-suite record the same transaction ${twice}`]);
      expect(failuresOf((r) => (r.raw.anchors.uname.kind = 3))).toEqual(["anchor uname: kind 3 is not one the registry writes"]);
    });

    it("refuses an anchor whose commitment the verifier read differently from the one recorded", () => {
      expect(failuresOf((r) => (r.verified.anchors["git-log"].commitment = "ee".repeat(32)))).toEqual([expect.stringMatching(/^anchor git-log: the verifier read commitment e{64}, not the recorded [0-9a-f]{64}$/)]);
    });

    it("refuses fewer than 10 kind-1 or 2 kind-2 anchors", () => {
      expect(
        failuresOf((r) => {
          for (const l of ["hidden-relay-suite", "hidden-keys-suite"]) delete r.raw.anchors[l];
        }),
      ).toEqual(["1 kind-2 anchors verified valid, fewer than 2"]);
    });
  });

  describe("the node-enforced negatives count only the maintenance authority's own refusal", () => {
    const negative = "VerifierKeyRemove(anchor), signed by a stranger at index 0";
    const unsigned = "ReplaceAuthority, unsigned";
    const insert = "VerifierKeyInsert(rewrite), signed by a stranger at index 0";
    const want: Record<string, string> = { [unsigned]: "1010 Invalid Transaction (Custom error: 136, ThresholdMissed)", [negative]: "1010 Invalid Transaction (Custom error: 134, KeyNotInCommittee)", [insert]: "1010 Invalid Transaction (Custom error: 134, KeyNotInCommittee)" };
    const answering = (data: string) => (r: Rehearsal) => {
      for (const n of Object.values(r.raw.negatives as Record<string, any>)) n.refusal = { code: 1010, message: "Invalid Transaction", data };
    };

    it("refuses a transport failure recorded as a rejection", () => {
      const failures = failuresOf((r) => (r.raw.negatives[negative] = { txHash: "cd".repeat(32), rejected: true, by: "node author_submitExtrinsic", error: "midnight node: fetch failed", onChain: 0 }));
      expect(failures).toEqual([`negative ${negative}: no refusal by the node was recorded (midnight node: fetch failed), not ${want[negative]}`]);
    });

    it("refuses a node answer other than 1010 Invalid Transaction, even one carrying the authority's code", () => {
      expect(failuresOf((r) => (r.raw.negatives[negative].refusal = { code: 1012, message: "Transaction is temporarily banned" }))).toEqual([
        `negative ${negative}: the node answered 1012 Transaction is temporarily banned, not ${want[negative]}`,
      ]);
      expect(failuresOf((r) => (r.raw.negatives[negative].refusal = { code: 1002, message: "Verification Error: Runtime error", data: "Custom error: 134" }))).toEqual([
        `negative ${negative}: the node answered 1002 Verification Error: Runtime error (Custom error: 134), not ${want[negative]}`,
      ]);
    });

    // Codes from midnight-node's ledger custom-error map: each is a 1010 Invalid Transaction from a
    // guard other than the maintenance authority, and 196 comes from the application stage, after
    // the authority check passed. "Transaction is outdated" is Substrate's 1010 for a stale one.
    it.each([
      ["110 VerifierKeyNotSet", "Custom error: 110"],
      ["138 BalanceCheckOverspend", "Custom error: 138"],
      ["196 DustDoubleSpend", "Custom error: 196"],
      ["170 InvalidDustSpendProof", "Custom error: 170"],
      ["a stale transaction", "Transaction is outdated"],
    ])("refuses a 1010 Invalid Transaction for another reason: %s", (_, data) => {
      expect(failuresOf(answering(data))).toEqual(
        [unsigned, negative, insert].map((name) => `negative ${name}: the node answered 1010 Invalid Transaction (${data}), not ${want[name]}`),
      );
    });

    it("refuses the authority's code under a message other than Invalid Transaction", () => {
      expect(failuresOf((r) => (r.raw.negatives[unsigned].refusal.message = "Transaction is outdated"))).toEqual([
        `negative ${unsigned}: the node answered 1010 Transaction is outdated (Custom error: 136), not ${want[unsigned]}`,
      ]);
    });

    it("refuses a refused transaction that Blockfrost, asked by the verifier, holds or could not look up", () => {
      const absent = (r: Rehearsal, name: string) => `not invalid with "indexer: the indexer knows no transaction ${r.raw.negatives[name].txHash}"`;
      const r1 = honestRehearsal();
      Object.assign(r1.verified.refusedTransactions[negative], { failed: ["anchor: as recorded"] });
      expect(run(r1).failures).toEqual([`negative ${negative}: Blockfrost, asked by the verifier, answered invalid at none assurance (anchor: as recorded), ${absent(r1, negative)}`]);
      const r2 = honestRehearsal();
      r2.verified.refusedTransactions[negative].status = "unavailable";
      expect(run(r2).failures).toEqual([`negative ${negative}: Blockfrost, asked by the verifier, answered unavailable at none assurance (indexer: the indexer knows no transaction ${r2.raw.negatives[negative].txHash}), ${absent(r2, negative)}`]);
      const r3 = honestRehearsal();
      r3.verified.refusedTransactions[negative].txHash = "ab".repeat(32);
      expect(run(r3).failures).toEqual([`negative ${negative}: Blockfrost, asked by the verifier, answered about ${"ab".repeat(32)}, ${absent(r3, negative)}`]);
      const r4 = honestRehearsal();
      delete r4.verified.refusedTransactions[unsigned];
      expect(run(r4).failures).toEqual([`negative ${unsigned}: Blockfrost, asked by the verifier, answered not verified, ${absent(r4, unsigned)}`]);
    });

    it("refuses each authority code for the case it does not belong to, and a 1010 with no custom code", () => {
      expect(failuresOf((r) => (r.raw.negatives[unsigned].refusal.data = "Custom error: 134"))).toEqual([`negative ${unsigned}: the node answered 1010 Invalid Transaction (Custom error: 134), not ${want[unsigned]}`]);
      expect(failuresOf((r) => (r.raw.negatives[insert].refusal.data = "Custom error: 136"))).toEqual([`negative ${insert}: the node answered 1010 Invalid Transaction (Custom error: 136), not ${want[insert]}`]);
      expect(failuresOf((r) => delete r.raw.negatives[negative].refusal.data)).toEqual([`negative ${negative}: the node answered 1010 Invalid Transaction, not ${want[negative]}`]);
    });

    it("refuses a refused transaction the indexer lists anyway, a missing or unknown case, and a registry not re-checked", () => {
      expect(failuresOf((r) => (r.raw.negatives[negative].onChain = 1))).toEqual([`negative ${negative}: the indexer lists it 1 times`]);
      expect(failuresOf((r) => delete r.raw.negatives[unsigned])).toEqual([`negative ${unsigned} was not recorded`]);
      expect(failuresOf((r) => (r.raw.negatives["ReplaceAuthority, signed by a stranger at index 0"] = { ...r.raw.negatives[negative] }))).toEqual([
        "negative ReplaceAuthority, signed by a stranger at index 0 is not one of the maintenance updates the gate knows the refusal for",
      ]);
      expect(failuresOf((r) => delete r.raw.negativesAfter)).toEqual(["the registry state was not re-checked after the negatives"]);
    });
  });

  describe("the rotation drill", () => {
    it("refuses a verdict other than the expected one under any document set", () => {
      expect(failuresOf((r) => (r.verified.rotation["serial 3"]["revoked-new-after"].status = "valid"))).toEqual(["rotation serial 3, revoked-new-after: valid at consensus-verified assurance, expected author-revoked"]);
      expect(failuresOf((r) => (r.verified.rotation["serial 3 with serial 1 passed again"]["rotation-old-after"].status = "valid"))).toHaveLength(1);
      expect(failuresOf((r) => (r.verified.rotation["serial 1"]["rotation-new-after"].status = "unavailable"))).toHaveLength(1);
    });

    it("refuses an anchor by the wrong key, and anchors out of order", () => {
      expect(failuresOf((r) => (r.raw.anchors["rotation-new-after"].author = r.raw.rotation.keys.relay1))[0]).toMatch(/^rotation anchor rotation-new-after: written by [0-9a-f]{64}, not relay2/);
      expect(failuresOf((r) => (r.raw.anchors["rotation-old-after"].blockHeight = 1060))[0]).toMatch(/^the rotation anchors are not four anchors in increasing blocks/);
    });
  });

  describe("forged KNOWN_AUTHORS documents count only with the verify package's answer from the check each targets", () => {
    const answered = (name: string, outcome: string) => (r: Rehearsal) => (r.verified.forgedDocuments[name] = { outcome });

    // The allow-list refuses a stranger's key beside the root's signature before any signature
    // is verified, so a verifier that skipped Ed25519 verification gives that answer too.
    it("refuses the allow-list's refusal of a trust-root forgery, which never reached the signature check", () => {
      expect(failuresOf(answered(REOPENED, NO_TRUST_ROOT))).toEqual([`forged KNOWN_AUTHORS document "${REOPENED}": ${NO_TRUST_ROOT}, not ${SIGNATURE_FAILS}`]);
      expect(failuresOf(answered(UNDER_ROOT_KEY, NO_TRUST_ROOT))).toEqual([`forged KNOWN_AUTHORS document "${UNDER_ROOT_KEY}": ${NO_TRUST_ROOT}, not ${SIGNATURE_FAILS}`]);
    });

    it("refuses a forgery that opened, one refused for a malformed signature or by the document parser, and a control that did not open", () => {
      expect(failuresOf(answered(REOPENED, "opened"))).toEqual([`forged KNOWN_AUTHORS document "${REOPENED}": opened, not ${SIGNATURE_FAILS}`]);
      const malformed = "refused: the known-authors document's signature by a trust root is not 64 bytes of lowercase hex";
      expect(failuresOf(answered(UNDER_ROOT_KEY, malformed))).toEqual([`forged KNOWN_AUTHORS document "${UNDER_ROOT_KEY}": ${malformed}, not ${SIGNATURE_FAILS}`]);
      expect(failuresOf(answered(REOPENED, "refused: preprod.authors gives overlapping windows for key aa"))).toHaveLength(1);
      const control = "positive control: that document signed by a stranger, with the stranger as the trust root";
      expect(failuresOf(answered(control, "refused: preprod.authors gives overlapping windows for key aa"))).toEqual([
        `forged KNOWN_AUTHORS document "${control}": refused: preprod.authors gives overlapping windows for key aa, not opened`,
      ]);
    });

    it("refuses a forgery not tried and one the gate holds no answer for", () => {
      expect(failuresOf((r) => delete r.verified.forgedDocuments[UNDER_ROOT_KEY])).toEqual([`forged KNOWN_AUTHORS document "${UNDER_ROOT_KEY}": not tried, not ${SIGNATURE_FAILS}`]);
      expect(failuresOf(answered("a stranger's key beside the root's signature", NO_TRUST_ROOT))).toEqual([
        `forged KNOWN_AUTHORS document "a stranger's key beside the root's signature" is not one the gate holds an answer for`,
      ]);
    });
  });

  describe("the drill's trust root", () => {
    it("refuses a trust root the verify package ships, and documents naming any network but preprod", () => {
      expect(failuresOf((r) => (r.verified.shippedTrustRoots = [r.root]))).toEqual([expect.stringMatching(/^the drill's trust root [0-9a-f]{64} is one the verify package ships$/)]);
      expect(failuresOf((r) => delete r.verified.shippedTrustRoots)).toEqual(["the verifier did not record the trust roots the verify package ships"]);
      expect(failuresOf((r) => (r.verified.knownAuthorsDocuments[1].networks = ["mainnet", "preprod"]))).toEqual([
        'the drill\'s KNOWN_AUTHORS documents name the networks [["preprod"],["mainnet","preprod"],["preprod"]], not preprod alone in each of three',
      ]);
    });
  });

  describe("the verify package", () => {
    it("refuses a verify package not recorded as installed from a packed tarball", () => {
      const refused = "the verifier recorded no install of the verify package from a packed tarball";
      expect(failuresOf((r) => (r.verified.package.resolved = "file:../../anchors-midnight"))).toEqual([expect.stringMatching(new RegExp(`^${refused} \\(`))]);
      expect(failuresOf((r) => (r.verified.package.integrity = "sha1-abc"))).toEqual([expect.stringMatching(new RegExp(`^${refused} \\(`))]);
      expect(failuresOf((r) => delete r.verified.package)).toEqual([`${refused} (null)`]);
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

    // Each window has one kill mode, and the kill step must say where it died in crash.ts's words.
    it("refuses a window run in the other kill mode, or a kill step that died elsewhere", () => {
      const asAfter = (r: Rehearsal) => {
        Object.assign(at(r, "crash-before-broadcast", "dying"), { mode: "kill-after", event: "dying after the node accepted the bytes" });
        r.crashStatus[0] = "crash.ts kill-after crash-before-broadcast exit=137";
      };
      expect(failuresOf(asAfter)).toEqual(['crash drill crash-before-broadcast: its kill step logged [["kill-after","dying after the node accepted the bytes"]], not one kill-before step that said "dying before broadcast"']);
      expect(failuresOf((r) => (at(r, "crash-after-broadcast", "dying").event = "dying before broadcast"))).toEqual([
        'crash drill crash-after-broadcast: its kill step logged [["kill-after","dying before broadcast"]], not one kill-after step that said "dying after the node accepted the bytes"',
      ]);
      expect(failuresOf((r) => (at(r, "crash-before-broadcast", "dying").mode = "kill-after"))).toEqual([
        'crash drill crash-before-broadcast: its kill step logged [["kill-after","dying before broadcast"]], not one kill-before step that said "dying before broadcast"',
      ]);
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

  it("refuses a same-block pair the verifier places in two blocks, though the rehearsal recorded one", () => {
    const r = honestRehearsal();
    r.verified.anchors["same-block-b-1"].block = { height: 1041, hash: "dd".repeat(32) };
    expect(run(r).failures).toEqual([
      `same-block pair same-block-a-1 and same-block-b-1: the verifier places them in blocks 1040 (${r.raw.anchors["same-block-a-1"].blockHash}) and 1041 (${"dd".repeat(32)}), not both in block 1040`,
    ]);
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
