import { bytesToHex } from "@fluxpointstudios/orynq-sdk-core/utils";
import { sha256 } from "@noble/hashes/sha256";

const utf8 = new TextEncoder();

/**
 * SHA-256 of `text` as UTF-8, in lowercase hex. Synchronous: a trace hashes
 * once per event, span and tree node, and verifiers rehash fetched documents
 * of attacker-chosen size, where an asynchronous Web Crypto digest costs many
 * times the hash itself.
 */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8.encode(text)));
}
