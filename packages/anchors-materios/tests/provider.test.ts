import { describe, it, expect } from "vitest";
import { MateriosProvider } from "../src/provider.js";

describe("MateriosProvider", () => {
  it("should create provider with config", () => {
    const provider = new MateriosProvider({
      rpcUrl: "ws://localhost:9944",
      signerUri: "//Alice",
    });
    expect(provider).toBeDefined();
  });

  it("should throw if not connected", () => {
    const provider = new MateriosProvider({
      rpcUrl: "ws://localhost:9944",
      signerUri: "//Alice",
    });
    expect(() => provider.getApi()).toThrow("Not connected");
    expect(() => provider.getKeypair()).toThrow("Not connected");
  });
});
