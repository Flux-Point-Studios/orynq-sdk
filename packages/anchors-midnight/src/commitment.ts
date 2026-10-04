import { closeSync, constants, openSync, writeSync } from "node:fs";
import { pureCircuits } from "../contract/managed/contract/index.js";
import { readPrivateFile } from "./private-file.js";

// The kinds the registry writes: anchor() refuses kind 2, which only anchor_hiding() writes.
// A verifier rejects every other kind.
export const ANCHOR_KIND = { ENTRY_PUBLIC: 1, ENTRY_HIDDEN: 2 } as const;
export type AnchorKind = (typeof ANCHOR_KIND)[keyof typeof ANCHOR_KIND];

export type Hash32 = Uint8Array | string;

const HEX64 = /^[0-9a-fA-F]{64}$/;
const ZERO32 = new Uint8Array(32);

// 32 bytes, or 64 hex characters with an optional "sha256:" or "0x" prefix, the forms
// process-trace and anchors-cardano write hashes in. Errors name the field and omit the value.
export function hash32(value: Hash32, name: string): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== 32) throw new Error(`${name} must be 32 bytes, got ${value.length}`);
    return value;
  }
  const bare = value.startsWith("sha256:") ? value.slice(7) : value.startsWith("0x") ? value.slice(2) : value;
  if (!HEX64.test(bare)) throw new Error(`${name} must be 32 bytes: 64 hex characters, optionally prefixed sha256: or 0x`);
  return new Uint8Array(Buffer.from(bare, "hex"));
}

// The fields of an anchors-cardano AnchorEntry that a commitment binds.
export interface EntryHashes {
  rootHash: Hash32;
  manifestHash: Hash32;
  merkleRoot?: Hash32 | undefined;
}

const entryWords = (entry: EntryHashes) =>
  [hash32(entry.rootHash, "rootHash"), hash32(entry.manifestHash, "manifestHash"), entry.merkleRoot === undefined ? ZERO32 : hash32(entry.merkleRoot, "merkleRoot")] as const;

// Kind 1: the public commitment, entry_digest(root, manifest, merkle or 32 zero bytes).
export function entryCommitment(entry: EntryHashes): Uint8Array {
  return pureCircuits.entry_digest(...entryWords(entry));
}

// Kind 2: anchor_hiding() publishes hidingCommitment(hiddenDigest(entry, attribute), salt) and
// the attribute. That binds the attribute to the commitment; nothing in the circuit checks the
// attribute against the trace the entry hashes.
export function hiddenDigest(entry: EntryHashes, attribute: Hash32): Uint8Array {
  return pureCircuits.hidden_digest(...entryWords(entry), hash32(attribute, "attribute"));
}

export function hidingCommitment(digest: Hash32, salt: Hash32): Uint8Array {
  return pureCircuits.hiding_commitment(hash32(digest, "digest"), hash32(salt, "salt"));
}

export function deriveSalt(saltKey: Hash32, digest: Hash32): Uint8Array {
  return pureCircuits.derive_salt(hash32(saltKey, "saltKey"), hash32(digest, "digest"));
}

// The public key an author proves knowledge of: SHA-256(pad32("orynq:anchor:author:v1") ‖ secret).
export function authorKey(secret: Hash32): Uint8Array {
  return pureCircuits.author_key(hash32(secret, "author secret"));
}

// Writes a fresh random author secret, as 64 hex characters, to a new file only its owner can
// read, and returns the public author key. It never replaces an existing file. The secret is 32
// bytes from the platform CSPRNG, unrelated to any wallet seed.
export function createAuthorKeyFile(path: string): string {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${Buffer.from(secret).toString("hex")}\n`);
  } finally {
    closeSync(fd);
  }
  return Buffer.from(authorKey(secret)).toString("hex");
}

// Reads an author secret written by createAuthorKeyFile, refusing a symlink, anything but a
// regular file the caller owns, and a file group or others can read or write.
export function readAuthorSecret(path: string): Uint8Array {
  const text = readPrivateFile(path);
  if (!HEX64.test(text)) throw new Error(`${path} must hold exactly 64 hex characters`);
  return new Uint8Array(Buffer.from(text, "hex"));
}
