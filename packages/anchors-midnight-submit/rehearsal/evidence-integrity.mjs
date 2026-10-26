import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (reason) => { throw new Error(`verify package integrity: ${reason}`); };
const utf8 = (bytes) => {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes)) fail("invalid UTF-8 path");
  return value;
};
const field = (header, start, width) => utf8(header.subarray(start, start + width).subarray(0, header.subarray(start, start + width).indexOf(0) < 0 ? width : header.subarray(start, start + width).indexOf(0)));
const octal = (value) => {
  const text = value.replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(text)) fail("invalid tar integer");
  const n = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(n)) fail("tar integer overflow");
  return n;
};
const relative = (name) => {
  if (!name.startsWith("package/") || /[\\\x00-\x1f\x7f]/.test(name)) fail("non-package tar path");
  const path = name.slice(8).replace(/\/$/, "");
  if (!path || path.split("/").some(part => !part || part === "." || part === "..")) fail("unsafe tar path");
  return path;
};

// Parse only npm's ordinary files/directories and POSIX extended paths. Links, devices,
// traversal, duplicates, bad checksums, truncation and oversized archives fail closed.
export function packedFiles(tarball) {
  let tar;
  try { tar = gunzipSync(tarball, { maxOutputLength: 128 << 20 }); }
  catch { fail("unreadable or oversized gzip archive"); }
  const files = new Map();
  let at = 0, nextPath;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512); at += 512;
    if (header.every(byte => byte === 0)) {
      if (!tar.subarray(at).every(byte => byte === 0)) fail("data after tar terminator");
      if (!files.has("package.json")) fail("archive holds no package.json");
      return files;
    }
    const checksum = octal(field(header, 148, 8));
    const sum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (sum !== checksum) fail("bad tar checksum");
    const size = octal(field(header, 124, 12));
    if (at + size > tar.length) fail("truncated tar entry");
    const body = tar.subarray(at, at + size); at += Math.ceil(size / 512) * 512;
    const type = field(header, 156, 1);
    const name = nextPath ?? [field(header, 345, 155), field(header, 0, 100)].filter(Boolean).join("/");
    nextPath = undefined;
    if (type === "x") {
      let offset = 0;
      while (offset < body.length) {
        const space = body.indexOf(32, offset);
        const decimal = body.subarray(offset, space).toString("ascii");
        if (!/^[1-9][0-9]*$/.test(decimal)) fail("invalid extended tar length");
        const length = Number(decimal);
        if (space < offset || !Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > body.length || body[offset + length - 1] !== 10) fail("invalid extended tar header");
        const record = utf8(body.subarray(space + 1, offset + length - 1));
        const equal = record.indexOf("=");
        if (equal < 1) fail("invalid extended tar field");
        if (record.slice(0, equal) === "path") {
          if (nextPath !== undefined) fail("duplicate extended path");
          nextPath = record.slice(equal + 1);
        }
        offset += length;
      }
      continue;
    }
    if (name === "package" || name === "package/") { if (type !== "5") fail("invalid package root"); continue; }
    const path = relative(name);
    if (type === "5") continue;
    if (type !== "" && type !== "0") fail("unsupported tar entry type");
    if (files.has(path)) fail("duplicate tar file");
    files.set(path, Buffer.from(body));
  }
  return fail("missing tar terminator");
}

const treeIdentity = (files) => ({ files: files.size, sha256: hash(JSON.stringify([...files].map(([name, bytes]) => [name, hash(bytes)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) });
export const packedTreeIdentity = (tarball) => treeIdentity(packedFiles(tarball));

export function packageTreeIdentity(tarball, directory) {
  const expected = packedFiles(tarball);
  const actual = new Map();
  const walk = (at, prefix = "") => {
    for (const entry of readdirSync(at)) {
      const path = prefix + entry;
      const file = join(at, entry), stat = lstatSync(file);
      if (stat.isSymbolicLink()) fail("installed symlink");
      if (stat.isDirectory()) walk(file, `${path}/`);
      else if (stat.isFile()) actual.set(path, readFileSync(file));
      else fail("installed non-file entry");
    }
  };
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) fail("installed package root is not a directory");
  walk(directory);
  if (actual.size !== expected.size) fail("installed file set differs from tarball");
  for (const [name, bytes] of expected) if (!actual.get(name)?.equals(bytes)) fail(`installed file differs from tarball: ${name}`);
  return treeIdentity(expected);
}
