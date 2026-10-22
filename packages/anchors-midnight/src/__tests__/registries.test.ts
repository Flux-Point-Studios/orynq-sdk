import { describe, expect, it } from "vitest";
import { MIDNIGHT_REGISTRIES, assertRegistryGenerations, type RegistryInfo } from "../registries.js";
import { REGISTRY_VERIFIER_KEY_SHA256 } from "../registry.js";

export const registryInfo = (overrides: Partial<RegistryInfo> = {}): RegistryInfo => ({
  generation: 1,
  address: "ab".repeat(32),
  deployTxHash: "cd".repeat(32),
  deployHeight: 100,
  runtimeSpecVersion: 1000300,
  circuits: { anchor: { vkSha256: REGISTRY_VERIFIER_KEY_SHA256.anchor }, anchor_hiding: { vkSha256: REGISTRY_VERIFIER_KEY_SHA256.anchor_hiding } },
  ...overrides,
});

describe("registry generations", () => {
  // Read from mainnet through its public node: deploy transaction 1bb33baa… is extrinsic 4 of
  // block 3113819 (29533eda…), whose header hashes to it and whose body matches its
  // extrinsicsRoot; its final bytes pass assertRegistryDeployBytes, deploying exactly the
  // immutable registry state at 438b1ea1…; the node holds no contract there in block 3113818
  // and, in block 3113819, a state assertRegistryState accepts, whose two verifier keys equal
  // the compiled ones.
  it("pins generation 1 on mainnet, deployed in block 3113819 under runtime 1000300 with this contract's verifier keys, and none on preprod", () => {
    expect(Object.keys(MIDNIGHT_REGISTRIES).sort()).toEqual(["mainnet", "preprod"]);
    expect(MIDNIGHT_REGISTRIES.mainnet).toEqual([
      {
        generation: 1,
        address: "438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736",
        deployTxHash: "1bb33baad6eff44f9f485fef1a83b7f2200f09174d286936081574a3221535e8",
        deployHeight: 3113819,
        runtimeSpecVersion: 1000300,
        circuits: {
          anchor: { vkSha256: "85dc57a4269dd3aceb82867ecc6c145ef5f679c6f51767f200250e7c075777c5" },
          anchor_hiding: { vkSha256: "081384ce20f2a726e1dd79c0bbfbaabb0fe756ffa15ae429be4cee30b47e790f" },
        },
      },
    ]);
    expect(MIDNIGHT_REGISTRIES.preprod).toEqual([]);
    for (const list of Object.values(MIDNIGHT_REGISTRIES)) expect(() => assertRegistryGenerations(list)).not.toThrow();
  });

  it("positive control: a generation of this compiled contract on runtime 1000300 is accepted", () => {
    expect(() => assertRegistryGenerations([registryInfo(), registryInfo({ generation: 2, address: "ef".repeat(32), deployHeight: 200 })])).not.toThrow();
  });

  it("refuses a generation whose verifier keys are not this contract's, or whose runtime the decoder does not know", () => {
    expect(() => assertRegistryGenerations([registryInfo({ circuits: { anchor: { vkSha256: "00".repeat(32) }, anchor_hiding: registryInfo().circuits.anchor_hiding } })])).toThrow(
      /generation 1: anchor verifier key 0{64} is not the compiled 85dc57a4/,
    );
    expect(() => assertRegistryGenerations([registryInfo({ runtimeSpecVersion: 1000400 })])).toThrow(/generation 1: runtime 1000400 is not one this decoder knows \(1000300\)/);
  });

  it("refuses malformed addresses and hashes, repeated addresses and generations out of order", () => {
    expect(() => assertRegistryGenerations([registryInfo({ address: "AB".repeat(32) })])).toThrow(/generation 1: address must be 64 lowercase hex/);
    expect(() => assertRegistryGenerations([registryInfo({ deployTxHash: "cd".repeat(31) })])).toThrow(/generation 1: deployTxHash must be 64 lowercase hex/);
    expect(() => assertRegistryGenerations([registryInfo(), registryInfo({ generation: 2 })])).toThrow(/generation 2 repeats address/);
    expect(() => assertRegistryGenerations([registryInfo({ generation: 2 }), registryInfo({ generation: 1, address: "ef".repeat(32) })])).toThrow(
      /generations must count up from 1/,
    );
  });
});
