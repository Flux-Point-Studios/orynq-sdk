import { describe, expect, it } from "vitest";
import { pureCircuits } from "../../contract/managed/contract/index.js";
import { windowHits } from "./privacy-scan.js";
import { deployedRegistry, random32, unprovenRegistryCall } from "./registry-call.js";

// The real encodings of a registry call: the unproven transaction is the preimage handed to the
// prover, and the proof-erased transaction is every public byte except the proof itself (the
// slow suite scans the proven, bound bytes too).
function encodings(call: Parameters<typeof unprovenRegistryCall>[0]["call"], witnesses: Parameters<typeof unprovenRegistryCall>[0]["witnesses"]) {
  const { tx, after } = unprovenRegistryCall({ ...deployedRegistry(), call, witnesses });
  return { preimage: tx.serialize(), published: tx.eraseProofs().serialize(), after };
}

describe("anchor_hiding keeps the author secret and the opening out of every public byte", () => {
  const authorSecret = random32();
  const entry = { root_hash: random32(), manifest_hash: random32(), merkle_root: random32(), salt: random32() };
  const attribute = random32();
  const { preimage, published, after } = encodings({ circuit: "anchor_hiding", args: [attribute] }, { authorSecret, hiddenEntry: entry });
  const secrets = { authorSecret, ...entry };

  it("positive control: the scan finds every secret in the proof preimage", () => {
    for (const [name, value] of Object.entries(secrets)) expect(windowHits(preimage, value), name).toBeGreaterThanOrEqual(20);
  });

  it("positive control: the scan finds every disclosed value, all 25 windows, in the published bytes", () => {
    const disclosed = { commitment: after.last_commitment, attribute, author: pureCircuits.author_key(authorSecret) };
    for (const [name, value] of Object.entries(disclosed)) expect(windowHits(published, value), name).toBe(25);
  });

  it("the published bytes hold no window of any secret in any encoding", () => {
    for (const [name, value] of Object.entries(secrets)) expect(windowHits(published, value), name).toBe(0);
  });
});

describe("anchor keeps the author secret out of every public byte", () => {
  const authorSecret = random32();
  const commitment = random32();
  const { preimage, published } = encodings({ circuit: "anchor", args: [commitment, 1n] }, { authorSecret });

  it("positive controls: the secret is in the preimage; commitment and author are in the published bytes", () => {
    expect(windowHits(preimage, authorSecret)).toBeGreaterThanOrEqual(20);
    expect(windowHits(published, commitment)).toBe(25);
    expect(windowHits(published, pureCircuits.author_key(authorSecret))).toBe(25);
  });

  it("the published bytes hold no window of the author secret", () => {
    expect(windowHits(published, authorSecret)).toBe(0);
  });
});
