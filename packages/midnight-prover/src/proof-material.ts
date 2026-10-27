import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { provingProvider } from "@midnight-ntwrk/zkir-v2";
import { PROOF_CIRCUITS, proofArtifact } from "./onchain.js";

const PARAMS: Readonly<Record<number, string>> = {
  13: "d3324910969c4cc54143b8045b649e5c3a4bd5fb7b8f85fe1b770f640ce1c803",
  14: "fc253016885ec830e97808c9ec920bb5cab5c21af590380a6cb5eb0538e2b244",
  16: "09c877216d6589b370263e18af40a030a901b41a7a7c37ef58c9901db41f05c6",
};

export function proofProvider(paramsDir: string) {
  return provingProvider({
    async lookupKey(location) {
      if (!(PROOF_CIRCUITS as readonly string[]).includes(location)) return undefined;
      return { proverKey: proofArtifact(`keys/${location}.prover`), verifierKey: proofArtifact(`keys/${location}.verifier`), ir: proofArtifact(`zkir/${location}.bzkir`) };
    },
    async getParams(k) {
      if (!PARAMS[k]) throw new Error("Unpinned proving parameters");
      const bytes = new Uint8Array(await readFile(join(paramsDir, `bls_midnight_2p${k}`)));
      if (createHash("sha256").update(bytes).digest("hex") !== PARAMS[k]) throw new Error("Proving parameters differ from their pin");
      return bytes;
    },
  });
}
