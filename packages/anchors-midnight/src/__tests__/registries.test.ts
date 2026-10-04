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
  it("lists mainnet and preprod, and no generation is deployed on either yet", () => {
    expect(Object.keys(MIDNIGHT_REGISTRIES).sort()).toEqual(["mainnet", "preprod"]);
    expect(MIDNIGHT_REGISTRIES.mainnet).toEqual([]);
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
