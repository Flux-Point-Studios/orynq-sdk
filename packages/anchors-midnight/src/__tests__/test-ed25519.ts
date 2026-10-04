import { createPrivateKey, createPublicKey, sign } from "node:crypto";

// Ed25519 signing for tests, from a 32-byte seed.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const privateKey = (seed: Uint8Array) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });

export const ed25519PublicKey = (seed: Uint8Array): Uint8Array =>
  new Uint8Array(createPublicKey(privateKey(seed)).export({ format: "der", type: "spki" }).subarray(12));

export const ed25519Sign = (message: Uint8Array, seed: Uint8Array): Uint8Array => new Uint8Array(sign(null, message, privateKey(seed)));
