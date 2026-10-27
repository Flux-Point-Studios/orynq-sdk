import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { assertOnchainArtifactPins } from "../scripts/onchain-artifact-pins.mjs";

const onchain = resolve(import.meta.dirname, "../onchain");
const artifacts = join(onchain, "managed");
const pins = JSON.parse(await readFile(join(onchain, "pins.json"), "utf8")) as { files: Record<string, string> };

it("accepts the committed on-chain artifacts that consumers use", async () => {
  await expect(assertOnchainArtifactPins()).resolves.toBeUndefined();
});

it.each(Object.keys(pins.files))("refuses changed committed %s even when the compiler pins are unchanged", async file => {
  const directory = await mkdtemp(join(tmpdir(), "orynq-onchain-artifact-pins-"));
  try {
    for (const name of Object.keys(pins.files)) {
      await mkdir(dirname(join(directory, name)), { recursive: true });
      await copyFile(join(artifacts, name), join(directory, name));
    }
    const bytes = await readFile(join(directory, file));
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(join(directory, file), bytes);
    await expect(assertOnchainArtifactPins(directory)).rejects.toThrow(`Committed on-chain artifact ${file} differs from its SHA-256 pin`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("check:onchain rejects committed JavaScript drift even when fresh compiler output still matches the pins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orynq-onchain-committed-check-"));
  try {
    const target = join(directory, "onchain");
    await mkdir(join(directory, "scripts"));
    await symlink(resolve(import.meta.dirname, "../node_modules"), join(directory, "node_modules"), "dir");
    for (const file of ["compile-onchain.mjs", "onchain-artifact-pins.mjs"]) {
      await copyFile(resolve(import.meta.dirname, "../scripts", file), join(directory, "scripts", file));
    }
    await mkdir(target);
    for (const file of ["pins.json", "orynq.compact"]) await copyFile(join(onchain, file), join(target, file));
    for (const file of Object.keys(pins.files)) {
      await mkdir(dirname(join(target, "managed", file)), { recursive: true });
      await copyFile(join(artifacts, file), join(target, "managed", file));
    }
    await writeFile(join(target, "managed/contract/index.js"), "\n// unexpected committed drift\n", { flag: "a" });
    const compiler = join(directory, "compiler.mjs");
    // Isolate the committed-file check: its independent compiler result remains the exact
    // original artifact bytes. This fixture does not claim to compile or generate proofs.
    await writeFile(compiler, `#!${process.execPath}\nimport { cpSync } from "node:fs";\nif (process.argv.includes("--version")) console.log("0.31.1");\nelse cpSync(${JSON.stringify(artifacts)}, process.argv.at(-1), { recursive: true });\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [join(directory, "scripts/compile-onchain.mjs"), "--check"], { env: { ...process.env, COMPACTC: compiler }, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Committed on-chain artifact contract/index.js differs from its SHA-256 pin");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
