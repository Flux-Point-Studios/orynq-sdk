/**
 * Shared hex string utilities.
 *
 * IMPORTANT: Do NOT use regex like /^(sha256:)?0x?/ — the optional `x`
 * strips leading zeros from hashes starting with '0'. See commit 4b4f3be.
 */

const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Remove any "sha256:" or "0x" prefix and return raw hex chars.
 */
export function stripPrefix(s: string): string {
  if (s.startsWith("sha256:")) s = s.slice(7);
  if (s.startsWith("0x") || s.startsWith("0X")) return s.slice(2);
  return s;
}

/**
 * Ensure the string has a "0x" prefix.
 */
export function ensureHex(s: string): string {
  if (s.startsWith("sha256:")) s = s.slice(7);
  if (s.startsWith("0x") || s.startsWith("0X")) return s;
  return "0x" + s;
}

/**
 * Returns the 32-byte zero hash (0x00...00, 66 chars).
 */
export function zeroHash(): string {
  return ZERO_HASH;
}

/**
 * Check if a hash is all zeros.
 */
export function isZeroHash(h: string): boolean {
  return stripPrefix(h).replace(/0/g, "").length === 0;
}

/**
 * Assert the input is exactly 32 bytes (64 hex chars), 0x-prefix optional.
 * Throws on short/long/non-hex input. Use at SDK entry points to surface
 * caller errors immediately rather than letting `toBytes32` silently pad
 * or truncate (which produces a different on-chain value than intended).
 *
 * @param value the hex string to validate
 * @param fieldName name used in the error message
 * @returns the validated raw hex (no prefix), lower-case
 */
export function assertHex32(value: string, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(
      `${fieldName} must be a hex string (32 bytes / 64 chars); got ${typeof value}`,
    );
  }
  const bare = stripPrefix(value);
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) {
    throw new Error(
      `${fieldName} must be exactly 32 hex bytes (64 chars); got ${bare.length} chars`,
    );
  }
  return bare.toLowerCase();
}
