import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const managed = fileURLToPath(new URL("../onchain/managed/", import.meta.url));

/** Check the committed files that consumers import and packages ship, independently of recompilation. */
export async function assertOnchainArtifactPins(directory = managed) {
  const pins = JSON.parse(await readFile(new URL("../onchain/pins.json", import.meta.url), "utf8"));
  for (const [file, expected] of Object.entries(pins.files)) {
    const actual = createHash("sha256").update(await readFile(join(directory, file))).digest("hex");
    if (actual !== expected) throw new Error(`Committed on-chain artifact ${file} differs from its SHA-256 pin`);
  }
}
