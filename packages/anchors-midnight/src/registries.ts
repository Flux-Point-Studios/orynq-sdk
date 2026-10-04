import { REGISTRY_CIRCUITS, REGISTRY_VERIFIER_KEY_SHA256, type RegistryCircuit } from "./registry.js";

export type MidnightNetwork = "mainnet" | "preprod";

// The Midnight runtime whose extrinsic layout the decoder pins: Midnight is pallet 5 and
// send_mn_transaction its call 0 in spec 1000300 (ledger 8). A new runtime needs a new
// registry generation and a decoder that knows it.
export const KNOWN_RUNTIME_SPEC_VERSIONS = [1000300] as const;

export interface RegistryInfo {
  generation: number;
  address: string;
  deployTxHash: string;
  deployHeight: number;
  runtimeSpecVersion: number;
  circuits: Record<RegistryCircuit, { vkSha256: string }>;
}

// One immutable registry per generation and network. No generation is deployed yet; each
// deployment adds its entry here in the commit that records the deploy.
export const MIDNIGHT_REGISTRIES: Readonly<Record<MidnightNetwork, readonly RegistryInfo[]>> = {
  mainnet: [],
  preprod: [],
};

const HEX64 = /^[0-9a-f]{64}$/;

export function assertRegistryGenerations(generations: readonly RegistryInfo[]): void {
  const addresses = new Set<string>();
  generations.forEach((info, i) => {
    const at = `generation ${info.generation}`;
    if (info.generation !== i + 1) throw new Error(`generations must count up from 1; entry ${i} is ${at}`);
    for (const field of ["address", "deployTxHash"] as const) {
      if (!HEX64.test(info[field])) throw new Error(`${at}: ${field} must be 64 lowercase hex characters`);
    }
    if (addresses.has(info.address)) throw new Error(`${at} repeats address ${info.address}`);
    addresses.add(info.address);
    if (!(KNOWN_RUNTIME_SPEC_VERSIONS as readonly number[]).includes(info.runtimeSpecVersion)) {
      throw new Error(`${at}: runtime ${info.runtimeSpecVersion} is not one this decoder knows (${KNOWN_RUNTIME_SPEC_VERSIONS.join(", ")})`);
    }
    for (const circuit of REGISTRY_CIRCUITS) {
      const vk = info.circuits[circuit]?.vkSha256;
      if (vk !== REGISTRY_VERIFIER_KEY_SHA256[circuit]) {
        throw new Error(`${at}: ${circuit} verifier key ${vk} is not the compiled ${REGISTRY_VERIFIER_KEY_SHA256[circuit]}`);
      }
    }
  });
}
