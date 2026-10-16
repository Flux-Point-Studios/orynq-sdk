// verify-all.mjs end to end, laid out as it runs: copied into a consumer directory whose only
// package is the verify package (here a stand-in that answers as the W2 verifier does over a
// described chain), reading the evidence the rehearsal copied beside it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { FAKE_TARBALL, VERIFY_DIST, fakeChain, fakeConsumer, honestRehearsal, removeScratch, scratch, writeRehearsal, type Rehearsal } from "./fixture.js";

const HERE = new URL("..", import.meta.url).pathname;
const PACKAGE = "@fluxpointstudios/orynq-sdk-anchors-midnight";

// HOME is a directory that does not exist, so verify-all.mjs reads no secret and no saved state.
function verifyAll(edit: (r: Rehearsal) => void = () => {}, verdicts: Record<string, { status: string; assurance: string }> = {}, install: "copy" | "link" = "copy", afterInstall: (consumer: string) => void = () => {}) {
  const root = scratch("verify-all");
  const r = honestRehearsal();
  const chain = fakeChain(r, verdicts);
  edit(r);
  writeRehearsal(`${root}/rehearsal`, `${root}/home`, r);
  const consumer = `${root}/consumer`;
  const evidence = `${consumer}/evidence`;
  fakeConsumer(consumer, install);
  afterInstall(consumer);
  for (const script of ["verify-all.mjs", "gate.mjs"]) copyFileSync(`${HERE}${script}`, `${consumer}/${script}`);
  cpSync(`${root}/rehearsal/evidence`, evidence, { recursive: true });
  copyFileSync(`${root}/rehearsal/bundles/index.json`, `${evidence}/bundles.json`);
  writeFileSync(`${root}/chain.json`, JSON.stringify(chain));
  writeFileSync(`${root}/asked.log`, "");
  const run = spawnSync(process.execPath, ["verify-all.mjs", evidence, "/nonexistent/project-id"], {
    cwd: consumer,
    encoding: "utf8",
    env: { ...process.env, HOME: `${root}/no-home`, FAKE_CHAIN: `${root}/chain.json`, FAKE_LOG: `${root}/asked.log`, ORYNQ_VERIFY_DIST: VERIFY_DIST },
    timeout: 60_000,
  });
  const lines = readFileSync(`${root}/asked.log`, "utf8").split("\n").filter(Boolean).map((l) => l.split(" "));
  return { r, run, consumer, out: run.stdout.trim() ? JSON.parse(run.stdout) : null, asked: lines.map(([tx]) => tx), sources: [...new Set(lines.map(([, ...source]) => source.join(" ")))] };
}
const lockEntry = (consumer: string, edit: (entry: Record<string, string>) => void) => {
  const lock = JSON.parse(readFileSync(`${consumer}/package-lock.json`, "utf8"));
  edit(lock.packages[`node_modules/${PACKAGE}`]);
  writeFileSync(`${consumer}/package-lock.json`, JSON.stringify(lock));
};

afterAll(removeScratch);

describe("verify-all.mjs", () => {
  it("verifies every recorded anchor, crash-drill anchors included, through Blockfrost preprod alone, and exits 0 only with an empty gate", () => {
    const { r, run, out, asked, sources } = verifyAll();
    expect(run.status, run.stderr).toBe(0);
    expect(out.gate.failures).toEqual([]);
    for (const label of ["crash-before-broadcast", "crash-after-broadcast"]) {
      expect(asked).toContain(r.raw.anchors[label].txHash);
      expect(out.anchors[label]).toMatchObject({ status: "valid", assurance: "consensus-verified", commitment: r.raw.anchors[label].commitment });
    }
    expect(sources).toEqual(["blockfrost preprod"]);
  });

  it("asks Blockfrost for every transaction the node refused, and records that it holds none", () => {
    const { r, out, asked } = verifyAll();
    for (const [name, n] of Object.entries(r.raw.negatives as Record<string, { txHash: string }>)) {
      expect(asked).toContain(n.txHash);
      expect(out.refusedTransactions[name]).toMatchObject({ txHash: n.txHash, status: "invalid", failed: [`indexer: the indexer knows no transaction ${n.txHash}`] });
    }
  });

  it("forges serial 3 three ways and opens each with the verify package's own KNOWN_AUTHORS code: only the stranger's key, as trust root, opens it", () => {
    const { r, out } = verifyAll();
    const signatureFails = "refused: the known-authors document's signature by a trust root does not verify";
    expect(Object.fromEntries(Object.entries(out.forgedDocuments as Record<string, { outcome: string }>).map(([name, f]) => [name, f.outcome]))).toEqual({
      "serial 3 with every author window reopened, under the trust root's signature on serial 3": signatureFails,
      "that document signed by a stranger, under the trust root's key": signatureFails,
      "that document signed by a stranger, under the stranger's key": "refused: the known-authors document carries no signature by a trust root",
      "positive control: that document signed by a stranger, with the stranger as the trust root": "opened",
    });
    const reopened = out.forgedDocuments["serial 3 with every author window reopened, under the trust root's signature on serial 3"];
    expect(reopened).toMatchObject({ signatures: r.documents[2]!.signatures, trustRoots: [r.root] });
    expect(reopened.document).not.toBe(r.documents[2]!.document);
    expect(out.forgedDocuments["that document signed by a stranger, under the trust root's key"]).toMatchObject({ document: reopened.document, trustRoots: [r.root], signatures: [{ key: r.root }] });
    expect(out).toMatchObject({ trustRoot: r.root, shippedTrustRoots: [], knownAuthorsDocuments: [1, 2, 3].map((serial) => ({ serial, networks: ["preprod"] })) });
  });

  it("records the tarball npm installed the verify package from, with the integrity npm checked", () => {
    const { run, out, consumer } = verifyAll();
    expect(run.status, run.stderr).toBe(0);
    const tarball = readFileSync(`${consumer}/${FAKE_TARBALL}`);
    expect(out.package).toEqual({
      name: PACKAGE,
      version: "0.0.0-fake",
      resolved: `file:${FAKE_TARBALL}`,
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      sha256: createHash("sha256").update(tarball).digest("hex"),
    });
  });

  it.each<[string, (consumer: string) => void, RegExp]>([
    ["no npm lock entry", (c) => unlinkSync(`${c}/package-lock.json`), /^verify-all: \/\S+\/consumer\/package-lock\.json records no install of @fluxpointstudios\/orynq-sdk-anchors-midnight: install the packed tarball into this directory with npm$/m],
    ["an install from a directory", (c) => lockEntry(c, (e) => (e.resolved = "file:../../anchors-midnight")), /^verify-all: npm installed @fluxpointstudios\/orynq-sdk-anchors-midnight from file:\.\.\/\.\.\/anchors-midnight, not from a packed tarball in this directory$/m],
    ["a tarball changed after the install", (c) => writeFileSync(`${c}/${FAKE_TARBALL}`, "other bytes"), /^verify-all: \/\S+\/consumer\/fluxpointstudios-orynq-sdk-anchors-midnight-0\.0\.0-fake\.tgz does not have the integrity sha512-\S+ npm recorded when it installed @fluxpointstudios\/orynq-sdk-anchors-midnight$/m],
    ["a missing tarball", (c) => unlinkSync(`${c}/${FAKE_TARBALL}`), /does not have the integrity sha512-\S+ npm recorded/],
  ])("refuses, before loading it, a verify package with %s", (_, afterInstall, message) => {
    const { run, out, asked } = verifyAll(undefined, {}, "copy", afterInstall);
    expect(run.status).toBe(1);
    expect(out).toBeNull();
    expect(asked).toEqual([]);
    expect(run.stderr).toMatch(message);
  });

  it("imports nothing but node built-ins, gate.mjs and the verify package", () => {
    const text = readFileSync(`${HERE}verify-all.mjs`, "utf8");
    expect([...text.matchAll(/^import .* from "([^"]+)";$/gm)].map(([, from]) => from).sort()).toEqual(["./gate.mjs", "node:crypto", "node:fs", "node:path", "node:url"]);
    expect([...text.matchAll(/\bimport\(([^)]*)\)/g)].map(([, what]) => what)).toEqual(["PACKAGE"]);
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
