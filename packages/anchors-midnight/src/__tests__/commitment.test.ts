import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANCHOR_KIND,
  authorKey,
  createAuthorKeyFile,
  createSaltKeyFile,
  deriveSalt,
  entryCommitment,
  hash32,
  hiddenDigest,
  hidingCommitment,
  readAuthorSecret,
  saltKeyId,
} from "../commitment.js";
import { hex, pad32, random32 } from "./registry-call.js";

const sha256 = (...parts: Uint8Array[]) => createHash("sha256").update(Buffer.concat(parts)).digest("hex");
const ZERO = new Uint8Array(32);

describe("commitments are the compiled pure circuits, which are plain SHA-256", () => {
  const root = random32();
  const manifest = random32();
  const merkle = random32();
  const attribute = random32();
  const salt = random32();

  it("ANCHOR_KIND names exactly the two kinds the registry writes", () => {
    expect(ANCHOR_KIND).toEqual({ ENTRY_PUBLIC: 1, ENTRY_HIDDEN: 2 });
  });

  it("entryCommitment is entry_digest over the entry's hashes, written as sha256:-prefixed or bare hex", () => {
    const entry = { rootHash: `sha256:${hex(root)}`, manifestHash: hex(manifest).toUpperCase(), merkleRoot: `0x${hex(merkle)}` };
    expect(hex(entryCommitment(entry))).toBe(sha256(pad32("orynq:anchor-entry:v1"), root, manifest, merkle));
  });

  it("an entry without a merkle root commits to 32 zero bytes in its place", () => {
    expect(hex(entryCommitment({ rootHash: root, manifestHash: manifest }))).toBe(sha256(pad32("orynq:anchor-entry:v1"), root, manifest, ZERO));
  });

  it("the kind-2 commitment opens as SHA-256(salt ‖ hidden_digest(root, manifest, merkle, attribute))", () => {
    const digest = hiddenDigest({ rootHash: root, manifestHash: manifest, merkleRoot: merkle }, attribute);
    expect(hex(digest)).toBe(sha256(pad32("orynq:anchor-hidden:v1"), root, manifest, merkle, attribute));
    expect(hex(hidingCommitment(digest, salt))).toBe(sha256(salt, digest));
  });

  it("deriveSalt and authorKey are the salt and author circuits", () => {
    const key = random32();
    expect(hex(deriveSalt(key, root))).toBe(sha256(pad32("orynq:anchor-salt:v1"), key, root));
    expect(hex(authorKey(key))).toBe(sha256(pad32("orynq:anchor:author:v1"), key));
  });

  it("hash32 refuses anything but exactly 32 bytes, naming the field and never echoing the value", () => {
    const secretLooking = "ab".repeat(31);
    for (const bad of [secretLooking, "zz".repeat(32), `sha256:${"ab".repeat(33)}`, new Uint8Array(31), "", `sha512:${"ab".repeat(32)}`]) {
      let message = "";
      try {
        hash32(bad, "rootHash");
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/^rootHash must be 32 bytes/);
      expect(message).not.toContain(secretLooking);
    }
  });
});

describe("author key files", () => {
  const dir = mkdtempSync(join(tmpdir(), "orynq-author-key-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("createAuthorKeyFile writes a fresh random secret readable only by its owner and returns its public author key", () => {
    const path = join(dir, "author.key");
    const key = createAuthorKeyFile(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const secret = readAuthorSecret(path);
    expect(hex(authorKey(secret))).toBe(key);
    expect(readFileSync(path, "utf8")).toBe(`${hex(secret)}\n`);
    expect(createAuthorKeyFile(join(dir, "other.key"))).not.toBe(key);
  });

  it("createSaltKeyFile writes a fresh random salt key readable only by its owner and returns its public id, SHA-256(pad32(tag) ‖ key)", () => {
    const path = join(dir, "salt.key");
    const id = createSaltKeyFile(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const key = readAuthorSecret(path);
    expect(id).toBe(sha256(pad32("orynq:anchor-salt-key-id:v1"), key));
    expect(hex(saltKeyId(key))).toBe(id);
    expect(id).not.toBe(hex(authorKey(key)));
    expect(createSaltKeyFile(join(dir, "other-salt.key"))).not.toBe(id);
    expect(() => createSaltKeyFile(path)).toThrow(/salt\.key already exists/);
  });

  it("createAuthorKeyFile never replaces an existing file", () => {
    const path = join(dir, "existing.key");
    writeFileSync(path, "keep me\n", { mode: 0o600 });
    expect(() => createAuthorKeyFile(path)).toThrow(/existing\.key already exists/);
    expect(readFileSync(path, "utf8")).toBe("keep me\n");
  });

  it("readAuthorSecret refuses a file others can read, a symlink, and malformed content, without echoing it", () => {
    const secret = hex(random32());
    const open = join(dir, "group-readable.key");
    writeFileSync(open, `${secret}\n`, { mode: 0o600 });
    chmodSync(open, 0o640);
    const link = join(dir, "link.key");
    const target = join(dir, "target.key");
    writeFileSync(target, `${secret}\n`, { mode: 0o600 });
    symlinkSync(target, link);
    const short = join(dir, "short.key");
    writeFileSync(short, `${secret.slice(2)}\n`, { mode: 0o600 });
    const cases: Array<[string, RegExp]> = [
      [open, /group-readable\.key can be read or written by group or others/],
      [link, /link\.key is not a regular file/],
      [short, /short\.key must hold exactly 64 hex characters/],
    ];
    for (const [path, expected] of cases) {
      let message = "";
      try {
        readAuthorSecret(path);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(expected);
      expect(message).not.toContain(secret.slice(2, 18));
    }
  });
});
