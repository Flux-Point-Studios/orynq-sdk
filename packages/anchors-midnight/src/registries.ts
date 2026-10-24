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
  deployBlockHash?: string;
  runtimeSpecVersion: number;
  circuits: Record<RegistryCircuit, { vkSha256: string }>;
}

// One immutable registry per generation and network; each deployment adds its entry here in
// the commit that records the deploy. The verifier key hashes are what the chain holds, written
// out rather than taken from REGISTRY_VERIFIER_KEY_SHA256, so a recompiled contract with other
// keys fails assertRegistryGenerations instead of moving the pin.
export const MIDNIGHT_REGISTRIES: Readonly<Record<MidnightNetwork, readonly RegistryInfo[]>> = {
  mainnet: [
    {
      generation: 1,
      address: "438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736",
      deployTxHash: "1bb33baad6eff44f9f485fef1a83b7f2200f09174d286936081574a3221535e8",
      deployHeight: 3113819,
      deployBlockHash: "29533edab5c2ac5777cbdf5c4d0a8b467666a308142c9e2418f13d5b2f06f27b",
      runtimeSpecVersion: 1000300,
      circuits: {
        anchor: { vkSha256: "85dc57a4269dd3aceb82867ecc6c145ef5f679c6f51767f200250e7c075777c5" },
        anchor_hiding: { vkSha256: "081384ce20f2a726e1dd79c0bbfbaabb0fe756ffa15ae429be4cee30b47e790f" },
      },
    },
  ],
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
    if (info.deployBlockHash !== undefined && !HEX64.test(info.deployBlockHash)) throw new Error(`${at}: deployBlockHash must be 64 lowercase hex characters`);
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
