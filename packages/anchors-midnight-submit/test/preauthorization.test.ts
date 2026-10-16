import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { authorizationIntent, intentDigest, assertPreauthorizedBytes } from "../src/preauthorization.js";
import { buildRegistryDeploy } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { prover } from "./prover.js";
import { fresh, mutableDeploy } from "./fakes.js";
import { closeSimulators, dustOnSimulator, NIGHT } from "./simulator.js";
import { declaredFee } from "../src/submission.js";

describe("pre-authorized intent", () => {
  it("reads the actual fee from balanced bytes and sends nothing above the cap", async () => {
    try {
      const simulation = await dustOnSimulator([NIGHT]);
      const tx = (await simulation.balance()).mockProve();
      const fee = declaredFee(tx);
      expect(fee).toBeGreaterThan(0n);
      const prepared = { network: "mainnet" as const, bytes: tx.serialize(), txHash: tx.transactionHash(), ttl: new Date(), declaredFee: fee, payer: "mn_addr1payer" };
      let sends = 0;
      expect(() => { assertPreauthorizedBytes(prepared, prepared.payer, fee - 1n, false); sends++; }).toThrow("cap");
      expect(sends).toBe(0);
      expect(() => assertPreauthorizedBytes(prepared, prepared.payer, fee, false)).not.toThrow();
    } finally { await closeSimulators(); }
  });
  it("is stable under object order and binds every deploy field", () => {
    const intent = authorizationIntent("mn_addr1payer", 10n ** 15n);
    const digest = intentDigest(intent);
    expect(intentDigest(Object.fromEntries(Object.entries(intent).reverse()))).toBe(digest);
    function mutateLeaves(value: unknown, path: string[] = []): string[][] {
      if (value && typeof value === "object" && Object.keys(value).length) return Object.entries(value).flatMap(([key, child]) => mutateLeaves(child, [...path, key]));
      return [path];
    }
    for (const path of mutateLeaves(intent)) {
      const changed = structuredClone(intent) as Record<string, unknown>;
      let parent = changed;
      for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
      parent[path.at(-1)!] = "different";
      expect(intentDigest(changed), path.join(".")).not.toBe(digest);
    }
  });

  it("binds exact plan bytes, registry, labels and kinds", () => {
    const path = fresh("plan.json");
    const raw = { registry: "ab".repeat(32), entries: [{ label: "entry", kind: 1, rootHash: "11".repeat(32), manifestHash: "22".repeat(32) }] };
    const value = { registry: raw.registry, entries: [{ label: "entry", kind: 1 as const, entry: { rootHash: raw.entries[0]!.rootHash, manifestHash: raw.entries[0]!.manifestHash } }] };
    writeFileSync(path, JSON.stringify(raw));
    const intent = authorizationIntent("mn_addr1payer", 1n, { path, value });
    writeFileSync(path, JSON.stringify(raw, null, 2));
    expect(intentDigest(authorizationIntent("mn_addr1payer", 1n, { path, value }))).not.toBe(intentDigest(intent));
    writeFileSync(path, JSON.stringify({ ...raw, registry: "cd".repeat(32) }));
    expect(() => authorizationIntent("mn_addr1payer", 1n, { path, value })).toThrow("plan changed");
  });

  it("refuses wrong payer, fee summary, network, hash and mutable final bytes before a send", async () => {
    const ttl = new Date(Date.now() + 600_000);
    const tx = (await prover.prove(buildRegistryDeploy({ networkId: "mainnet", ttl }).tx)).bind();
    const prepared = { network: "mainnet" as const, bytes: tx.serialize(), txHash: tx.transactionHash(), ttl, declaredFee: 0n, payer: "mn_addr1payer" };
    expect(() => assertPreauthorizedBytes(prepared, prepared.payer, 0n, true)).not.toThrow();
    const mutable = await mutableDeploy("mainnet");
    for (const changed of [
      { ...prepared, payer: "other" }, { ...prepared, declaredFee: 2n },
      { ...prepared, network: "preprod" as const }, { ...prepared, txHash: "00".repeat(32) },
      { ...prepared, bytes: mutable.serialize(), txHash: mutable.transactionHash() },
    ]) {
      let sends = 0;
      expect(() => { assertPreauthorizedBytes(changed, prepared.payer, 1n, true); sends++; }).toThrow();
      expect(sends).toBe(0);
    }
  });
});
