import { fileURLToPath } from "node:url";
import { assertArtifactPins } from "./artifact-pins.mjs";
import { assertOnchainArtifactPins } from "./onchain-artifact-pins.mjs";

await assertArtifactPins(fileURLToPath(new URL("../managed/", import.meta.url)));
await assertOnchainArtifactPins();
console.log("Verified committed Midnight artifact pins");
