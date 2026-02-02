/**
 * Compression utilities for flight recorder chunks.
 * Uses fflate for zstd-like compression (actually gzip/deflate, but fast).
 *
 * Note: True zstd would require native bindings. fflate provides
 * excellent pure-JS compression that works everywhere.
 */

import { gzip, gunzip, strToU8, strFromU8 } from "fflate";

export type CompressionType = "gzip" | "none";

export interface CompressionResult {
  data: Uint8Array;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  algorithm: CompressionType;
}

/**
 * Compress data using gzip.
 */
export function compress(data: Uint8Array, algorithm: CompressionType = "gzip"): Promise<CompressionResult> {
  return new Promise((resolve, reject) => {
    if (algorithm === "none") {
      resolve({
        data,
        originalSize: data.length,
        compressedSize: data.length,
        ratio: 1,
        algorithm: "none",
      });
      return;
    }

    gzip(data, { level: 6 }, (err, compressed) => {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        data: compressed,
        originalSize: data.length,
        compressedSize: compressed.length,
        ratio: compressed.length / data.length,
        algorithm: "gzip",
      });
    });
  });
}

/**
 * Decompress gzip data.
 */
export function decompress(data: Uint8Array, algorithm: CompressionType = "gzip"): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (algorithm === "none") {
      resolve(data);
      return;
    }

    gunzip(data, (err, decompressed) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(decompressed);
    });
  });
}

/**
 * Compress a string to bytes.
 */
export function compressString(str: string, algorithm: CompressionType = "gzip"): Promise<CompressionResult> {
  const data = strToU8(str);
  return compress(data, algorithm);
}

/**
 * Decompress bytes to a string.
 */
export async function decompressString(data: Uint8Array, algorithm: CompressionType = "gzip"): Promise<string> {
  const decompressed = await decompress(data, algorithm);
  return strFromU8(decompressed);
}

/**
 * Estimate if compression is worthwhile for the given data.
 * Returns true if data is likely compressible (text, JSON, etc).
 */
export function isCompressible(data: Uint8Array, sampleSize = 1024): boolean {
  // Sample the beginning of the data
  const sample = data.slice(0, Math.min(sampleSize, data.length));

  // Count unique bytes - highly compressible data has fewer unique values
  const uniqueBytes = new Set(sample);
  const uniqueRatio = uniqueBytes.size / sample.length;

  // If less than 60% unique bytes, likely compressible
  return uniqueRatio < 0.6;
}
