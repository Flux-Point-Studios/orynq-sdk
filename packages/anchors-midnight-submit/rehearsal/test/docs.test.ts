import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { openKnownAuthors } from "../../../anchors-midnight/src/known-authors.js";
import { honestRehearsal, removeScratch, scratch, writeRehearsal } from "./fixture.js";

afterAll(removeScratch);

function drill() {
  const root = scratch("policy-review"), dir = `${root}/packages/anchors-midnight-submit/rehearsal`, home = `${root}/home`;
  mkdirSync(`${root}/packages`, { recursive: true });
  symlinkSync(new URL("../../../anchors-midnight/", import.meta.url).pathname, `${root}/packages/anchors-midnight`);
  const r = honestRehearsal(); writeRehearsal(dir, home, r);
  copyFileSync(new URL("../docs.ts", import.meta.url), `${dir}/docs.ts`);
  symlinkSync(new URL("../tooling.ts", import.meta.url).pathname, `${dir}/tooling.ts`);
  for (const serial of [1, 2, 3]) unlinkSync(`${dir}/evidence/known-authors/signed-${serial}.json`);
  const run = () => spawnSync(process.execPath, ["--import", "tsx", "docs.ts"], { cwd: dir, env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000 });
  const drafts = () => [1, 2, 3].map(serial => readFileSync(`${dir}/evidence/known-authors/doc-${serial}.json`, "utf8"));
  const approve = (hashes = drafts().map(text => createHash("sha256").update(text).digest("hex"))) => writeFileSync(`${home}/.secrets/orynq-midnight-preprod/known-authors-reviewed.json`, JSON.stringify(Object.fromEntries(hashes.map((hash, index) => [index + 1, hash]))), { mode: 0o600 });
  return { dir, run, drafts, approve };
}

describe("author-only policy signing review", () => {
  it("emits stable unsigned drafts, requires externally reviewed digests, and signs only authors through the guarded CLI", () => {
    const d = drill();
    const draft = d.run();
    expect(draft.status).toBe(1); expect(draft.stderr).toContain("no policy was signed");
    const texts = d.drafts();
    for (const text of texts) expect(JSON.parse(text).networks.preprod.checkpoints).toEqual([]);
    expect(existsSync(`${d.dir}/evidence/known-authors/signed-1.json`)).toBe(false);
    d.approve(["00".repeat(32), "00".repeat(32), "00".repeat(32)]);
    const mismatch = d.run();
    expect(mismatch.status).toBe(1); expect(mismatch.stderr).toContain("differ from the externally reviewed");
    expect(d.drafts()).toEqual(texts);
    expect(existsSync(`${d.dir}/evidence/known-authors/signed-1.json`)).toBe(false);
    d.approve();
    const signed = d.run();
    expect(signed.status, signed.stderr).toBe(0);
    const root = readFileSync(`${d.dir}/evidence/known-authors/root.pub`, "utf8").trim();
    for (const serial of [1, 2, 3]) {
      const [envelope] = JSON.parse(readFileSync(`${d.dir}/evidence/known-authors/signed-${serial}.json`, "utf8"));
      expect(envelope.document).toBe(texts[serial - 1]);
      const policy = openKnownAuthors(envelope, [root]);
      expect(policy.serial).toBe(serial); expect(policy.checkpoints("preprod")).toEqual([]);
    }
  }, 120_000);
});
