/**
 * @fileoverview Materios→Cardano L1 anchor metadata builder (v2).
 *
 * Schema (metadata label 8746):
 *   {
 *     "p": "materios",
 *     "v": 2,
 *     "chain": "<materios_genesis_hash_hex_no_0x>",
 *     "blocks": [<from>, <to>],
 *     "leaves": <count>,
 *     "root": "<rootHash_hex_no_0x>",
 *     "manifest": "<manifestHash_hex_no_0x>"
 *   }
 *
 * Label 8746 is Materios-specific — reserved for partner-chain checkpoint
 * anchors coming through cert-daemon + anchor-worker-materios. Distinct from
 * label 2222 (`POI_METADATA_LABEL`) used by direct Orynq→Cardano POI anchors
 * via `anchor_cardano_submit`.
 *
 * All hash fields are 64-char lowercase hex with no `0x` prefix, so they
 * fit Cardano's 64-byte metadata string limit without chunking.
 *
 * @example
 * ```ts
 * import { buildMateriosAnchorV2, MATERIOS_ANCHOR_LABEL } from "@fluxpointstudios/orynq-sdk-anchors-cardano";
 *
 * const metadata = buildMateriosAnchorV2({
 *   chain: "dd7cce74...",
 *   blocks: [59, 59],
 *   leaves: 1,
 *   root: "19e4d694...",
 *   manifest: "edad38a9...",
 * });
 * tx.attachMetadata(MATERIOS_ANCHOR_LABEL, metadata);
 * ```
 */

/** Cardano metadata label for Materios checkpoint anchors. */
export const MATERIOS_ANCHOR_LABEL = 8746;

/** Protocol tag that identifies Materios anchors within label 8746 space. */
export const MATERIOS_ANCHOR_PROTOCOL = "materios";

/** Schema version for Materios anchor metadata. */
export const MATERIOS_ANCHOR_VERSION = 2;

/** Input fields for the v2 Materios anchor metadata builder. */
export interface MateriosAnchorV2Input {
  /** Materios chain genesis hash, hex (no `0x` prefix) — 64 chars. */
  chain: string;
  /** Inclusive partner-chain block range covered by this checkpoint. */
  blocks: [from: number, to: number];
  /** Number of certified receipts rolled into this batch. */
  leaves: number;
  /** Merkle root of the batch, hex (no `0x` prefix) — 64 chars. */
  root: string;
  /** Manifest hash of the batch, hex (no `0x` prefix) — 64 chars. */
  manifest: string;
}

/** Output shape matching the on-chain metadata. */
export interface MateriosAnchorV2Metadata {
  p: typeof MATERIOS_ANCHOR_PROTOCOL;
  v: typeof MATERIOS_ANCHOR_VERSION;
  chain: string;
  blocks: [number, number];
  leaves: number;
  root: string;
  manifest: string;
}

const stripHexPrefix = (h: string | undefined | null): string =>
  typeof h === "string" && h.startsWith("0x") ? h.slice(2) : h ?? "";

/**
 * Build a Materios anchor v2 metadata object suitable for `attachMetadata(8746, ...)`.
 *
 * Accepts hex inputs with or without `0x` prefix; normalises to lowercase hex
 * without the prefix so strings fit Cardano's 64-byte metadata string limit.
 */
export function buildMateriosAnchorV2(
  input: MateriosAnchorV2Input,
): MateriosAnchorV2Metadata {
  return {
    p: MATERIOS_ANCHOR_PROTOCOL,
    v: MATERIOS_ANCHOR_VERSION,
    chain: stripHexPrefix(input.chain).toLowerCase(),
    blocks: [input.blocks[0], input.blocks[1]],
    leaves: input.leaves,
    root: stripHexPrefix(input.root).toLowerCase(),
    manifest: stripHexPrefix(input.manifest).toLowerCase(),
  };
}

/**
 * BIP39 phrase detector — refuses 12/15/18/21/24 lowercase ASCII words of
 * 3–8 chars each. Used by anchor-worker-materios to reject payloads before
 * signing so validator mnemonics can never land in Cardano metadata.
 *
 * False positives are cheap (caller re-submits with corrected payload); false
 * negatives are permanent on-chain exposure.
 *
 * @example
 * ```ts
 * if (looksLikeBip39(submitter)) throw new Error("refusing to anchor seed phrase");
 * ```
 */
export function looksLikeBip39(s: unknown): boolean {
  if (typeof s !== "string") return false;
  const parts = s.trim().split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(parts.length)) return false;
  return parts.every((w) => /^[a-z]{3,8}$/.test(w));
}

/**
 * Recursively scans any JSON-ish value for BIP39-shaped strings. Returns the
 * JSONPath of the first match, or `null` if none found. Use this on the full
 * incoming request body before passing anything into CBOR.
 */
export function scanForSeedPhrase(v: unknown, path = "$"): string | null {
  if (typeof v === "string") {
    return looksLikeBip39(v) ? path : null;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = scanForSeedPhrase(v[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const hit = scanForSeedPhrase(val, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}
