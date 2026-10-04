import { createPublicKey, verify } from "node:crypto";

// Ed25519 verification by Node's OpenSSL, which follows RFC 8032 strictly. Every signature it
// accepts, Substrate's ZIP-215 rules accept too; the converse can fail, which costs a
// verification and cannot admit a forgery.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function ed25519Verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: "der", type: "spki" });
  return verify(null, message, key, signature);
}
