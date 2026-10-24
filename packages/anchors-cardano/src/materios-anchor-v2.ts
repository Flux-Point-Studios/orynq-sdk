/**
 * @fileoverview Materios→Cardano L1 anchor metadata (v2): builder and decoder.
 *
 * Logical record (metadata label 8746):
 *   {
 *     "p": "materios",
 *     "v": 2,
 *     "chain": "<materios_genesis_hash_hex_no_0x, as labelled>",
 *     "blocks": [<from>, <to>],
 *     "leaves": <count>,
 *     "root": "<rootHash_hex_no_0x>",
 *     "manifest": "<manifestHash_hex_no_0x>"
 *   }
 *
 * Two encodings of it are on Cardano mainnet:
 * - detailed-schema: anchor-worker-materios builds the record as CSL
 *   detailed-schema JSON and passes it to `add_json_metadatum`, which stores
 *   that JSON literally (NoConversions). The label's value is a map with the
 *   single key "map" holding `[{k: {string: name}, v: {string|int|list}}]`.
 *   Every checkpoint anchor the live cert-daemon path writes has this form.
 * - flat: a second, Lucid-based worker attached the record above as plain
 *   metadata from 2026-04-18 to 2026-06-29, so the label's value is the
 *   seven-field map itself.
 *
 * Label 8746 is Materios-specific — reserved for partner-chain checkpoint
 * anchors coming through cert-daemon + anchor-worker-materios. Distinct from
 * label 2222 (`POI_METADATA_LABEL`) used by direct Orynq→Cardano POI anchors
 * via `anchor_cardano_submit`. Other records share the label (an anchor wallet
 * has written a `v: 3` finality record), so a reader must check `p` and `v`.
 *
 * `chain` is a label: the worker writes the genesis it was told, which in two
 * windows of genuine anchors is not the genesis their root and manifest commit
 * to (the package README lists them). A genesis is checked by recomputing the
 * manifest hash, as verifyMateriosCheckpointAnchor does.
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
 * Build a Materios anchor v2 metadata object in the flat encoding, suitable
 * for `attachMetadata(8746, ...)`.
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

/** The encoding a label-8746 record was written in (see the file overview). */
export type MateriosAnchorEncoding = "detailed-schema" | "flat";

export type MateriosAnchorDecoding =
  | { ok: true; encoding: MateriosAnchorEncoding; record: MateriosAnchorV2Metadata }
  | { ok: false; reason: string };

const RECORD_FIELDS = ["p", "v", "chain", "root", "manifest", "blocks", "leaves"];
const HASH_FIELDS = ["chain", "root", "manifest"] as const;
const HEX32 = /^[0-9a-f]{64}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A detailed-schema value as its plain value: a single-key object naming its type. */
function detailedValue(value: unknown): unknown {
  if (!isObject(value) || Object.keys(value).length !== 1) return undefined;
  if (typeof value.string === "string") return value.string;
  if (typeof value.int === "number") return value.int;
  if (!Array.isArray(value.list)) return undefined;
  const items = value.list.map(detailedValue);
  return items.includes(undefined) ? undefined : items;
}

/**
 * The record's fields: unwrapped from a detailed-schema map, whose every key
 * and value must be detailed-schema, or as a flat record holds them.
 */
function recordFields(value: Record<string, unknown>): { encoding: MateriosAnchorEncoding; fields: Map<string, unknown> } | string {
  const fields = new Map<string, unknown>();
  if (Object.keys(value).length !== 1 || !Array.isArray(value.map)) {
    for (const [key, field] of Object.entries(value)) fields.set(key, field);
    return { encoding: "flat", fields };
  }
  for (const entry of value.map) {
    if (!isObject(entry) || Object.keys(entry).sort().join() !== "k,v") return "a detailed-schema map entry is not {k, v}";
    const key = isObject(entry.k) && Object.keys(entry.k).length === 1 ? entry.k.string : undefined;
    if (typeof key !== "string") return "a detailed-schema map key is not a {string} value";
    if (fields.has(key)) return `field ${JSON.stringify(key)} appears twice`;
    const plain = detailedValue(entry.v);
    if (plain === undefined) return `field ${JSON.stringify(key)} is not a detailed-schema value, as every value in a detailed-schema map must be`;
    fields.set(key, plain);
  }
  return { encoding: "detailed-schema", fields };
}

const isCount = (value: unknown, minimum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum;

/**
 * Decode a label-8746 value, as Koios renders transaction metadata in JSON,
 * into a Materios checkpoint anchor record. Both encodings decode to the same
 * record; a record mixing them, any other `p`/`v` (such as the `v: 3`
 * finality record), and any missing, extra, duplicated or malformed field
 * are refused with the reason.
 */
export function decodeMateriosAnchorRecord(value: unknown): MateriosAnchorDecoding {
  if (!isObject(value)) return { ok: false, reason: "the label 8746 value is not an object" };
  const decoded = recordFields(value);
  if (typeof decoded === "string") return { ok: false, reason: decoded };
  const { encoding, fields } = decoded;
  const p = fields.get("p");
  const v = fields.get("v");
  if (p !== MATERIOS_ANCHOR_PROTOCOL || v !== MATERIOS_ANCHOR_VERSION) {
    return { ok: false, reason: `p ${JSON.stringify(p)}, v ${JSON.stringify(v)} is not a Materios checkpoint anchor, which is p "materios", v 2` };
  }
  for (const key of fields.keys()) if (!RECORD_FIELDS.includes(key)) return { ok: false, reason: `unexpected field ${JSON.stringify(key)}` };
  for (const key of RECORD_FIELDS) if (!fields.has(key)) return { ok: false, reason: `missing field ${key}` };
  if (encoding === "flat") {
    for (const [key, field] of fields) if (detailedValue(field) !== undefined) return { ok: false, reason: `field ${key} holds a detailed-schema value inside a flat record` };
  }
  for (const key of HASH_FIELDS) {
    const hash = fields.get(key);
    if (typeof hash !== "string" || !HEX32.test(hash)) return { ok: false, reason: `field ${key} is not 64 lowercase hex characters` };
  }
  const blocks = fields.get("blocks");
  if (!Array.isArray(blocks) || blocks.length !== 2 || !isCount(blocks[0], 0) || !isCount(blocks[1], blocks[0])) {
    return { ok: false, reason: "field blocks is not [from, to] with Materios block numbers from <= to" };
  }
  const leaves = fields.get("leaves");
  if (!isCount(leaves, 1)) return { ok: false, reason: "field leaves is not a positive integer" };
  return {
    ok: true,
    encoding,
    record: {
      p, v,
      chain: fields.get("chain") as string,
      blocks: [blocks[0], blocks[1]],
      leaves,
      root: fields.get("root") as string,
      manifest: fields.get("manifest") as string,
    },
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
