import { createHash } from "node:crypto";
import { compareBytes, concatBytes } from "./bytes.js";
import { cborEncode } from "./cbor.js";
import { MandateError } from "./errors.js";
import { ZERO_ROOT_32 } from "./types.js";

export const ALLOWLIST_LEAF_DOMAIN = "orynq:conduct:allowlist:leaf:v1|";
export const ALLOWLIST_NODE_DOMAIN = "orynq:conduct:allowlist:node:v1|";

const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(data).digest());

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function allowlistLeaf(member: string): Uint8Array {
  if (typeof member !== "string" || member.length === 0 || member.length > 256 || !member.isWellFormed() || Buffer.byteLength(member, "utf8") > 256) {
    throw new MandateError(
      "SCHEMA_BAD_TYPE",
      "allowlist member must be a well-formed UTF-8 string of 1-256 bytes",
    );
  }
  return sha256(concatBytes(utf8(ALLOWLIST_LEAF_DOMAIN), cborEncode(member)));
}

export function buildAllowlistRoot(members: readonly string[]): Uint8Array {
  members = Array.from(members);
  if (members.length === 0) return new Uint8Array(ZERO_ROOT_32);
  let level = members
    .map(allowlistLeaf)
    .sort(compareBytes)
    .filter((leaf, i, all) => i === 0 || compareBytes(leaf, all[i - 1] as Uint8Array) !== 0);
  const nodeDomain = utf8(ALLOWLIST_NODE_DOMAIN);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      next.push(
        sha256(
          concatBytes(nodeDomain, level[i] as Uint8Array, level[i + 1] as Uint8Array),
        ),
      );
    }
    if (level.length % 2 === 1) {
      next.push(level[level.length - 1] as Uint8Array);
    }
    level = next;
  }
  return level[0] as Uint8Array;
}
