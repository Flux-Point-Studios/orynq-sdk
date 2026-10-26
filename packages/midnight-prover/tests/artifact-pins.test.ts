import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { assertArtifactPins } from "../scripts/artifact-pins.mjs";

const artifacts = resolve(import.meta.dirname, "../managed");
const files = ["initial-state.bin", "keys/proveCapability.verifier", "keys/proveRolling1.verifier"];

it("accepts the reproducible reviewed compiler output", async () => {
  await expect(assertArtifactPins(artifacts)).resolves.toBeUndefined();
});

it.each(files)("refuses changed %s before it can be packed", async file => {
  const directory = await mkdtemp(join(tmpdir(), "orynq-artifact-pins-"));
  try {
    await mkdir(join(directory, "keys"));
    for (const name of files) await copyFile(join(artifacts, name), join(directory, name));
    const bytes = await readFile(join(directory, file)); bytes[0] = bytes[0]! ^ 1;
    await writeFile(join(directory, file), bytes);
    await expect(assertArtifactPins(directory)).rejects.toThrow(`${file} differs from its committed SHA-256 pin`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
