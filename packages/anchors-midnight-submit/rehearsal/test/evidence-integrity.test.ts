import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { packedFiles, packageTreeIdentity } from "../evidence-integrity.mjs";
import { FAKE_TARBALL, fakeConsumer, removeScratch, scratch } from "./fixture.js";

afterAll(removeScratch);
it("hashes the installed file set and rejects changed bytes, extra files and links", () => {
  const root = scratch("tree"); fakeConsumer(root);
  const directory = `${root}/node_modules/@fluxpointstudios/orynq-sdk-anchors-midnight`;
  const tar = readFileSync(`${root}/${FAKE_TARBALL}`);
  expect(packedFiles(tar).size).toBe(2);
  expect(packageTreeIdentity(tar, directory)).toEqual({ files: 2, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  writeFileSync(`${directory}/unexpected`, "injected");
  expect(() => packageTreeIdentity(tar, directory)).toThrow(/file set differs/);
});
it("rejects symbolic links and archive path traversal before package loading", () => {
  const root = scratch("linked"); fakeConsumer(root);
  const directory = `${root}/node_modules/@fluxpointstudios/orynq-sdk-anchors-midnight`;
  symlinkSync("index.js", `${directory}/linked.js`);
  expect(() => packageTreeIdentity(readFileSync(`${root}/${FAKE_TARBALL}`), directory)).toThrow(/symlink/);
  const stage = `${root}/stage/package`; mkdirSync(stage, { recursive: true });
  writeFileSync(`${stage}/package.json`, "{}");
  execFileSync("tar", ["--format=ustar", "--transform=s,package/,package/../,", "-czf", `${root}/unsafe.tgz`, "-C", `${root}/stage`, "package"]);
  expect(() => packedFiles(readFileSync(`${root}/unsafe.tgz`))).toThrow(/unsafe tar path/);
});
it("refuses dirty rehearsal source instead of stamping a clean HEAD on modified tooling", () => {
  const root = scratch("tooling");
  const directory = `${root}/packages/anchors-midnight-submit/rehearsal`; mkdirSync(directory, { recursive: true });
  cpSync(new URL("../tooling.ts", import.meta.url), `${directory}/tooling.ts`);
  writeFileSync(`${directory}/gate.mjs`, "export const clean = true;\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  const run = () => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { toolingCommit } from ${JSON.stringify(`${directory}/tooling.ts`)}; console.log(toolingCommit());`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  expect(run().trim()).toBe(git("rev-parse", "HEAD").trim());
  writeFileSync(`${directory}/gate.mjs`, "export const clean = false;\n");
  expect(run).toThrow(/Command failed/);
});
