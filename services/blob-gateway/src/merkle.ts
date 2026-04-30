/**
 * Chunk-Merkle root computation — TypeScript port of the cert-daemon's
 * `daemon/merkle.py`. The on-chain receipt's `base_root_sha256` is computed
 * by every cert-daemon when it verifies an upload (see
 * `daemon/blob_verifier.py::verify` → `merkle_root(chunk_hashes)`), so any
 * server-side compute on the gateway side MUST produce a byte-identical
 * digest, otherwise the receipt-submitter's value will diverge and the
 * pallet rejects with `CertHashMismatch`.
 *
 * Algorithm (must match daemon/merkle.py exactly):
 *   - Empty input               → 32 zero bytes
 *   - Single leaf               → leaf returned as-is (NOT hashed again)
 *   - Multi-leaf binary tree    → at each level, if odd, duplicate the
 *                                 last leaf; pair up; sha256(left || right)
 *                                 with raw-byte concatenation; recurse
 *                                 until one node remains.
 *
 * NOTE on raw-byte concat: this matches `feedback_pallet_index_shift.md`
 * note about cert-daemon parity using "raw-byte Merkle concat" — i.e. we
 * concatenate the 32-byte digests directly, NOT their hex string forms.
 */
import { createHash } from "crypto";

/** SHA-256 of a buffer, returning the 32-byte digest. */
export function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Compute the Merkle root over a list of leaf hashes (each 32 bytes).
 *
 * Mirrors `daemon/merkle.py::merkle_root` byte-for-byte.
 */
export function merkleRoot(leafHashes: Buffer[]): Buffer {
  if (leafHashes.length === 0) {
    return Buffer.alloc(32, 0);
  }
  if (leafHashes.length === 1) {
    // Single-chunk case: the leaf IS the root. Do NOT re-hash.
    return leafHashes[0];
  }

  let nodes = leafHashes.slice();
  while (nodes.length > 1) {
    if (nodes.length % 2 === 1) {
      nodes.push(nodes[nodes.length - 1]);
    }
    const next: Buffer[] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      next.push(sha256(Buffer.concat([nodes[i], nodes[i + 1]])));
    }
    nodes = next;
  }
  return nodes[0];
}

/** Regex for a 64-char hex string (no prefix). */
const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

/** True iff `s` is a 64-character hex string with no `0x` prefix. */
export function isHex64(s: unknown): boolean {
  return typeof s === "string" && HEX_64_RE.test(s);
}

/**
 * Strip a leading `0x` (case-insensitive) from a hex string. Pass-through if
 * no prefix is present.
 */
export function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** True iff `s` is a 64-character hex string optionally with a `0x` prefix. */
export function isValidRootHash(s: unknown): s is string {
  if (typeof s !== "string") return false;
  return isHex64(stripHexPrefix(s));
}

/**
 * Compute the chunk-Merkle root for a manifest's chunks list. Each chunk's
 * `sha256` field is interpreted as 64 hex characters (with optional `0x`
 * prefix) representing the 32-byte SHA-256 of that chunk's bytes.
 *
 * Returns a 64-char lowercase hex string, no prefix — the same shape that
 * `manifest.rootHash` uses elsewhere in the gateway (so it can be dropped
 * directly into the sponsored-receipt-submitter callback payload).
 *
 * Throws if any chunk's `sha256` is missing or not a 64-hex string — this
 * is a structural error from the client; we'd rather surface it loudly than
 * silently submit a garbage root.
 */
export function computeRootHashFromChunks(
  chunks: ReadonlyArray<{ sha256?: string; index?: number }>,
): string {
  const leaves: Buffer[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const c = chunks[i];
    const raw = c?.sha256;
    if (typeof raw !== "string") {
      throw new Error(
        `chunk ${c?.index ?? i} missing sha256 — cannot compute rootHash`,
      );
    }
    const hex = stripHexPrefix(raw);
    if (!isHex64(hex)) {
      throw new Error(
        `chunk ${c?.index ?? i} sha256 is not 64-hex (got length ${hex.length})`,
      );
    }
    leaves.push(Buffer.from(hex, "hex"));
  }
  return merkleRoot(leaves).toString("hex");
}
