/**
 * Content-addressing utilities for storage.
 */

import { createHash } from "node:crypto";

/**
 * Hash domain prefixes for content-addressed storage.
 */
export const HASH_DOMAIN_PREFIXES = {
  chunk: "poi-storage:chunk:v1|",
  manifest: "poi-storage:manifest:v1|",
  data: "poi-storage:data:v1|",
} as const;

export type HashDomain = keyof typeof HASH_DOMAIN_PREFIXES;

/**
 * Compute SHA-256 hash with domain separation.
 */
export function sha256(data: Uint8Array, domain: HashDomain = "data"): string {
  const prefix = HASH_DOMAIN_PREFIXES[domain];
  const prefixBytes = new TextEncoder().encode(prefix);

  const combined = new Uint8Array(prefixBytes.length + data.length);
  combined.set(prefixBytes, 0);
  combined.set(data, prefixBytes.length);

  return createHash("sha256").update(combined).digest("hex");
}

/**
 * Compute SHA-256 hash without domain separation.
 */
export function sha256Raw(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Generate a content-addressed ID from data.
 */
export function contentId(data: Uint8Array): string {
  return sha256(data, "data");
}

/**
 * Validate that data matches a content hash.
 */
export function validateContentHash(
  data: Uint8Array,
  expectedHash: string,
  domain: HashDomain = "data"
): boolean {
  const actualHash = sha256(data, domain);
  return actualHash === expectedHash;
}

/**
 * Parse an IPFS CID from a URI.
 */
export function parseIpfsCid(uri: string): string | undefined {
  const match = uri.match(/ipfs:\/\/(\w+)/) ?? uri.match(/\/ipfs\/(\w+)/);
  return match?.[1];
}

/**
 * Parse an Arweave transaction ID from a URI.
 */
export function parseArweaveId(uri: string): string | undefined {
  const match = uri.match(/ar:\/\/(\w+)/) ?? uri.match(/arweave\.net\/(\w+)/);
  return match?.[1];
}

/**
 * Parse an S3 key from a URI.
 */
export function parseS3Key(uri: string): { bucket: string; key: string } | undefined {
  // s3://bucket/key/path
  const s3Match = uri.match(/s3:\/\/([^\/]+)\/(.+)/);
  if (s3Match) {
    const bucket = s3Match[1];
    const key = s3Match[2];
    if (bucket !== undefined && key !== undefined) {
      return { bucket, key };
    }
  }

  // https://bucket.s3.region.amazonaws.com/key
  const httpsMatch = uri.match(/https?:\/\/([^\.]+)\.s3\.[^\/]+\/(.+)/);
  if (httpsMatch) {
    const bucket = httpsMatch[1];
    const key = httpsMatch[2];
    if (bucket !== undefined && key !== undefined) {
      return { bucket, key };
    }
  }

  return undefined;
}

/**
 * Build a storage URI from components.
 */
export function buildStorageUri(
  type: "ipfs" | "s3" | "arweave" | "local",
  id: string,
  options?: { bucket?: string }
): string {
  switch (type) {
    case "ipfs":
      return `ipfs://${id}`;
    case "arweave":
      return `ar://${id}`;
    case "s3":
      if (options?.bucket) {
        return `s3://${options.bucket}/${id}`;
      }
      return `s3://${id}`;
    case "local":
      return `file://${id}`;
    default:
      return id;
  }
}
