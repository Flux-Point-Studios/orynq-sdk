import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as L8 from "@midnightntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";
import type { ProvingBackends } from "@midnightntwrk/wallet-sdk-capabilities/proving";
import { makeV8WasmProvingServiceEffect, makeV9WasmProvingServiceEffect } from "@midnightntwrk/wallet-sdk-capabilities/proving";
import type { KeyMaterialProvider } from "@midnightntwrk/zkir-v2";
import { Effect } from "effect";
import { REGISTRY_CIRCUITS, compiledContractFile } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import type { Prover, UnboundTransaction, UnprovenTransaction } from "./submission.js";

// What tools/compactc/install.sh puts in a ZK directory: the parameters for k=13 (anchor, and the
// DUST spend that pays every fee) and k=14 (anchor_hiding), and each ledger's DUST spend circuit,
// ledger 8's as circuit generation 9 and ledger 9's as generation 10, pinned as midnight-ledger
// ledger-8.1.3 and ledger-9.1.0.0 pin them.
export const ZK_PINS = {
  bls_midnight_2p13: "d3324910969c4cc54143b8045b649e5c3a4bd5fb7b8f85fe1b770f640ce1c803",
  bls_midnight_2p14: "fc253016885ec830e97808c9ec920bb5cab5c21af590380a6cb5eb0538e2b244",
  "dust/9/spend.prover": "996602da7ca386284e656c78ea03e55bffdba29475e6a67965c50de05e13efc2",
  "dust/9/spend.verifier": "3f1569ebcab0655c5c145b28947c74edc4e3f5c6b276e4404b661cf0905b49d3",
  "dust/9/spend.bzkir": "904181287e75b0fb596ba5fcc116c882ee5d28e3115304c93ebd913722ce5841",
  "dust/10/spend.prover": "3dff9f54add761350ad02621a425d67fe3d656c8145fef8ef147870489ffdc81",
  "dust/10/spend.verifier": "d15a1295780549f534287a39c938005e1faa3232be21861573bd0cdb148949cb",
  "dust/10/spend.bzkir": "d211cacb22391b9db60f945787d98c16d344cbb4790246132117084c080399c1",
} as const;

const DUST_GENERATION = { 8: 9, 9: 10 } as const;
type Material = NonNullable<Awaited<ReturnType<KeyMaterialProvider["lookupKey"]>>>;

// Key material for the circuits a registry operator proves under `ledger`, read only from the
// committed contract build and from `zkDir`, each file checked against its pin. Nothing is
// fetched, so no witness or key location leaves the process; shielded-token circuits have no
// material, since an anchor and its fee move no shielded tokens.
export function keyMaterial(zkDir: string, ledger: 8 | 9): KeyMaterialProvider {
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
  const dust = `dust/${DUST_GENERATION[ledger]}/spend` as const;
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
        return { proverKey: pinned(`${dust}.prover`), verifierKey: pinned(`${dust}.verifier`), ir: pinned(`${dust}.bzkir`) };
      }
      return undefined;
    },
    async getParams(k: number) {
      if (k !== 13 && k !== 14) throw new Error(`no pinned parameters for k=${k}`);
      return pinned(`bls_midnight_2p${k}`);
    },
  };
}

// The wallet's proving backends: each ledger proves in-process with zkir-v2, in a worker thread,
// from keyMaterial(zkDir), so no witness reaches a proof server and no key material is fetched.
export function provingBackends(zkDir: string): ProvingBackends {
  return { v8: { kind: "wasm", keyMaterialProvider: keyMaterial(zkDir, 8) }, v9: { kind: "wasm", keyMaterialProvider: keyMaterial(zkDir, 9) } };
}

// Proves a transaction of either ledger with that ledger's prover and key material.
export function provingService(zkDir: string): Prover {
  const v8 = makeV8WasmProvingServiceEffect({ keyMaterialProvider: keyMaterial(zkDir, 8) });
  const v9 = makeV9WasmProvingServiceEffect({ keyMaterialProvider: keyMaterial(zkDir, 9) });
  return {
    prove: (tx: UnprovenTransaction): Promise<UnboundTransaction> => Effect.runPromise<UnboundTransaction, unknown>(tx instanceof L9.Transaction ? v9.prove(tx) : v8.prove(tx as L8.UnprovenTransaction)),
  };
}
