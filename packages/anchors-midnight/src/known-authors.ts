import { ed25519PublicKey, ed25519Sign, ed25519Verify } from "./ed25519.js";
import type { FinalityCheckpoint } from "./grandpa.js";
import type { MidnightNetwork } from "./registries.js";
import { fromHex, toHex } from "./scale.js";
import shipped from "../known-authors.json" with { type: "json" };

// The authors a verifier recognizes, and the GRANDPA checkpoints it trusts, as a JSON document
// signed by an offline trust-root key. A revocation is a later document (a higher serial) that
// closes a key's window, so no verifier scans the permissionless registry to learn of one.
export const KNOWN_AUTHORS_FORMAT = "orynq-known-authors/v1";
const SIGNING_DOMAIN = `${KNOWN_AUTHORS_FORMAT}\n`;
const NETWORKS: readonly MidnightNetwork[] = ["mainnet", "preprod"];
const ROLES = ["relay"] as const;

export interface KnownAuthor {
  key: string;
  id: string;
  // relay: an anchor the FPS service wrote for whoever asked it to.
  role: (typeof ROLES)[number];
  // Block heights, inclusive; validTo null leaves the window open.
  validFrom: number;
  validTo: number | null;
}

export interface CheckpointJson {
  setId: string;
  startsAfter: { height: number; hash: string };
  authorities: Array<{ key: string; weight: string }>;
}

export interface KnownAuthorsDocument {
  format: typeof KNOWN_AUTHORS_FORMAT;
  serial: number;
  issued: string;
  networks: Partial<Record<MidnightNetwork, { authors: KnownAuthor[]; checkpoints: CheckpointJson[] }>>;
}

// The document is signed as the exact string it is shipped as, so no JSON canonicalization
// stands between a signature and what it covers.
export interface SignedKnownAuthors {
  document: string;
  signatures: Array<{ key: string; signature: string }>;
}

// Ed25519 public keys whose signature makes a document authoritative. The first is deci's
// offline key, added with the first signed document; until then no document is accepted.
export const KNOWN_AUTHORS_TRUST_ROOTS: readonly string[] = [];
// The signed documents this package ships, as `scripts/known-authors.ts sign` prints them.
export const SHIPPED_KNOWN_AUTHORS: readonly SignedKnownAuthors[] = shipped;

export type AuthorStatus =
  | ({ status: "known" | "outside-window" } & Omit<KnownAuthor, "key">)
  | { status: "unknown" };

export interface KnownAuthors {
  serial: number;
  authors(network: MidnightNetwork): readonly KnownAuthor[];
  checkpoints(network: MidnightNetwork): FinalityCheckpoint[];
  author(network: MidnightNetwork, key: string, height: number): AuthorStatus;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function exactKeys(value: unknown, keys: readonly string[], at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at} must be an object`);
  for (const k of Object.keys(value)) if (!keys.includes(k)) throw new Error(`${at} has unknown field ${k}`);
  for (const k of keys) if (!(k in value)) throw new Error(`${at} is missing ${k}`);
  return value as Record<string, unknown>;
}
const hex64 = (v: unknown, at: string) => {
  if (typeof v !== "string" || !HEX64.test(v)) throw new Error(`${at} must be 64 lowercase hex characters`);
  return v;
};
const height = (v: unknown, at: string) => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error(`${at} must be a block height`);
  return v as number;
};
const list = (v: unknown, at: string) => {
  if (!Array.isArray(v)) throw new Error(`${at} must be a list`);
  return v as unknown[];
};

function parseAuthor(v: unknown, at: string): KnownAuthor {
  const a = exactKeys(v, ["key", "id", "role", "validFrom", "validTo"], at);
  if (typeof a.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(a.id)) throw new Error(`${at}.id must be a short lowercase name`);
  if (!(ROLES as readonly unknown[]).includes(a.role)) throw new Error(`${at}.role must be one of ${ROLES.join(", ")}`);
  const validFrom = height(a.validFrom, `${at}.validFrom`);
  const validTo = a.validTo === null ? null : height(a.validTo, `${at}.validTo`);
  if (validTo !== null && validTo < validFrom) throw new Error(`${at}: validTo ${validTo} is below validFrom ${validFrom}`);
  return { key: hex64(a.key, `${at}.key`), id: a.id, role: a.role as KnownAuthor["role"], validFrom, validTo };
}

function parseCheckpoint(v: unknown, at: string): FinalityCheckpoint {
  const c = exactKeys(v, ["setId", "startsAfter", "authorities"], at);
  if (typeof c.setId !== "string" || !DECIMAL.test(c.setId)) throw new Error(`${at}.setId must be a decimal integer`);
  const s = exactKeys(c.startsAfter, ["height", "hash"], `${at}.startsAfter`);
  const authorities = list(c.authorities, `${at}.authorities`).map((x, i) => {
    const a = exactKeys(x, ["key", "weight"], `${at}.authorities[${i}]`);
    if (typeof a.weight !== "string" || !DECIMAL.test(a.weight) || a.weight === "0") throw new Error(`${at}.authorities[${i}].weight must be a decimal integer above 0`);
    return { key: hex64(a.key, `${at}.authorities[${i}].key`), weight: BigInt(a.weight) };
  });
  if (authorities.length === 0 || new Set(authorities.map((a) => a.key)).size !== authorities.length) throw new Error(`${at}.authorities must name distinct keys`);
  return { setId: BigInt(c.setId), startsAfter: { height: height(s.height, `${at}.startsAfter.height`), hash: hex64(s.hash, `${at}.startsAfter.hash`) }, authorities };
}

function parseDocument(text: string): { serial: number; networks: Map<MidnightNetwork, { authors: KnownAuthor[]; checkpoints: FinalityCheckpoint[] }> } {
  const d = exactKeys(JSON.parse(text), ["format", "serial", "issued", "networks"], "document");
  if (d.format !== KNOWN_AUTHORS_FORMAT) throw new Error(`document format must be ${KNOWN_AUTHORS_FORMAT}`);
  if (!Number.isSafeInteger(d.serial) || (d.serial as number) < 1) throw new Error("document serial must be an integer from 1");
  if (typeof d.issued !== "string" || Number.isNaN(Date.parse(d.issued))) throw new Error("document issued must be a date");
  if (typeof d.networks !== "object" || d.networks === null) throw new Error("document networks must be an object");
  const networks = new Map<MidnightNetwork, { authors: KnownAuthor[]; checkpoints: FinalityCheckpoint[] }>();
  for (const [name, value] of Object.entries(d.networks)) {
    if (!(NETWORKS as readonly string[]).includes(name)) throw new Error(`document names unknown network ${name}`);
    const n = exactKeys(value, ["authors", "checkpoints"], name);
    const authors = list(n.authors, `${name}.authors`).map((a, i) => parseAuthor(a, `${name}.authors[${i}]`));
    for (const a of authors) {
      for (const b of authors) {
        if (a !== b && a.key === b.key && a.validFrom <= (b.validTo ?? Infinity) && b.validFrom <= (a.validTo ?? Infinity)) {
          throw new Error(`${name}.authors gives overlapping windows for key ${a.key}`);
        }
      }
    }
    const checkpoints = list(n.checkpoints, `${name}.checkpoints`).map((c, i) => parseCheckpoint(c, `${name}.checkpoints[${i}]`));
    networks.set(name as MidnightNetwork, { authors, checkpoints });
  }
  return { serial: d.serial as number, networks };
}

const signingMessage = (document: string) => new Uint8Array(Buffer.from(SIGNING_DOMAIN + document, "utf8"));

export function signKnownAuthors(document: string, seed: Uint8Array): SignedKnownAuthors {
  parseDocument(document);
  return { document, signatures: [{ key: toHex(ed25519PublicKey(seed)), signature: toHex(ed25519Sign(signingMessage(document), seed)) }] };
}

function view(serial: number, networks: ReturnType<typeof parseDocument>["networks"]): KnownAuthors {
  return {
    serial,
    authors: (network) => networks.get(network)?.authors ?? [],
    checkpoints: (network) => networks.get(network)?.checkpoints ?? [],
    author(network, key, at) {
      const entries = (networks.get(network)?.authors ?? []).filter((a) => a.key === key);
      if (entries.length === 0) return { status: "unknown" };
      const inside = entries.find((a) => a.validFrom <= at && at <= (a.validTo ?? Infinity));
      const { key: _key, ...entry } = inside ?? entries[0]!;
      return { status: inside ? "known" : "outside-window", ...entry };
    },
  };
}

// Opens a signed document: at least one signature, over the domain-separated document string,
// must verify under one of `trustRoots`, and the document must parse strictly. Each check
// refuses with its own message, so a refusal names the check that made it.
export function openKnownAuthors(signed: SignedKnownAuthors, trustRoots: readonly string[] = KNOWN_AUTHORS_TRUST_ROOTS): KnownAuthors {
  const byRoot = signed.signatures.filter((s) => trustRoots.includes(s.key) && HEX64.test(s.key));
  if (byRoot.length === 0) throw new Error("the known-authors document carries no signature by a trust root");
  const wellFormed = byRoot.filter((s) => /^[0-9a-f]{128}$/.test(s.signature));
  if (wellFormed.length === 0) throw new Error("the known-authors document's signature by a trust root is not 64 bytes of lowercase hex");
  const message = signingMessage(signed.document);
  if (!wellFormed.some((s) => ed25519Verify(fromHex(s.signature, "signature"), message, fromHex(s.key, "trust root")))) {
    throw new Error("the known-authors document's signature by a trust root does not verify");
  }
  const { serial, networks } = parseDocument(signed.document);
  return view(serial, networks);
}

// The newest of the shipped documents and `documents`: every one must open, so a document
// that fails is an error rather than something to skip, and an older serial never wins.
export function knownAuthors({ documents = [], trustRoots = KNOWN_AUTHORS_TRUST_ROOTS }: { documents?: readonly SignedKnownAuthors[]; trustRoots?: readonly string[] } = {}): KnownAuthors {
  const all = [...SHIPPED_KNOWN_AUTHORS, ...documents];
  const bySerial = new Map<number, string>();
  let newest: KnownAuthors = view(0, new Map());
  for (const signed of all) {
    const opened = openKnownAuthors(signed, trustRoots);
    const seen = bySerial.get(opened.serial);
    if (seen !== undefined && seen !== signed.document) throw new Error(`two different documents carry serial ${opened.serial}`);
    bySerial.set(opened.serial, signed.document);
    if (opened.serial > newest.serial) newest = opened;
  }
  return newest;
}
