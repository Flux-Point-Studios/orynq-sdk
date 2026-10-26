import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const files = ["initial-state.bin", "keys/proveCapability.verifier", "keys/proveRolling1.verifier"];
const pins = JSON.parse(await readFile(new URL("../artifact-pins.json", import.meta.url), "utf8"));
if (pins.version !== 1 || pins.compiler !== "0.31.1" || !pins.sha256 ||
    Object.keys(pins.sha256).sort().join("\n") !== files.join("\n") ||
    !Object.values(pins.sha256).every(value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value))) {
  throw new Error("Invalid committed Midnight artifact pins");
}

/** Check generated output against reviewed digests, never against a newly generated manifest. */
export async function assertArtifactPins(directory) {
  for (const file of files) {
    const actual = createHash("sha256").update(await readFile(join(directory, file))).digest("hex");
    if (actual !== pins.sha256[file]) throw new Error(`Generated Midnight artifact ${file} differs from its committed SHA-256 pin`);
  }
}
