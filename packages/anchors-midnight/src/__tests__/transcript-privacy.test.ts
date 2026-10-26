import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pureCircuits } from "../../contract/managed/contract/index.js";
import { encodedWindows, windowHits } from "./privacy-scan.js";
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

  it("positive control: the scan finds every window of every disclosed value the published bytes encode", () => {
    const disclosed = { commitment: after.last_commitment, attribute, author: pureCircuits.author_key(authorSecret) };
    for (const [name, value] of Object.entries(disclosed)) expect(windowHits(published, value), name).toBe(encodedWindows(value));
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
    expect(windowHits(published, commitment)).toBe(encodedWindows(commitment));
    expect(windowHits(published, pureCircuits.author_key(authorSecret))).toBe(encodedWindows(pureCircuits.author_key(authorSecret)));
  });

  it("the published bytes hold no window of the author secret", () => {
    expect(windowHits(published, authorSecret)).toBe(0);
  });
});

// A random 32-byte value ends in a zero byte about once in 256 draws, so a control that expects
// all 25 raw windows fails that often.
describe("the positive control holds for a disclosed value that ends in zero bytes", () => {
  it.each([1, 2])("an attribute ending in %i zero bytes", (zeros) => {
    const attribute = random32();
    attribute[31 - zeros] ||= 1;
    attribute.fill(0, 32 - zeros);
    const { published } = encodings({ circuit: "anchor_hiding", args: [attribute] }, { authorSecret: random32(), hiddenEntry: { root_hash: random32(), manifest_hash: random32(), merkle_root: random32(), salt: random32() } });
    expect(encodedWindows(attribute)).toBe(25 - zeros);
    expect(windowHits(published, attribute)).toBe(encodedWindows(attribute));
  });
});

// The fixture's calls were proven and bound in-process, so these are the bytes a node receives.
describe("the proven, bound registry calls in the fixtures", () => {
  const f = JSON.parse(readFileSync(new URL("./fixtures/registry-transactions.json", import.meta.url), "utf8"));
  const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
  const opening = Object.fromEntries(Object.entries(f.hiding.opening as Record<string, string>).map(([k, v]) => [k, bytes(v)]));

  it("positive control: every disclosed value is in the bytes, every window they encode", () => {
    for (const value of [f.anchor.commitment, f.author.key]) expect(windowHits(bytes(f.anchor.tx), bytes(value))).toBe(encodedWindows(bytes(value)));
    for (const value of [f.hiding.commitment, f.hiding.attribute, f.author.key]) expect(windowHits(bytes(f.hiding.tx), bytes(value))).toBe(encodedWindows(bytes(value)));
  });

  it("hold no window of the author secret or of the kind-2 opening in any encoding", () => {
    for (const tx of [f.anchor.tx, f.hiding.tx]) expect(windowHits(bytes(tx), bytes(f.author.secret))).toBe(0);
    for (const [name, value] of Object.entries(opening)) expect(windowHits(bytes(f.hiding.tx), value), name).toBe(0);
  });
});
