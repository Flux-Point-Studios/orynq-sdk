/**
 * Encryption utilities for flight recorder chunks.
 * Uses Web Crypto API for AES-256-GCM encryption.
 */

import { webcrypto } from "node:crypto";

const crypto = webcrypto as unknown as Crypto;

export interface EncryptedData {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array; // For AES-GCM, tag is appended to ciphertext
}

export interface EncryptionKey {
  keyId: string;
  key: CryptoKey;
  algorithm: "aes-256-gcm" | "chacha20-poly1305";
  createdAt: string;
}

/**
 * Generate a new AES-256-GCM encryption key.
 */
export async function generateKey(algorithm: "aes-256-gcm" | "chacha20-poly1305" = "aes-256-gcm"): Promise<EncryptionKey> {
  if (algorithm === "chacha20-poly1305") {
    // ChaCha20-Poly1305 not directly supported in Web Crypto
    // Fall back to AES-GCM for now, can add libsodium later
    console.warn("ChaCha20-Poly1305 not supported, using AES-256-GCM");
    algorithm = "aes-256-gcm";
  }

  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable for export/wrapping
    ["encrypt", "decrypt"]
  );

  const keyId = generateKeyId();

  return {
    keyId,
    key,
    algorithm,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Generate a random key ID.
 */
function generateKeyId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a random nonce/IV for AES-GCM (12 bytes recommended).
 */
export function generateNonce(): Uint8Array {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  return nonce;
}

/**
 * Encrypt data using AES-256-GCM.
 */
export async function encrypt(
  data: Uint8Array,
  key: EncryptionKey,
  additionalData?: Uint8Array
): Promise<EncryptedData> {
  const nonce = generateNonce();

  const params: AesGcmParams = {
    name: "AES-GCM",
    iv: nonce as unknown as ArrayBuffer,
    tagLength: 128, // 16 bytes
  };
  if (additionalData) {
    params.additionalData = additionalData as unknown as ArrayBuffer;
  }

  const ciphertextWithTag = await crypto.subtle.encrypt(
    params,
    key.key,
    data as unknown as ArrayBuffer
  );

  const ciphertextWithTagArray = new Uint8Array(ciphertextWithTag);

  // AES-GCM appends the tag to the ciphertext
  // Split them for clarity in our data structure
  const tagStart = ciphertextWithTagArray.length - 16;
  const ciphertext = ciphertextWithTagArray.slice(0, tagStart);
  const tag = ciphertextWithTagArray.slice(tagStart);

  return {
    ciphertext,
    nonce,
    tag,
  };
}

/**
 * Decrypt data using AES-256-GCM.
 */
export async function decrypt(
  encrypted: EncryptedData,
  key: EncryptionKey,
  additionalData?: Uint8Array
): Promise<Uint8Array> {
  // Reconstruct ciphertext with tag appended
  const ciphertextWithTag = new Uint8Array(encrypted.ciphertext.length + encrypted.tag.length);
  ciphertextWithTag.set(encrypted.ciphertext, 0);
  ciphertextWithTag.set(encrypted.tag, encrypted.ciphertext.length);

  const decryptParams: AesGcmParams = {
    name: "AES-GCM",
    iv: encrypted.nonce as unknown as ArrayBuffer,
    tagLength: 128,
  };
  if (additionalData) {
    decryptParams.additionalData = additionalData as unknown as ArrayBuffer;
  }

  const plaintext = await crypto.subtle.decrypt(
    decryptParams,
    key.key,
    ciphertextWithTag as unknown as ArrayBuffer
  );

  return new Uint8Array(plaintext);
}

/**
 * Export key as raw bytes (for sealing/wrapping).
 */
export async function exportKey(key: EncryptionKey): Promise<Uint8Array> {
  const rawKey = await crypto.subtle.exportKey("raw", key.key);
  return new Uint8Array(rawKey);
}

/**
 * Import key from raw bytes.
 */
export async function importKey(
  rawKey: Uint8Array,
  keyId: string,
  algorithm: "aes-256-gcm" | "chacha20-poly1305" = "aes-256-gcm"
): Promise<EncryptionKey> {
  const key = await crypto.subtle.importKey(
    "raw",
    rawKey as unknown as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  return {
    keyId,
    key,
    algorithm,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Derive a key from a master key using HKDF-SHA256.
 */
export async function deriveKey(
  masterKey: Uint8Array,
  info: string,
  salt?: Uint8Array
): Promise<EncryptionKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    masterKey as unknown as ArrayBuffer,
    "HKDF",
    false,
    ["deriveKey"]
  );

  const saltBuffer = salt ?? new Uint8Array(32);
  const infoBuffer = new TextEncoder().encode(info);
  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: saltBuffer as unknown as ArrayBuffer,
      info: infoBuffer as unknown as ArrayBuffer,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  return {
    keyId: generateKeyId(),
    key: derivedKey,
    algorithm: "aes-256-gcm",
    createdAt: new Date().toISOString(),
  };
}
