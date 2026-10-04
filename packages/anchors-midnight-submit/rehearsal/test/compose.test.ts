// compose.ts end to end, as the rehearsal runs it: a rehearsal directory, a HOME whose 0600
// secrets and journals it reads, and the pack it writes or refuses to write.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { honestRehearsal, removeScratch, scratch, writeRehearsal, type Rehearsal } from "./fixture.js";

const HERE = new URL("..", import.meta.url).pathname;

function compose(edit: (r: Rehearsal) => void = () => {}, afterWrite: (home: string) => void = () => {}) {
  const root = scratch("compose");
  const r = honestRehearsal();
  edit(r);
  writeRehearsal(`${root}/rehearsal`, `${root}/home`, r);
  afterWrite(`${root}/home`);
  const out = `${root}/pack.json`;
  const run = spawnSync(process.execPath, ["--import", "tsx", "compose.ts", `${root}/rehearsal`, out], { cwd: HERE, encoding: "utf8", env: { ...process.env, HOME: `${root}/home` }, timeout: 60_000 });
  return { r, run, out, pack: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null };
}

afterAll(removeScratch);

describe("compose.ts", () => {
  it("writes a pack whose statements say exactly what the gate established, crash-drill anchors included", () => {
    const { r, run, pack } = compose();
    expect(run.status, run.stderr).toBe(0);
    expect(pack.statements[0]).toMatch(/^All 19 anchors this rehearsal wrote outside the rotation drill \(16 kind 1, 3 kind 2\), the 2 crash-drill anchors and the same-block pair among them, verified valid at consensus-verified assurance/);
    expect(pack.statements.join("\n")).toMatch(/refused each of the 3 maintenance transactions .* with its own JSON-RPC answer 1010 Invalid Transaction/);
    const names = pack.anchors.map((a: { name: string }) => a.name);
    expect(names).toEqual(expect.arrayContaining(["crash-before-broadcast", "crash-after-broadcast"]));
    expect(pack.anchors.find((a: { name: string }) => a.name === "crash-after-broadcast").verifier).toMatchObject({ status: "valid", assurance: "consensus-verified", txHash: r.raw.anchors["crash-after-broadcast"].txHash });
    expect(pack.nodeEnforcedNegatives.map((n: { refusal: { code: number } }) => n.refusal.code)).toEqual([1010, 1010, 1010]);
    expect(pack.privacyScan.windowsOfSecretsInPack).toBe(0);
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

  it("writes nothing when the privacy scan finds a secret in the pack", () => {
    let leaked = "";
    const { run, out } = compose(
      (r) => (leaked = r.raw.anchors["git-log"].commitment),
      (home) => {
        const file = `${home}/.secrets/orynq-midnight-preprod/receipts.json`;
        const openings = JSON.parse(readFileSync(file, "utf8"));
        openings["hidden-keys-suite"].salt = leaked;
        writeFileSync(file, JSON.stringify(openings), { mode: 0o600 });
      },
    );
    expect(run.status).toBe(1);
    expect(existsSync(out)).toBe(false);
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
