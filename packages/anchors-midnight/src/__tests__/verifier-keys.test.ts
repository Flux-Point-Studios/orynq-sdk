import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import { Zkir } from "@midnight-ntwrk/zkir-v2";
import {
  REGISTRY_CIRCUITS,
  REGISTRY_VERIFIER_KEY_SHA256,
  canonicalVerifierKey,
  compiledVerifierKeys,
  registryInitialState,
} from "../registry.js";
import { hex } from "./registry-call.js";

const keyFile = (name: string) => new Uint8Array(readFileSync(new URL(`../../contract/managed/keys/${name}.verifier`, import.meta.url)));

describe("the registry's verifier keys", () => {
  it("are the keys an independent compile without the exported pure circuits reproduced, at k=13 and k=14", () => {
    expect(REGISTRY_VERIFIER_KEY_SHA256).toEqual({
      anchor: "85dc57a4269dd3aceb82867ecc6c145ef5f679c6f51767f200250e7c075777c5",
      anchor_hiding: "081384ce20f2a726e1dd79c0bbfbaabb0fe756ffa15ae429be4cee30b47e790f",
    });
    for (const name of REGISTRY_CIRCUITS) {
      expect(createHash("sha256").update(keyFile(name)).digest("hex")).toBe(REGISTRY_VERIFIER_KEY_SHA256[name]);
    }
    const k = (name: string) => Zkir.deserialize(new Uint8Array(readFileSync(new URL(`../../contract/managed/zkir/${name}.bzkir`, import.meta.url)))).getK();
    expect([k("anchor"), k("anchor_hiding")]).toEqual([13, 14]);
  });

  it("are canonical: one ContractOperation round-trip is a fixed point, and the deploy state holds exactly that encoding", () => {
    const state = registryInitialState();
    for (const name of REGISTRY_CIRCUITS) {
      const canonical = canonicalVerifierKey(keyFile(name));
      expect(hex(L.ContractOperation.deserialize(Buffer.from(canonical, "hex")).serialize())).toBe(canonical);
      expect(hex(state.operation(name)!.serialize())).toBe(canonical);
    }
  });

  it("negative control: ledger 8.1.3 refuses a verifier key with a trailing byte, so no second encoding of a key exists", () => {
    const padded = new Uint8Array([...keyFile("anchor"), 0]);
    expect(() => canonicalVerifierKey(padded)).toThrow(/Not all bytes read .*1 bytes remaining/);
  });

  it("are read from disk only when each file still matches its pin", async () => {
    expect(hex(compiledVerifierKeys().anchor)).toBe(hex(keyFile("anchor")));
    vi.resetModules();
    vi.doMock("node:fs", async (original) => {
      const fs = await original<typeof import("node:fs")>();
      const readFileSync = (path: Parameters<typeof fs.readFileSync>[0]) => {
        const bytes = Buffer.from(fs.readFileSync(path));
        if (String(path).endsWith("/anchor.verifier")) bytes[100]! ^= 1;
        return bytes;
      };
      return { ...fs, readFileSync, default: { ...fs, readFileSync } };
    });
    try {
      const tampered = await import("../registry.js");
      expect(() => tampered.compiledVerifierKeys()).toThrow(/^anchor\.verifier hashes to [0-9a-f]{64}, pinned 85dc57a4/);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});
