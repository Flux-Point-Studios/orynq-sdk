import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeWasmProvingService, type ProvingService, type UnboundTransaction } from "@midnight-ntwrk/wallet-sdk-capabilities/proving";
import type { KeyMaterialProvider } from "@midnight-ntwrk/zkir-v2";
import { REGISTRY_CIRCUITS, compiledContractFile } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

// What tools/compactc/install.sh puts in a ZK directory, pinned as midnight-ledger 8.1.3 pins
// it: the parameters for k=13 (anchor, and the DUST spend that pays every fee) and k=14
// (anchor_hiding), and the DUST spend circuit.
export const ZK_PINS = {
  bls_midnight_2p13: "d3324910969c4cc54143b8045b649e5c3a4bd5fb7b8f85fe1b770f640ce1c803",
  bls_midnight_2p14: "fc253016885ec830e97808c9ec920bb5cab5c21af590380a6cb5eb0538e2b244",
  "dust/9/spend.prover": "996602da7ca386284e656c78ea03e55bffdba29475e6a67965c50de05e13efc2",
  "dust/9/spend.verifier": "3f1569ebcab0655c5c145b28947c74edc4e3f5c6b276e4404b661cf0905b49d3",
  "dust/9/spend.bzkir": "904181287e75b0fb596ba5fcc116c882ee5d28e3115304c93ebd913722ce5841",
} as const;

type Material = NonNullable<Awaited<ReturnType<KeyMaterialProvider["lookupKey"]>>>;

// Key material for the circuits a registry operator proves, read only from the committed
// contract build and from `zkDir`, each file checked against its pin. Nothing is fetched, so
// no witness or key location leaves the process; shielded-token circuits have no material,
// since an anchor and its fee move no shielded tokens.
export function keyMaterial(zkDir: string): KeyMaterialProvider {
  const cache = new Map<string, Uint8Array>();
  const pinned = (name: keyof typeof ZK_PINS) => {
    let bytes = cache.get(name);
    if (!bytes) {
      bytes = new Uint8Array(readFileSync(join(zkDir, name)));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== ZK_PINS[name]) throw new Error(`${name} hashes to ${digest}, pinned ${ZK_PINS[name]}`);
      cache.set(name, bytes);
    }
    return bytes;
  };
  return {
    async lookupKey(location: string): Promise<Material | undefined> {
      if ((REGISTRY_CIRCUITS as readonly string[]).includes(location)) {
        return {
          proverKey: compiledContractFile(`keys/${location}.prover`),
          verifierKey: compiledContractFile(`keys/${location}.verifier`),
          ir: compiledContractFile(`zkir/${location}.bzkir`),
        };
      }
      if (location === "midnight/dust/spend") {
        return { proverKey: pinned("dust/9/spend.prover"), verifierKey: pinned("dust/9/spend.verifier"), ir: pinned("dust/9/spend.bzkir") };
      }
      return undefined;
    },
    async getParams(k: number) {
      if (k !== 13 && k !== 14) throw new Error(`no pinned parameters for k=${k}`);
      return pinned(`bls_midnight_2p${k}`);
    },
  };
}

// Proves in a worker thread of this process with zkir-v2 and keyMaterial(zkDir), so a proof
// never blocks the wallet's subscriptions and no witness reaches a proof server.
export function provingService(zkDir: string): ProvingService<UnboundTransaction> {
  return makeWasmProvingService({ keyMaterialProvider: keyMaterial(zkDir) });
}
