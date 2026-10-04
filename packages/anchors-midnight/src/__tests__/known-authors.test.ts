import { describe, expect, it } from "vitest";
import {
  KNOWN_AUTHORS_TRUST_ROOTS,
  SHIPPED_KNOWN_AUTHORS,
  knownAuthors,
  openKnownAuthors,
  signKnownAuthors,
  type KnownAuthorsDocument,
} from "../known-authors.js";
import { toHex } from "../scale.js";
import { ed25519PublicKey, ed25519Sign } from "../ed25519.js";
import { random32 } from "./registry-call.js";

const rootSeed = random32();
const root = toHex(ed25519PublicKey(rootSeed));
const relay = "aa".repeat(32);
const checkpoint = { setId: "9284", startsAfter: { height: 2772315, hash: "bb".repeat(32) }, authorities: [{ key: "cc".repeat(32), weight: "130" }] };

const doc = (overrides: Partial<KnownAuthorsDocument> = {}): KnownAuthorsDocument => ({
  format: "orynq-known-authors/v1",
  serial: 1,
  issued: "2026-10-04T00:00:00Z",
  networks: {
    mainnet: { authors: [{ key: relay, id: "fluxpoint-relay", role: "relay", validFrom: 100, validTo: null }], checkpoints: [checkpoint] },
  },
  ...overrides,
});
const signed = (d: KnownAuthorsDocument | string, seed = rootSeed) => signKnownAuthors(typeof d === "string" ? d : JSON.stringify(d), seed);
const refusal = (f: () => unknown) => {
  try {
    f();
    return "accepted";
  } catch (e) {
    return (e as Error).message;
  }
};

// Each check refuses with its own message, so a caller can tell which check a document failed.
const NOT_SIGNED_BY_A_TRUST_ROOT = "the known-authors document carries no signature by a trust root";
const MALFORMED = "the known-authors document's signature by a trust root is not 64 bytes of lowercase hex";
const DOES_NOT_VERIFY = "the known-authors document's signature by a trust root does not verify";

describe("signed KNOWN_AUTHORS documents", () => {
  it("positive control: a document a trust root signed opens, with its authors, windows and checkpoints", () => {
    const k = openKnownAuthors(signed(doc()), [root]);
    expect(k.serial).toBe(1);
    expect(k.authors("mainnet")).toEqual([{ key: relay, id: "fluxpoint-relay", role: "relay", validFrom: 100, validTo: null }]);
    expect(k.checkpoints("mainnet")).toEqual([{ setId: 9284n, startsAfter: checkpoint.startsAfter, authorities: [{ key: "cc".repeat(32), weight: 130n }] }]);
    expect(k.authors("preprod")).toEqual([]);
  });

  it("refuses a document with no signature, or signed only by keys that are not trust roots, before verifying any signature", () => {
    const good = signed(doc());
    expect(refusal(() => openKnownAuthors({ document: good.document, signatures: [] }, [root]))).toBe(NOT_SIGNED_BY_A_TRUST_ROOT);
    expect(refusal(() => openKnownAuthors(signed(doc(), random32()), [root]))).toBe(NOT_SIGNED_BY_A_TRUST_ROOT);
    expect(refusal(() => openKnownAuthors({ document: good.document, signatures: [{ key: "ab".repeat(32), signature: good.signatures[0]!.signature }] }, [root]))).toBe(NOT_SIGNED_BY_A_TRUST_ROOT);
  });

  it("refuses a trust root's signature over other bytes, or made with another key, at Ed25519 verification", () => {
    const good = signed(doc());
    const changed = { ...good, document: good.document.replace("fluxpoint-relay", "fluxpoint-relaY") };
    expect(refusal(() => openKnownAuthors(changed, [root]))).toBe(DOES_NOT_VERIFY);
    const [byStranger] = signed(doc(), random32()).signatures;
    expect(refusal(() => openKnownAuthors({ document: good.document, signatures: [{ key: root, signature: byStranger!.signature }] }, [root]))).toBe(DOES_NOT_VERIFY);
  });

  it("refuses a trust root's signature that is not 64 bytes of lowercase hex without verifying it", () => {
    const good = signed(doc());
    const { signature } = good.signatures[0]!;
    for (const bad of [signature.toUpperCase(), signature.slice(2), `${signature}00`, "zz".repeat(64)]) {
      expect(refusal(() => openKnownAuthors({ document: good.document, signatures: [{ key: root, signature: bad }] }, [root]))).toBe(MALFORMED);
    }
  });

  it("opens a document when any trust-root signature verifies, beside one that does not or one by a stranger", () => {
    const good = signed(doc());
    const [byStranger] = signed(doc(), random32()).signatures;
    const failing = { key: root, signature: byStranger!.signature };
    expect(openKnownAuthors({ document: good.document, signatures: [failing, ...good.signatures] }, [root]).serial).toBe(1);
    expect(openKnownAuthors({ document: good.document, signatures: [byStranger!, ...good.signatures] }, [root]).serial).toBe(1);
  });

  it("signs the domain-separated document bytes, so a signature over the bare document does not verify", () => {
    const d = JSON.stringify(doc());
    const bare = { document: d, signatures: [{ key: root, signature: toHex(ed25519Sign(new Uint8Array(Buffer.from(d)), rootSeed)) }] };
    expect(refusal(() => openKnownAuthors(bare, [root]))).toBe(DOES_NOT_VERIFY);
  });

  it("with no trust root configured, refuses every document", () => {
    expect(refusal(() => openKnownAuthors(signed(doc()), []))).toBe(NOT_SIGNED_BY_A_TRUST_ROOT);
  });

  it.each<[string, KnownAuthorsDocument | string, RegExp]>([
    ["an unknown format", doc({ format: "orynq-known-authors/v2" as never }), /format must be orynq-known-authors\/v1/],
    ["an unknown role", doc({ networks: { mainnet: { authors: [{ key: relay, id: "x", role: "vouch" as never, validFrom: 1, validTo: null }], checkpoints: [] } } }), /role must be one of relay/],
    ["a malformed key", doc({ networks: { mainnet: { authors: [{ key: "AA".repeat(32), id: "x", role: "relay", validFrom: 1, validTo: null }], checkpoints: [] } } }), /key must be 64 lowercase hex/],
    ["a window that ends before it starts", doc({ networks: { mainnet: { authors: [{ key: relay, id: "x", role: "relay", validFrom: 10, validTo: 9 }], checkpoints: [] } } }), /validTo 9 is below validFrom 10/],
    ["an unknown network", doc({ networks: { preview: { authors: [], checkpoints: [] } } as never }), /unknown network preview/],
    ["an unknown field", JSON.stringify({ ...doc(), extra: true }), /unknown field extra/],
    ["overlapping windows for one key", doc({ networks: { mainnet: { authors: [{ key: relay, id: "a", role: "relay", validFrom: 1, validTo: 50 }, { key: relay, id: "b", role: "relay", validFrom: 40, validTo: null }], checkpoints: [] } } }), /overlapping windows for key a{64}/],
    ["a checkpoint with a fractional weight", doc({ networks: { mainnet: { authors: [], checkpoints: [{ ...checkpoint, authorities: [{ key: "cc".repeat(32), weight: "1.5" }] }] } } }), /weight must be a decimal integer/],
  ])("refuses a signed document with %s", (_, d, expected) => {
    expect(refusal(() => openKnownAuthors(signed(d), [root]))).toMatch(expected);
  });
});

describe("author status at a height", () => {
  const k = openKnownAuthors(
    signed(doc({ networks: { mainnet: { authors: [{ key: relay, id: "fluxpoint-relay", role: "relay", validFrom: 100, validTo: 199 }], checkpoints: [] } } })),
    [root],
  );

  it("is known inside the window, at both ends", () => {
    for (const h of [100, 150, 199]) expect(k.author("mainnet", relay, h)).toEqual({ status: "known", id: "fluxpoint-relay", role: "relay", validFrom: 100, validTo: 199 });
  });

  it("is outside its window before validFrom and after validTo, and unknown for another key or network", () => {
    for (const h of [99, 200]) expect(k.author("mainnet", relay, h)).toMatchObject({ status: "outside-window", id: "fluxpoint-relay" });
    expect(k.author("mainnet", "dd".repeat(32), 150)).toEqual({ status: "unknown" });
    expect(k.author("preprod", relay, 150)).toEqual({ status: "unknown" });
  });
});

describe("the newest valid document wins, and a revocation needs no registry scan", () => {
  const first = signed(doc());
  const revoked = signed(doc({ serial: 2, networks: { mainnet: { authors: [{ key: relay, id: "fluxpoint-relay", role: "relay", validFrom: 100, validTo: 4999 }], checkpoints: [checkpoint] } } }));

  it("a later serial that closes a key's window turns its later anchors outside-window and keeps its earlier ones known", () => {
    const k = knownAuthors({ documents: [first, revoked], trustRoots: [root] });
    expect(k.serial).toBe(2);
    expect(k.author("mainnet", relay, 4999).status).toBe("known");
    expect(k.author("mainnet", relay, 5000).status).toBe("outside-window");
  });

  it("an older serial never rolls a revocation back, whatever order the documents arrive in", () => {
    expect(knownAuthors({ documents: [revoked, first], trustRoots: [root] }).serial).toBe(2);
  });

  it("refuses a document that does not verify rather than skipping it", () => {
    expect(refusal(() => knownAuthors({ documents: [first, signed(doc({ serial: 3 }), random32())], trustRoots: [root] }))).toBe(NOT_SIGNED_BY_A_TRUST_ROOT);
    const tampered = signed(doc({ serial: 3 }));
    expect(refusal(() => knownAuthors({ documents: [first, { ...tampered, document: tampered.document.replace('"serial":3', '"serial":4') }], trustRoots: [root] }))).toBe(DOES_NOT_VERIFY);
  });

  it("refuses two different documents with the same serial", () => {
    const other = signed(doc({ issued: "2026-10-05T00:00:00Z" }));
    expect(refusal(() => knownAuthors({ documents: [first, other], trustRoots: [root] }))).toMatch(/two different documents carry serial 1/);
  });
});

describe("what this package ships", () => {
  it("no trust root and no document until deci's offline key signs the first one, so no author is known yet", () => {
    expect(KNOWN_AUTHORS_TRUST_ROOTS).toEqual([]);
    expect(SHIPPED_KNOWN_AUTHORS).toEqual([]);
    const k = knownAuthors();
    expect(k.serial).toBe(0);
    for (const network of ["mainnet", "preprod"] as const) {
      expect(k.authors(network)).toEqual([]);
      expect(k.checkpoints(network)).toEqual([]);
    }
  });
});
