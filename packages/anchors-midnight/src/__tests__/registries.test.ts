import { describe, expect, it } from "vitest";
import { KNOWN_RUNTIME_SPEC_VERSIONS, MIDNIGHT_REGISTRIES, assertRegistryGenerations, registryRuntimeAllows, type RegistryInfo, type RuntimeSpan } from "../registries.js";
import { REGISTRY_VERIFIER_KEY_SHA256 } from "../registry.js";

export const registryInfo = (overrides: Partial<RegistryInfo> = {}): RegistryInfo => ({
  generation: 1,
  address: "ab".repeat(32),
  deployTxHash: "cd".repeat(32),
  deployHeight: 100,
  runtimes: [{ specVersion: 1000300, fromHeight: overrides.deployHeight ?? 100, toHeight: null }],
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
  // Mainnet's Ledger 9 upgrade: block 3346138 carries set_code and runs 1000300; 3346139 is the
  // first block runtime 2001100 executes. The registry is immutable, so generation 1 spans both.
  it("pins generation 1 on mainnet, deployed in block 3113819, under 1000300 through 3346138 and 2001100 from 3346139, with this contract's verifier keys, and none on preprod", () => {
    expect(Object.keys(MIDNIGHT_REGISTRIES).sort()).toEqual(["mainnet", "preprod"]);
    expect(MIDNIGHT_REGISTRIES.mainnet).toEqual([
      {
        generation: 1,
        address: "438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736",
        deployTxHash: "1bb33baad6eff44f9f485fef1a83b7f2200f09174d286936081574a3221535e8",
        deployHeight: 3113819,
        deployBlockHash: "29533edab5c2ac5777cbdf5c4d0a8b467666a308142c9e2418f13d5b2f06f27b",
        runtimes: [
          { specVersion: 1000300, fromHeight: 3113819, toHeight: 3346138 },
          { specVersion: 2001100, fromHeight: 3346139, toHeight: null },
        ],
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
    expect(() => assertRegistryGenerations([registryInfo({ runtimes: [{ specVersion: 1000400, fromHeight: 100, toHeight: null }] })])).toThrow(
      /generation 1: runtime 1000400 is not one this decoder knows \(1000300, 2001100\)/,
    );
  });

  it("refuses malformed addresses and hashes, repeated addresses and generations out of order", () => {
    expect(() => assertRegistryGenerations([registryInfo({ address: "AB".repeat(32) })])).toThrow(/generation 1: address must be 64 lowercase hex/);
    expect(() => assertRegistryGenerations([registryInfo({ deployBlockHash: "00" })])).toThrow(/deployBlockHash/);
    expect(() => assertRegistryGenerations([registryInfo({ deployTxHash: "cd".repeat(31) })])).toThrow(/generation 1: deployTxHash must be 64 lowercase hex/);
    expect(() => assertRegistryGenerations([registryInfo(), registryInfo({ generation: 2 })])).toThrow(/generation 2 repeats address/);
    expect(() => assertRegistryGenerations([registryInfo({ generation: 2 }), registryInfo({ generation: 1, address: "ef".repeat(32) })])).toThrow(
      /generations must count up from 1/,
    );
  });
});

describe("registry runtimes bound to height ranges", () => {
  const gen1 = MIDNIGHT_REGISTRIES.mainnet[0]!;
  const spans = (...runtimes: RuntimeSpan[]) => registryInfo({ runtimes });

  it("knows runtimes 1000300 and 2001100, and no other", () => {
    expect(KNOWN_RUNTIME_SPEC_VERSIONS).toEqual([1000300, 2001100]);
  });

  it("accepts 2001100 for generation 1 only from block 3346139, and 1000300 only from its deploy through 3346138", () => {
    expect(registryRuntimeAllows(gen1, 2001100, 3346139)).toBe(true);
    expect(registryRuntimeAllows(gen1, 2001100, 3400000)).toBe(true);
    expect(registryRuntimeAllows(gen1, 2001100, 3346138)).toBe(false);
    expect(registryRuntimeAllows(gen1, 1000300, 3346138)).toBe(true);
    expect(registryRuntimeAllows(gen1, 1000300, 3113819)).toBe(true);
    expect(registryRuntimeAllows(gen1, 1000300, 3346139)).toBe(false);
    expect(registryRuntimeAllows(gen1, 1000300, 3113818)).toBe(false);
    for (const height of [3113819, 3346138, 3346139]) expect(registryRuntimeAllows(gen1, 1000400, height)).toBe(false);
  });

  it("positive control: contiguous spans from the deploy height, the last one open, are accepted", () => {
    expect(() => assertRegistryGenerations([spans({ specVersion: 1000300, fromHeight: 100, toHeight: 199 }, { specVersion: 2001100, fromHeight: 200, toHeight: null })])).not.toThrow();
  });

  it.each<[string, RuntimeSpan[]]>([
    ["no span", []],
    ["a first span after the deploy height", [{ specVersion: 1000300, fromHeight: 101, toHeight: null }]],
    ["a first span before the deploy height", [{ specVersion: 1000300, fromHeight: 99, toHeight: null }]],
    ["a gap", [{ specVersion: 1000300, fromHeight: 100, toHeight: 199 }, { specVersion: 2001100, fromHeight: 201, toHeight: null }]],
    ["an overlap", [{ specVersion: 1000300, fromHeight: 100, toHeight: 200 }, { specVersion: 2001100, fromHeight: 200, toHeight: null }]],
    ["an empty span", [{ specVersion: 1000300, fromHeight: 100, toHeight: 99 }, { specVersion: 2001100, fromHeight: 100, toHeight: null }]],
    ["an open span before the last", [{ specVersion: 1000300, fromHeight: 100, toHeight: null }, { specVersion: 2001100, fromHeight: 200, toHeight: null }]],
  ])("refuses runtime spans with %s", (_, runtimes) => {
    expect(() => assertRegistryGenerations([spans(...runtimes)])).toThrow(/generation 1: runtime/);
  });
});
