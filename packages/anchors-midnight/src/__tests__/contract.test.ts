import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as rt from "@midnight-ntwrk/compact-runtime";
import { ledger, pureCircuits } from "../../contract/managed/contract/index.js";
import { deployedRegistry as deployed, hex, opNames, pad32, random32, unprovenRegistryCall } from "./registry-call.js";

const sha256 = (...parts: Uint8Array[]) => createHash("sha256").update(Buffer.concat(parts)).digest("hex");

describe("orynq-anchor-registry in the simulator", () => {
  it("the constructor sets schema v1 and no anchors", () => {
    const st = ledger(rt.ContractState.deserialize(deployed().state.serialize()).data);
    expect(Buffer.from(st.schema).toString("utf8").replace(/\0+$/, "")).toBe("orynq-anchor-registry:v1");
    expect(st.anchors).toBe(0n);
  });

  it("anchor writes commitment, kind and author, clears the attribute, and never reads state", () => {
    const authorSecret = random32();
    const commitment = random32();
    const { result, after, guaranteed, fallible } = unprovenRegistryCall({
      ...deployed(),
      call: { circuit: "anchor", args: [commitment, 1n] },
      witnesses: { authorSecret },
    });
    expect(hex(after.last_commitment)).toBe(hex(commitment));
    expect(after.last_kind).toBe(1n);
    expect(hex(after.last_author)).toBe(hex(pureCircuits.author_key(authorSecret)));
    expect(hex(after.last_attribute)).toBe("00".repeat(32));
    expect(after.anchors).toBe(1n);
    expect(opNames(result.proofData.publicTranscript)).toEqual(["addi", "idx", "ins", "push"]);
    expect(opNames(guaranteed!.program)).toEqual(["addi", "idx", "ins", "push"]);
    expect(fallible).toBeUndefined();
  });

  it("anchor refuses kind 2, which only anchor_hiding may write", () => {
    expect(() =>
      unprovenRegistryCall({ ...deployed(), call: { circuit: "anchor", args: [random32(), 2n] }, witnesses: { authorSecret: random32() } }),
    ).toThrow(/kind 2 is written only by anchor_hiding/);
  });

  it("anchor_hiding computes the commitment in-circuit and discloses only commitment, attribute and author", () => {
    const authorSecret = random32();
    const attribute = random32();
    const entry = { root_hash: random32(), manifest_hash: random32(), merkle_root: random32(), salt: random32() };
    const { result, after, guaranteed, fallible } = unprovenRegistryCall({
      ...deployed(),
      call: { circuit: "anchor_hiding", args: [attribute] },
      witnesses: { authorSecret, hiddenEntry: entry },
    });
    const expected = pureCircuits.hiding_commitment(
      pureCircuits.hidden_digest(entry.root_hash, entry.manifest_hash, entry.merkle_root, attribute),
      entry.salt,
    );
    expect(hex(after.last_commitment)).toBe(hex(expected));
    expect(after.last_kind).toBe(2n);
    expect(hex(after.last_attribute)).toBe(hex(attribute));
    expect(hex(after.last_author)).toBe(hex(pureCircuits.author_key(authorSecret)));
    expect(opNames(result.proofData.publicTranscript)).toEqual(["addi", "idx", "ins", "push"]);
    expect(opNames(guaranteed!.program)).toEqual(["addi", "idx", "ins", "push"]);
    expect(fallible).toBeUndefined();
  });

  it("binds the author to the secret: the state holds author_key(secret), distinct per secret, never the secret", () => {
    const a = random32();
    const b = random32();
    const authorOf = (authorSecret: Uint8Array) =>
      unprovenRegistryCall({ ...deployed(), call: { circuit: "anchor", args: [random32(), 1n] }, witnesses: { authorSecret } }).after.last_author;
    expect(hex(authorOf(a))).toBe(hex(pureCircuits.author_key(a)));
    expect(hex(authorOf(a))).not.toBe(hex(authorOf(b)));
    expect(hex(authorOf(a))).not.toBe(hex(a));
  });
});

describe("the commitment scheme is plain SHA-256 over 32-byte words", () => {
  it("each pure circuit equals SHA-256 of its domain word and inputs, computed with node:crypto alone", () => {
    const [sk, root, manifest, merkle, attribute, salt, saltKey, digest] = Array.from({ length: 8 }, random32) as Uint8Array[];
    expect(hex(pureCircuits.author_key(sk!))).toBe(sha256(pad32("orynq:anchor:author:v1"), sk!));
    expect(hex(pureCircuits.entry_digest(root!, manifest!, merkle!))).toBe(sha256(pad32("orynq:anchor-entry:v1"), root!, manifest!, merkle!));
    expect(hex(pureCircuits.hidden_digest(root!, manifest!, merkle!, attribute!))).toBe(
      sha256(pad32("orynq:anchor-hidden:v1"), root!, manifest!, merkle!, attribute!),
    );
    expect(hex(pureCircuits.hiding_commitment(digest!, salt!))).toBe(sha256(salt!, digest!));
    expect(hex(pureCircuits.derive_salt(saltKey!, digest!))).toBe(sha256(pad32("orynq:anchor-salt:v1"), saltKey!, digest!));
  });

  it("each pure circuit equals the runtime's persistentHash or persistentCommit (golden equivalence)", () => {
    const [sk, root, manifest, merkle, attribute, salt] = Array.from({ length: 6 }, random32) as Uint8Array[];
    const B32 = new rt.CompactTypeBytes(32);
    const vec = (n: number) => new rt.CompactTypeVector(n, B32);
    expect(hex(pureCircuits.author_key(sk!))).toBe(hex(rt.persistentHash(vec(2), [pad32("orynq:anchor:author:v1"), sk!])));
    expect(hex(pureCircuits.entry_digest(root!, manifest!, merkle!))).toBe(
      hex(rt.persistentHash(vec(4), [pad32("orynq:anchor-entry:v1"), root!, manifest!, merkle!])),
    );
    expect(hex(pureCircuits.hidden_digest(root!, manifest!, merkle!, attribute!))).toBe(
      hex(rt.persistentHash(vec(5), [pad32("orynq:anchor-hidden:v1"), root!, manifest!, merkle!, attribute!])),
    );
    expect(hex(pureCircuits.hiding_commitment(root!, salt!))).toBe(hex(rt.persistentCommit(B32, root!, salt!)));
  });
});
