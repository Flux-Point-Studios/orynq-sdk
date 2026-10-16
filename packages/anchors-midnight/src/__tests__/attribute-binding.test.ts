import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { computeRootHash } from "@fluxpointstudios/orynq-sdk-process-trace";
import { pureCircuits } from "../../contract/managed/contract/index.js";
import { deployedRegistry, hex, random32, unprovenRegistryCall } from "./registry-call.js";

// Exactly what anchor_hiding binds: the attribute to the commitment, not to the trace.
const sha256 = (s: string) => new Uint8Array(createHash("sha256").update(s).digest());
const anchorHiding = (attribute: Uint8Array, entry: { root_hash: Uint8Array; manifest_hash: Uint8Array; merkle_root: Uint8Array; salt: Uint8Array }) =>
  unprovenRegistryCall({
    ...deployedRegistry(),
    call: { circuit: "anchor_hiding", args: [attribute] },
    witnesses: { authorSecret: random32(), hiddenEntry: entry },
  });

describe("anchor_hiding binds the attribute to the commitment", () => {
  it("no opening of the published commitment carries a different attribute: every one-bit change of it changes the commitment", () => {
    const entry = { root_hash: random32(), manifest_hash: random32(), merkle_root: random32(), salt: random32() };
    const attribute = random32();
    const published = hex(anchorHiding(attribute, entry).after.last_commitment);
    const commitmentFor = (a: Uint8Array) =>
      hex(pureCircuits.hiding_commitment(pureCircuits.hidden_digest(entry.root_hash, entry.manifest_hash, entry.merkle_root, a), entry.salt));
    expect(commitmentFor(attribute)).toBe(published);
    for (let bit = 0; bit < 256; bit++) {
      const other = attribute.slice();
      other[bit >> 3]! ^= 1 << (bit & 7);
      expect(commitmentFor(other)).not.toBe(published);
    }
  });
});

describe("anchor_hiding does not bind the attribute to the trace", () => {
  it("a trace whose root binds model manifest B is anchored with attribute A, and B never appears in public", async () => {
    const manifestA = sha256("model-manifest-A");
    const manifestB = sha256("model-manifest-B");
    const spans = [{ id: "s1", spanSeq: 0, hash: hex(sha256("span-1")) }] as Parameters<typeof computeRootHash>[1];
    const root = Buffer.from(await computeRootHash(hex(sha256("rolling")), spans, hex(manifestB)), "hex");
    const entry = { root_hash: new Uint8Array(root), manifest_hash: sha256("bundle-manifest"), merkle_root: sha256("merkle"), salt: random32() };

    const { result, after } = anchorHiding(manifestA, entry);

    expect(hex(after.last_attribute)).toBe(hex(manifestA));
    const published = JSON.stringify(result.proofData.publicTranscript, (_, v) =>
      v instanceof Uint8Array ? hex(v) : typeof v === "bigint" ? String(v) : v,
    );
    expect(published).toContain(hex(manifestA));
    expect(published).toContain(hex(after.last_commitment));
    expect(published).not.toContain(hex(manifestB));
  });
});
