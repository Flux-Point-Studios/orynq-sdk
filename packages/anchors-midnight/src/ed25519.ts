import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

// Ed25519 by Node's OpenSSL, which follows RFC 8032 strictly. Every signature it accepts,
// Substrate's ZIP-215 rules accept too; the converse can fail, which costs a verification and
// cannot admit a forgery.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function ed25519Verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: "der", type: "spki" });
  return verify(null, message, key, signature);
}

const privateKey = (seed: Uint8Array) => {
  if (seed.length !== 32) throw new Error("an Ed25519 seed must be 32 bytes");
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
};

export const ed25519PublicKey = (seed: Uint8Array): Uint8Array =>
  new Uint8Array(createPublicKey(privateKey(seed)).export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length));

export const ed25519Sign = (message: Uint8Array, seed: Uint8Array): Uint8Array => new Uint8Array(sign(null, message, privateKey(seed)));
