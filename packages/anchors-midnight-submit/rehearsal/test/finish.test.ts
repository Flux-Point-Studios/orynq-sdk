// finish.sh end to end: verify-all.mjs from a consumer directory (the stand-in verify package),
// then compose.ts, over a rehearsal directory of its own whose scripts link to these.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { VERIFY_DIST, archiveAbortedDrill, fakeChain, fakeConsumer, honestRehearsal, removeScratch, scratch, writeRehearsal } from "./fixture.js";

const HERE = new URL("..", import.meta.url).pathname;

function finish(verdicts: Record<string, { status: string; assurance: string }> = {}, consumer: Record<string, string> = {}, afterWrite: (dir: string) => void = () => {}) {
  const root = scratch("finish");
  const r = honestRehearsal();
  writeRehearsal(`${root}/rehearsal`, `${root}/home`, r);
  afterWrite(`${root}/rehearsal`);
  for (const script of ["finish.sh", "gate.mjs", "verify-all.mjs", "compose.ts", "wallets.json"]) symlinkSync(`${HERE}${script}`, `${root}/rehearsal/${script}`);
  fakeConsumer(`${root}/consumer`);
  writeFileSync(`${root}/chain.json`, JSON.stringify(fakeChain(r, verdicts)));
  writeFileSync(`${root}/asked.log`, "");
  const out = `${root}/pack.json`;
  const run = spawnSync("bash", [`${root}/rehearsal/finish.sh`, out], {
    encoding: "utf8",
    env: { ...process.env, HOME: `${root}/home`, CONSUMER: `${root}/consumer`, FAKE_CHAIN: `${root}/chain.json`, FAKE_LOG: `${root}/asked.log`, ORYNQ_VERIFY_DIST: VERIFY_DIST, ...consumer },
    timeout: 120_000,
  });
  const verified = existsSync(`${root}/rehearsal/evidence/verified.json`) ? JSON.parse(readFileSync(`${root}/rehearsal/evidence/verified.json`, "utf8")) : null;
  const asked = readFileSync(`${root}/asked.log`, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[0]);
  return { run, verified, asked, pack: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null };
}

afterAll(removeScratch);

describe("finish.sh", () => {
  it("verifies from the consumer, then writes a pack from that verifier's output", () => {
    const { run, verified, pack } = finish();
    expect(run.status, run.stderr).toBe(0);
    expect(verified.gate.failures).toEqual([]);
    expect(pack.statements[0]).toMatch(/^All 19 anchors this rehearsal wrote outside the rotation drill, 19 distinct transactions/);
    expect(pack.verifier.package).toEqual(verified.package);
    expect(pack.knownAuthorsDrill.forgedDocuments).toEqual(verified.forgedDocuments);
  });

  it("carries a crash drill that aborted before any kill point, archived beside the drill that ran, into the pack", () => {
    const { run, pack } = finish({}, {}, (dir) => archiveAbortedDrill(dir, 1));
    expect(run.status, run.stderr).toBe(0);
    expect(pack.journalCrashDrill.abortedAttempts.map((a: { archive: string }) => a.archive)).toEqual(["crash-drill-aborted-1"]);
    expect(pack.statements[8]).toMatch(/^Before that drill, 1 earlier attempt aborted before any kill point/);
  });

  it("refuses to run without CONSUMER, the directory that installed only the packed verify package", () => {
    const { run, asked, pack } = finish({}, { CONSUMER: "" });
    expect(run.status).not.toBe(0);
    expect(asked).toEqual([]);
    expect(pack).toBeNull();
    expect(run.stderr).toMatch(/CONSUMER: set CONSUMER to the directory that installed only the packed verify package/);
  });

  it("stops at the verifier's gate: no pack, and the gate's reasons kept in evidence/verified.json", () => {
    const { run, verified, pack } = finish({ "zk-material": { status: "unverified-finality", assurance: "multi-path" } });
    expect(run.status).toBe(1);
    expect(pack).toBeNull();
    expect(verified.gate.failures).toEqual([expect.stringMatching(/^anchor zk-material: unverified-finality at multi-path assurance/)]);
    expect(run.stderr).toMatch(/GATE: anchor zk-material: unverified-finality/);
  });
});
