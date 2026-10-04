// verify-all.mjs end to end, laid out as it runs: copied into a consumer directory whose only
// package is the verify package (here a stand-in that answers as the W2 verifier does over a
// described chain), reading the evidence the rehearsal copied beside it.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { fakeChain, fakeConsumer, honestRehearsal, removeScratch, scratch, writeRehearsal, type Rehearsal } from "./fixture.js";

const HERE = new URL("..", import.meta.url).pathname;

function verifyAll(edit: (r: Rehearsal) => void = () => {}, verdicts: Record<string, { status: string; assurance: string }> = {}, install: "copy" | "link" = "copy") {
  const root = scratch("verify-all");
  const r = honestRehearsal();
  const chain = fakeChain(r, verdicts);
  edit(r);
  writeRehearsal(`${root}/rehearsal`, `${root}/home`, r);
  const consumer = `${root}/consumer`;
  const evidence = `${consumer}/evidence`;
  fakeConsumer(consumer, install);
  for (const script of ["verify-all.mjs", "gate.mjs"]) copyFileSync(`${HERE}${script}`, `${consumer}/${script}`);
  cpSync(`${root}/rehearsal/evidence`, evidence, { recursive: true });
  copyFileSync(`${root}/rehearsal/bundles/index.json`, `${evidence}/bundles.json`);
  writeFileSync(`${root}/chain.json`, JSON.stringify(chain));
  writeFileSync(`${root}/asked.log`, "");
  const run = spawnSync(process.execPath, ["verify-all.mjs", evidence, "/nonexistent/project-id"], {
    cwd: consumer,
    encoding: "utf8",
    env: { ...process.env, FAKE_CHAIN: `${root}/chain.json`, FAKE_LOG: `${root}/asked.log` },
    timeout: 60_000,
  });
  const asked = readFileSync(`${root}/asked.log`, "utf8").split("\n").filter(Boolean);
  return { r, run, out: run.stdout.trim() ? JSON.parse(run.stdout) : null, asked };
}

afterAll(removeScratch);

describe("verify-all.mjs", () => {
  it("verifies every recorded anchor, crash-drill anchors included, and exits 0 only with an empty gate", () => {
    const { r, run, out, asked } = verifyAll();
    expect(run.status, run.stderr).toBe(0);
    expect(out.gate.failures).toEqual([]);
    for (const label of ["crash-before-broadcast", "crash-after-broadcast"]) {
      expect(asked).toContain(r.raw.anchors[label].txHash);
      expect(out.anchors[label]).toMatchObject({ status: "valid", assurance: "consensus-verified" });
    }
  });

  it("refuses a verify package that is not installed in its own directory, such as a link to a source tree", () => {
    const { run, out, asked } = verifyAll(undefined, {}, "link");
    expect(run.status).toBe(1);
    expect(out).toBeNull();
    expect(asked).toEqual([]);
    expect(run.stderr).toMatch(/^verify-all: @fluxpointstudios\/orynq-sdk-anchors-midnight resolves to \/\S+\/test\/fake-verifier\/index\.js, outside \/\S+\/consumer\/node_modules\/: install the packed tarball into this directory$/m);
  });

  it("exits non-zero when an anchor is left at unverified-finality", () => {
    const { run, out } = verifyAll(undefined, { "zk-material": { status: "unverified-finality", assurance: "multi-path" } });
    expect(run.status).toBe(1);
    expect(out.gate.failures).toEqual([expect.stringMatching(/^anchor zk-material: unverified-finality at multi-path assurance/)]);
  });

  it("exits non-zero when the crash drill's anchors are only in its log", () => {
    const { run, out } = verifyAll((r) => {
      delete r.raw.anchors["crash-before-broadcast"];
      delete r.raw.anchors["crash-after-broadcast"];
    });
    expect(run.status).toBe(1);
    expect(out.gate.failures).toEqual(expect.arrayContaining([expect.stringMatching(/^crash drill anchor crash-before-broadcast /), expect.stringMatching(/^crash drill anchor crash-after-broadcast /)]));
  });

  it("exits non-zero when a node negative records a transport failure", () => {
    const { run, out } = verifyAll((r) => (r.raw.negatives["ReplaceAuthority, unsigned"] = { txHash: "cd".repeat(32), rejected: true, by: "node author_submitExtrinsic", error: "midnight node: fetch failed", onChain: 0 }));
    expect(run.status).toBe(1);
    expect(out.gate.failures).toEqual(["negative ReplaceAuthority, unsigned: no refusal by the node was recorded (midnight node: fetch failed), not 1010 Invalid Transaction (Custom error: 136, ThresholdMissed)"]);
  });
});
