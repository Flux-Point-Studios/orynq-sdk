// compose.ts end to end, as the rehearsal runs it: a rehearsal directory, a HOME whose 0600
// secrets and journals it reads, and the pack it writes or refuses to write.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { ABORTED_STATEMENT, REPOSITORY, abortedDrill, archiveAbortedDrill, honestRehearsal, partialDrill, refuseEarlier, removeScratch, scratch, sha256, writeRehearsal, type Rehearsal } from "./fixture.js";

const HERE = new URL("..", import.meta.url).pathname;

function compose(edit: (r: Rehearsal) => void = () => {}, afterWrite: (home: string, dir: string) => void = () => {}, r = honestRehearsal()) {
  const root = scratch("compose");
  edit(r);
  writeRehearsal(`${root}/rehearsal`, `${root}/home`, r);
  afterWrite(`${root}/home`, `${root}/rehearsal`);
  const out = `${root}/pack.json`;
  const run = spawnSync(process.execPath, ["--import", "tsx", "compose.ts", `${root}/rehearsal`, out], { cwd: HERE, encoding: "utf8", env: { ...process.env, HOME: `${root}/home` }, timeout: 60_000 });
  return { r, run, out, pack: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null };
}

afterAll(removeScratch);

describe("compose.ts", () => {
  it("writes a pack whose statements say exactly what the gate and the opening check established, and nothing else", () => {
    const { r, run, pack } = compose();
    expect(run.status, run.stderr).toBe(0);
    const a = r.raw.anchors;
    const signatureFails = "refused: the known-authors document's signature by a trust root does not verify";
    expect(pack.statements).toEqual([
      "All 19 anchors this rehearsal wrote outside the rotation drill, 19 distinct transactions (16 kind 1, 3 kind 2) with the 2 crash-drill anchors and the same-block pair among them, verified valid at consensus-verified assurance, each with the commitment the rehearsal recorded.",
      `The verifier ran in verify-all.mjs, a separate process that imports nothing but Node built-ins, gate.mjs and the verify package, and reads through Blockfrost preprod. It loaded the verify package only from its own node_modules, where npm installed it from file:fluxpointstudios-orynq-sdk-anchors-midnight-0.1.0.tgz (sha256 ${r.verified.package.sha256}), a tarball that still had the integrity npm recorded.`,
      "Every transaction the rehearsal's journals recorded as landed, other than the registry deploy, is one of these anchors or one of the rotation drill's four, and every recorded anchor is in a journal as landed.",
      `The rehearsal submitted same-block-a-1 from walletA and same-block-b-1 from walletB in round 1, and the verifier places both in block 1040 (${a["same-block-a-1"].blockHash}).`,
      "The four rotation-drill anchors gave the expected verdict under each set of KNOWN_AUTHORS documents (serial 1: rotation-old-before valid, rotation-old-after valid, rotation-new-after unauthenticated, revoked-new-after unauthenticated; serial 2: rotation-old-before valid, rotation-old-after author-revoked, rotation-new-after valid, revoked-new-after valid; serial 3: rotation-old-before valid, rotation-old-after author-revoked, rotation-new-after valid, revoked-new-after author-revoked; serial 3 with serial 1 passed again: rotation-old-before valid, rotation-old-after author-revoked, rotation-new-after valid, revoked-new-after author-revoked).",
      `The verify package answered each forged KNOWN_AUTHORS document as the gate requires (serial 3 with every author window reopened, under the trust root's signature on serial 3: ${signatureFails}; that document signed by a stranger, under the trust root's key: ${signatureFails}; that document signed by a stranger, under the stranger's key: refused: the known-authors document carries no signature by a trust root; positive control: that document signed by a stranger, with the stranger as the trust root: opened). Ed25519 verification refused both forgeries under the trust root's key, and the same document opened under the stranger's signature with the stranger as trust root.`,
      "Blockfrost's preprod node answered each of the 3 maintenance transactions at submission with JSON-RPC error 1010 \"Invalid Transaction\" and the maintenance authority's own custom code (ReplaceAuthority, unsigned: Custom error: 136, ThresholdMissed; VerifierKeyRemove(anchor), signed by a stranger at index 0: Custom error: 134, KeyNotInCommittee; VerifierKeyInsert(rewrite), signed by a stranger at index 0: Custom error: 134, KeyNotInCommittee). Blockfrost's indexer lists none of them, asked by the rehearsal after each refusal and by the verifier, and the registry state Blockfrost's node reported afterwards still passes the immutability check.",
      'The journal crash drill killed the submitter with SIGKILL (exit 137) once after the journal row was written and before the bytes went to the node (crash.ts logged "dying before broadcast", and the restart broadcast those bytes once), and once after the node accepted the bytes (crash.ts logged "dying after the node accepted the bytes", and the restart broadcast nothing); each restart landed exactly the transaction its journal held.',
      "Each of the 12 verifier negatives returned its expected status from its expected check.",
      "The operator's private receipts hold an opening (root, manifest, merkle, salt) for each of the 3 kind-2 anchors, and each recomputes the commitment the verifier read for its anchor. None of them is in this pack: the scan below finds no 8-byte window of any of them in five encodings, and finds windows of the salts and root hashes in the receipts.",
      `The KNOWN_AUTHORS documents here are signed by trust root ${r.root}, which is not among the trust roots the verify package ships, and each names only the preprod network.`,
    ]);
    const names = pack.anchors.map((x: { name: string }) => x.name);
    expect(names).toEqual(expect.arrayContaining(["crash-before-broadcast", "crash-after-broadcast"]));
    expect(pack.anchors.find((x: { name: string }) => x.name === "crash-after-broadcast").verifier).toMatchObject({ status: "valid", assurance: "consensus-verified", txHash: a["crash-after-broadcast"].txHash });
    expect(pack.nodeEnforcedNegatives.map((n: { name: string; refusal: unknown }) => [n.name, n.refusal])).toEqual(Object.entries(r.raw.negatives).map(([name, n]) => [name, (n as { refusal: unknown }).refusal]));
    expect(pack.knownAuthorsDrill.forgedDocuments).toEqual(r.verified.forgedDocuments);
    expect(pack.verifier.package).toEqual(r.verified.package);
    expect(pack.privacyScan.windowsOfSecretsInPack).toBe(0);
    expect(Object.keys(pack.journalCrashDrill)).toEqual(["windows", "steps", "log"]);
  });

  it("describes the deploy that landed, not a prepare an earlier run journalled and the chain later ruled out", () => {
    const abandoned = "3c".repeat(32);
    const { r, run, pack } = compose((r) => (r.journals["journal-deploy.sqlite"] = [{ tx_hash: abandoned, state: "failed" }, ...r.journals["journal-deploy.sqlite"]!]));
    expect(run.status, run.stderr).toBe(0);
    expect(pack.registry).toMatchObject({ deployTxHash: r.raw.deploy.txHash, preparedOnFinalBytes: { txHash: r.raw.deploy.txHash, address: r.raw.deploy.address } });
    expect(JSON.stringify(pack)).not.toContain(abandoned);
  });

  it("refuses a kind-2 opening that does not recompute the commitment the verifier read, and a kind-2 anchor with no opening", () => {
    const wrong = compose((r) => (r.openings["hidden-relay-suite"]!.salt = "11".repeat(32)));
    expect(wrong.pack).toBeNull();
    expect(wrong.run.status).toBe(1);
    expect(wrong.run.stderr).toMatch(new RegExp(`GATE: kind-2 anchor hidden-relay-suite: its opening recomputes [0-9a-f]{64}, not the commitment ${wrong.r.raw.anchors["hidden-relay-suite"].commitment} the verifier read`));
    const missing = compose((r) => delete r.openings["hidden-keys-suite"]);
    expect(missing.pack).toBeNull();
    expect(missing.run.stderr).toContain(`GATE: kind-2 anchor hidden-keys-suite: the private receipts hold no opening for ${missing.r.raw.anchors["hidden-keys-suite"].txHash}`);
  });

  it("refuses the reviewer's pack: an anchor at unverified-finality, crash anchors only in the crash log, a transport failure counted as a node refusal", () => {
    const negative = "ReplaceAuthority, unsigned";
    const { run, pack } = compose((r) => {
      Object.assign(r.verified.anchors["git-head"], { status: "unverified-finality", assurance: "multi-path" });
      for (const label of ["crash-before-broadcast", "crash-after-broadcast"]) {
        delete r.raw.anchors[label];
        delete r.verified.anchors[label];
      }
      r.journals["journal-crash.sqlite"] = [];
      r.raw.negatives[negative] = { txHash: "cd".repeat(32), rejected: true, by: "node author_submitExtrinsic", error: "midnight node: fetch failed", onChain: 0 };
    });
    expect(pack).toBeNull();
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/anchor git-head: unverified-finality at multi-path assurance/);
    expect(run.stderr).toMatch(/crash drill anchor crash-before-broadcast \([0-9a-f]{64}\) is not among the recorded anchors/);
    expect(run.stderr).toMatch(/negative ReplaceAuthority, unsigned: no refusal by the node was recorded \(midnight node: fetch failed\)/);
  });

  it("refuses review2's pack: every maintenance update refused as Custom error: 196 (DustDoubleSpend), which the authority never answers", () => {
    const { run, pack } = compose((r) => {
      for (const n of Object.values(r.raw.negatives as Record<string, any>)) n.refusal = { code: 1010, message: "Invalid Transaction", data: "Custom error: 196" };
    });
    expect(pack).toBeNull();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("GATE: negative ReplaceAuthority, unsigned: the node answered 1010 Invalid Transaction (Custom error: 196), not 1010 Invalid Transaction (Custom error: 136, ThresholdMissed)");
    expect(run.stderr).toContain("no pack written: 3 claims are not established");
  });

  it("writes nothing when the privacy scan finds a secret in the pack", () => {
    let leaked = "";
    const { run, out } = compose(
      (r) => (leaked = r.raw.anchors["git-log"].commitment),
      (home) => writeFileSync(`${home}/.secrets/orynq-midnight-preprod/author-relay-2.key`, `${leaked}\n`, { mode: 0o600 }),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no pack written: the privacy scan failed");
    expect(existsSync(out)).toBe(false);
  });

  describe("a crash drill that aborted before any kill point", () => {
    it("is disclosed in the pack beside the drill that ran, and nothing else in the pack changes", () => {
      const r = honestRehearsal();
      const files = abortedDrill();
      const plain = compose(undefined, undefined, r);
      const disclosed = compose(undefined, (_, dir) => archiveAbortedDrill(dir, 1, files), r);
      expect(plain.run.status, plain.run.stderr).toBe(0);
      expect(disclosed.run.status, disclosed.run.stderr).toBe(0);
      const { abortedAttempts, ...drill } = disclosed.pack.journalCrashDrill;
      expect(abortedAttempts).toEqual([
        {
          archive: "crash-drill-aborted-1",
          statement: ABORTED_STATEMENT,
          sha256: { "crash.log": sha256(files["crash.log"]!), "crash.log.status": sha256(files["crash.log.status"]!), "crash.err": sha256(files["crash.err"]!) },
          steps: ["kill-before crash-before-broadcast", "recover crash-before-broadcast", "kill-after crash-after-broadcast", "recover crash-after-broadcast"].map((step) => {
            const [mode, label] = step.split(" ");
            return { mode, label, exit: 1 };
          }),
          log: files["crash.log"]!.trim().split("\n").map((l) => JSON.parse(l)),
          errors: { shown: [{ line: "Wallet.InsufficientFunds: Insufficient Funds: could not balance dust", times: 4 }], notShown: 0 },
        },
      ]);
      const statement =
        "Before that drill, 1 earlier attempt aborted before any kill point, and journalCrashDrill.abortedAttempts discloses it with each archived file's sha256, which its MANIFEST.sha256 records: crash-drill-aborted-1, whose 4 steps exited 1, 1, 1 and 1, none of them at a kill point, and whose crash journal held no row in any of its 4 logged events.";
      expect(disclosed.pack.statements).toEqual([...plain.pack.statements.slice(0, 8), statement, ...plain.pack.statements.slice(8)]);
      expect({ ...disclosed.pack, date: null, statements: null, journalCrashDrill: drill }).toEqual({ ...plain.pack, date: null, statements: null });
      expect(JSON.stringify(disclosed.pack)).not.toContain(REPOSITORY);
    });

    it("writes no pack when an archived file no longer has the sha256 its MANIFEST.sha256 records", () => {
      const files = abortedDrill();
      const recorded = sha256(files["crash.log"]!);
      files["crash.log"] = files["crash.log"]!.split("\n").slice(1).join("\n");
      const { run, out } = compose(undefined, (_, dir) => archiveAbortedDrill(dir, 1, files));
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`GATE: aborted crash drill crash-drill-aborted-1: crash.log has sha256 ${sha256(files["crash.log"])}, not the ${recorded} its MANIFEST.sha256 records`);
      expect(existsSync(out)).toBe(false);
    });

    it("writes no pack when the archive holds a partial drill: an attempt that reached a kill point is a pass of the drill, not an abort", () => {
      const { run, out } = compose(undefined, (_, dir) => archiveAbortedDrill(dir, 1, partialDrill()));
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('GATE: aborted crash drill crash-drill-aborted-1: it reached a kill point (kill-before crash-before-broadcast: "dying before broadcast"), so it is a pass of the drill, not an abort');
      expect(existsSync(out)).toBe(false);
    });

    it("never stands in for the drill that must still pass every check", () => {
      const { run, out } = compose(
        (r) => r.crash.splice(r.crash.findIndex((e) => e.mode === "kill-after"), 1),
        (_, dir) => archiveAbortedDrill(dir, 1),
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('GATE: crash drill crash-after-broadcast: its kill step logged [], not one kill-after step that said "dying after the node accepted the bytes"');
      expect(existsSync(out)).toBe(false);
    });

    it("writes no pack when the attempt's error output carries a secret", () => {
      const { run, out } = compose(undefined, (home, dir) => {
        const salt = readFileSync(`${home}/.secrets/orynq-midnight-preprod/salt.key`, "utf8").trim();
        archiveAbortedDrill(dir, 1, abortedDrill((f) => (f["crash.err"] += `Error: no fee for salt ${salt}\n`)));
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("no pack written: the privacy scan failed");
      expect(existsSync(out)).toBe(false);
    });
  });

  describe("an anchor transaction the node refused", () => {
    it("is carried into the pack beside the later transaction for its label that landed, and nothing else in the pack changes", () => {
      const r = honestRehearsal();
      const plain = compose(undefined, undefined, r);
      const refusal = refuseEarlier(r, "rotation-new-after");
      const disclosed = compose(undefined, undefined, r);
      expect(plain.run.status, plain.run.stderr).toBe(0);
      expect(disclosed.run.status, disclosed.run.stderr).toBe(0);
      const landedAs = r.raw.anchors["rotation-new-after"].txHash;
      expect(disclosed.pack.anchorRefusals).toEqual([{ ...refusal, landedAs }]);
      const statement = `The node refused 1 anchor transaction when it was submitted, which run.ts recorded as the node answered (rotation-new-after: ${refusal.txHash}, 1010 Custom error: 170, at 2026-10-05T23:30:24.000Z), and a later transaction for the same label landed: the anchor the pack records and the verifier checked for it (rotation-new-after: ${landedAs}).`;
      expect(disclosed.pack.statements).toEqual([...plain.pack.statements.slice(0, 3), statement, ...plain.pack.statements.slice(3)]);
      const { anchorRefusals: _, ...rest } = disclosed.pack;
      expect({ ...rest, date: null, statements: null }).toEqual({ ...plain.pack, date: null, statements: null });
    });

    it("writes no pack when no later transaction for its label landed", () => {
      const { run, out } = compose((r) => (r.raw.anchorRefusals = [{ label: "same-block-a-2", txHash: "e1".repeat(32), code: 1010, data: "Custom error: 170", at: "2026-10-05T23:30:24.000Z" }]));
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`GATE: the node refused same-block-a-2's transaction ${"e1".repeat(32)} (1010, Custom error: 170) at 2026-10-05T23:30:24.000Z, and no transaction for same-block-a-2 landed after it`);
      expect(existsSync(out)).toBe(false);
    });
  });

  it("refuses when a journal saw an anchor land that the rehearsal never recorded", () => {
    const stray = "ab".repeat(32);
    const { run, pack } = compose(undefined, (home) => {
      const db = new DatabaseSync(`${home}/.secrets/orynq-midnight-preprod/journal-walletB.sqlite`);
      db.prepare("insert into attempts (key, tx_hash, bytes, ttl_ms, state) values ('stray', ?, x'01', 0, 'landed')").run(stray);
      db.close();
    });
    expect(pack).toBeNull();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`transaction ${stray} landed through a rehearsal journal and is not among the recorded anchors`);
  });
});
