import { REGISTRY_CIRCUITS, REGISTRY_VERIFIER_KEY_SHA256, type RegistryCircuit } from "./registry.js";

export type MidnightNetwork = "mainnet" | "preprod";

// The Midnight runtimes whose extrinsic layout and events the decoder pins: Midnight is pallet 5
// and send_mn_transaction its call 0 in spec 1000300 (ledger 8) and spec 2001100 (ledger 9). A
// new runtime needs a decoder that knows it and a span in each registry generation it runs.
export const KNOWN_RUNTIME_SPEC_VERSIONS = [1000300, 2001100] as const;

// A runtime a registry generation runs under, from block `fromHeight` through `toHeight`
// (null while it is the current runtime).
export interface RuntimeSpan {
  specVersion: number;
  fromHeight: number;
  toHeight: number | null;
}

export interface RegistryInfo {
  generation: number;
  address: string;
  deployTxHash: string;
  deployHeight: number;
  deployBlockHash?: string;
  runtimes: readonly RuntimeSpan[];
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
      // Block 3346138 carries set_code; 3346139 is the first block runtime 2001100 executes.
      runtimes: [
        { specVersion: 1000300, fromHeight: 3113819, toHeight: 3346138 },
        { specVersion: 2001100, fromHeight: 3346139, toHeight: null },
      ],
      circuits: {
        anchor: { vkSha256: "85dc57a4269dd3aceb82867ecc6c145ef5f679c6f51767f200250e7c075777c5" },
        anchor_hiding: { vkSha256: "081384ce20f2a726e1dd79c0bbfbaabb0fe756ffa15ae429be4cee30b47e790f" },
      },
    },
  ],
  preprod: [],
};

const HEX64 = /^[0-9a-f]{64}$/;
const isHeight = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// Spans must run contiguously from the deploy height, each non-empty, the last one open.
function assertRuntimeSpans(info: RegistryInfo, at: string): void {
  const spans = info.runtimes;
  if (!Array.isArray(spans) || spans.length === 0) throw new Error(`${at}: runtime spans must name at least one runtime`);
  let next = info.deployHeight;
  spans.forEach((span, i) => {
    if (!(KNOWN_RUNTIME_SPEC_VERSIONS as readonly number[]).includes(span.specVersion)) {
      throw new Error(`${at}: runtime ${span.specVersion} is not one this decoder knows (${KNOWN_RUNTIME_SPEC_VERSIONS.join(", ")})`);
    }
    if (span.fromHeight !== next) throw new Error(`${at}: runtime ${span.specVersion} starts at block ${span.fromHeight}, not ${next}`);
    const last = i === spans.length - 1;
    if (last ? span.toHeight !== null : !isHeight(span.toHeight)) throw new Error(`${at}: runtime spans must end with exactly one open span, the last`);
    if (span.toHeight !== null) {
      if (span.toHeight < span.fromHeight) throw new Error(`${at}: runtime ${span.specVersion} spans no block`);
      next = span.toHeight + 1;
    }
  });
}

export function assertRegistryGenerations(generations: readonly RegistryInfo[]): void {
  const addresses = new Set<string>();
  generations.forEach((info, i) => {
    const at = `generation ${info.generation}`;
    if (info.generation !== i + 1) throw new Error(`generations must count up from 1; entry ${i} is ${at}`);
    for (const field of ["address", "deployTxHash"] as const) {
      if (!HEX64.test(info[field])) throw new Error(`${at}: ${field} must be 64 lowercase hex characters`);
    }
    if (info.deployBlockHash !== undefined && !HEX64.test(info.deployBlockHash)) throw new Error(`${at}: deployBlockHash must be 64 lowercase hex characters`);
    if (!isHeight(info.deployHeight)) throw new Error(`${at}: deployHeight must be a block height`);
    if (addresses.has(info.address)) throw new Error(`${at} repeats address ${info.address}`);
    addresses.add(info.address);
    assertRuntimeSpans(info, at);
    for (const circuit of REGISTRY_CIRCUITS) {
      const vk = info.circuits[circuit]?.vkSha256;
      if (vk !== REGISTRY_VERIFIER_KEY_SHA256[circuit]) {
        throw new Error(`${at}: ${circuit} verifier key ${vk} is not the compiled ${REGISTRY_VERIFIER_KEY_SHA256[circuit]}`);
      }
    }
  });
}

// Whether a block at `height` running `specVersion` lies in one of `info`'s runtime spans.
export function registryRuntimeAllows(info: RegistryInfo, specVersion: number, height: number): boolean {
  return isHeight(height) && info.runtimes.some((span) => span.specVersion === specVersion && height >= span.fromHeight && (span.toHeight === null || height <= span.toHeight));
}
