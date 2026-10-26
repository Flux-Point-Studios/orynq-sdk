import { fileURLToPath } from "node:url";
import { assertArtifactPins } from "./artifact-pins.mjs";

await assertArtifactPins(fileURLToPath(new URL("../managed/", import.meta.url)));
console.log("Verified committed Midnight artifact pins");
