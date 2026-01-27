/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-node/src/__tests__/memory-signer.test.ts
 * @summary Unit tests for MemorySigner implementation.
 *
 * Tests the in-memory signer with cardano-serialization-lib.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MemorySigner } from "../signers/memory-signer.js";

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

// A valid 32-byte Ed25519 private key (64 hex chars)
// This is a TEST key - never use in production
const TEST_PRIVATE_KEY_32 =
  "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

// A valid 64-byte extended Ed25519 private key (128 hex chars)
const TEST_PRIVATE_KEY_64 = TEST_PRIVATE_KEY_32 + TEST_PRIVATE_KEY_32;

// ---------------------------------------------------------------------------
// Constructor Tests
// ---------------------------------------------------------------------------

describe("MemorySigner constructor", () => {
  beforeEach(() => {
    // Reset warning flag before each test
    MemorySigner.resetWarning();
  });

  it("accepts valid 32-byte private key", () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_32);
    expect(signer.getPrivateKeyHex()).toBe(TEST_PRIVATE_KEY_32);
  });

  it("accepts valid 64-byte extended private key", () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_64);
    expect(signer.getPrivateKeyHex()).toBe(TEST_PRIVATE_KEY_64);
  });

  it("rejects non-hex private key", () => {
    expect(() => new MemorySigner("not-hex-at-all")).toThrow(
      /must be hex-encoded/
    );
    expect(() => new MemorySigner("ghijklmnopqrstuv".repeat(4))).toThrow(
      /must be hex-encoded/
    );
  });

  it("rejects wrong length private key", () => {
    expect(() => new MemorySigner("abcd1234")).toThrow(
      /expected 64 or 128 hex characters/
    );
    expect(() => new MemorySigner("ab".repeat(100))).toThrow(
      /expected 64 or 128 hex characters/
    );
  });
});

// ---------------------------------------------------------------------------
// getAddress Tests
// ---------------------------------------------------------------------------

describe("MemorySigner.getAddress", () => {
  it("returns a mainnet address for cardano:mainnet", async () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_32);
    const address = await signer.getAddress("cardano:mainnet");

    // Mainnet addresses start with "addr1"
    expect(address).toMatch(/^addr1/);
  });

  it("returns a testnet address for cardano:preprod", async () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_32);
    const address = await signer.getAddress("cardano:preprod");

    // Testnet addresses start with "addr_test1"
    expect(address).toMatch(/^addr_test1/);
  });

  it("returns consistent address for same key", async () => {
    const signer1 = new MemorySigner(TEST_PRIVATE_KEY_32);
    const signer2 = new MemorySigner(TEST_PRIVATE_KEY_32);

    const address1 = await signer1.getAddress("cardano:mainnet");
    const address2 = await signer2.getAddress("cardano:mainnet");

    expect(address1).toBe(address2);
  });

  it("returns different addresses for different keys", async () => {
    const signer1 = new MemorySigner(TEST_PRIVATE_KEY_32);
    const signer2 = new MemorySigner(
      "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321"
    );

    const address1 = await signer1.getAddress("cardano:mainnet");
    const address2 = await signer2.getAddress("cardano:mainnet");

    expect(address1).not.toBe(address2);
  });

  it("throws for non-Cardano chains", async () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_32);

    await expect(signer.getAddress("eip155:1")).rejects.toThrow(
      /only supports Cardano chains/
    );
  });
});

// ---------------------------------------------------------------------------
// sign Tests
// ---------------------------------------------------------------------------

describe("MemorySigner.sign", () => {
  it("returns a 64-byte signature", async () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_32);
    const payload = new Uint8Array(32).fill(0xab);

    const signature = await signer.sign(payload, "cardano:mainnet");

    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64);
  });

  it("produces consistent signatures for same payload", async () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_32);
    const payload = new Uint8Array(32).fill(0xcd);

    const sig1 = await signer.sign(payload, "cardano:mainnet");
    const sig2 = await signer.sign(payload, "cardano:mainnet");

    expect(Buffer.from(sig1).toString("hex")).toBe(
      Buffer.from(sig2).toString("hex")
    );
  });

  it("produces different signatures for different payloads", async () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_32);
    const payload1 = new Uint8Array(32).fill(0x11);
    const payload2 = new Uint8Array(32).fill(0x22);

    const sig1 = await signer.sign(payload1, "cardano:mainnet");
    const sig2 = await signer.sign(payload2, "cardano:mainnet");

    expect(Buffer.from(sig1).toString("hex")).not.toBe(
      Buffer.from(sig2).toString("hex")
    );
  });

  it("throws for empty payload", async () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_32);

    await expect(
      signer.sign(new Uint8Array(0), "cardano:mainnet")
    ).rejects.toThrow(/empty payload/);
  });

  it("throws for non-Cardano chains", async () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_32);
    const payload = new Uint8Array(32);

    await expect(signer.sign(payload, "eip155:1")).rejects.toThrow(
      /only supports Cardano chains/
    );
  });
});

// ---------------------------------------------------------------------------
// signTx Tests
// ---------------------------------------------------------------------------

describe("MemorySigner.signTx", () => {
  it("returns a vkey witness CBOR hex", async () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_32);
    const txBodyHash = new Uint8Array(32).fill(0x55);

    const witnessHex = await signer.signTx(txBodyHash, "cardano:mainnet");

    expect(typeof witnessHex).toBe("string");
    expect(witnessHex).toMatch(/^[0-9a-f]+$/i);
  });

  it("throws for wrong hash length", async () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_32);
    const wrongHash = new Uint8Array(16); // Should be 32

    await expect(signer.signTx(wrongHash, "cardano:mainnet")).rejects.toThrow(
      /expected 32 bytes/
    );
  });
});

// ---------------------------------------------------------------------------
// getPublicKeyHash Tests
// ---------------------------------------------------------------------------

describe("MemorySigner.getPublicKeyHash", () => {
  it("returns a 28-byte key hash as hex", async () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_32);

    const keyHash = await signer.getPublicKeyHash("cardano:mainnet");

    expect(typeof keyHash).toBe("string");
    expect(keyHash).toMatch(/^[0-9a-f]{56}$/i); // 28 bytes = 56 hex chars
  });

  it("returns consistent key hash", async () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_32);

    const hash1 = await signer.getPublicKeyHash("cardano:mainnet");
    const hash2 = await signer.getPublicKeyHash("cardano:preprod");

    // Key hash should be the same regardless of network
    expect(hash1).toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// signMessage Tests
// ---------------------------------------------------------------------------

describe("MemorySigner.signMessage", () => {
  it("throws not implemented error", async () => {
    const signer = new MemorySigner(TEST_PRIVATE_KEY_32);

    await expect(
      signer.signMessage("Hello, Cardano!", "cardano:mainnet")
    ).rejects.toThrow(/not implemented/i);
  });
});
