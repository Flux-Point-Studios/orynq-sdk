/**
 * @summary Unit tests for ViemSigner implementation.
 *
 * Tests cover:
 * - Constructor with privateKey
 * - Constructor with account
 * - getAddress() returning correct address
 * - sign() returning signature as Uint8Array
 * - signMessage() returning hex signature
 * - getAccount() returning the account
 * - supportsTypedData() checking signTypedData support
 */

import { describe, it, expect, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { ViemSigner } from "../signers/viem-signer.js";

// Test private key (DO NOT USE IN PRODUCTION - this is a well-known test key)
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// ---------------------------------------------------------------------------
// Constructor Tests
// ---------------------------------------------------------------------------

describe("ViemSigner constructor", () => {
  it("should accept privateKey", () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    expect(signer).toBeDefined();
  });

  it("should accept account", () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const signer = new ViemSigner({ account });
    expect(signer).toBeDefined();
  });

  it("should throw without privateKey or account", () => {
    expect(() => new ViemSigner({} as any)).toThrow(
      "ViemSigner requires either privateKey or account"
    );
  });

  it("should derive account from privateKey", async () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    const address = await signer.getAddress("eip155:8453");
    expect(address).toBe(TEST_ADDRESS);
  });
});

// ---------------------------------------------------------------------------
// getAddress() Tests
// ---------------------------------------------------------------------------

describe("ViemSigner.getAddress()", () => {
  it("should return correct address", async () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    const address = await signer.getAddress("eip155:8453");
    expect(address).toBe(TEST_ADDRESS);
  });

  it("should return same address for different chains", async () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    const address1 = await signer.getAddress("eip155:8453");
    const address2 = await signer.getAddress("eip155:1");
    expect(address1).toBe(address2);
  });

  it("should return checksummed address", async () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    const address = await signer.getAddress("eip155:8453");
    // Checksummed addresses have mixed case
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(address).not.toBe(address.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// sign() Tests
// ---------------------------------------------------------------------------

describe("ViemSigner.sign()", () => {
  it("should return signature as Uint8Array", async () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    const payload = new TextEncoder().encode("test message");
    const signature = await signer.sign(payload, "eip155:8453");

    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBeGreaterThan(0);
  });

  it("should produce consistent signatures for same input", async () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    const payload = new TextEncoder().encode("test message");

    // Note: Ethereum signatures include a recovery parameter which can vary
    // but the core signature should be deterministic for secp256k1
    const sig1 = await signer.sign(payload, "eip155:8453");
    const sig2 = await signer.sign(payload, "eip155:8453");

    expect(sig1).toEqual(sig2);
  });
});

// ---------------------------------------------------------------------------
// signMessage() Tests
// ---------------------------------------------------------------------------

describe("ViemSigner.signMessage()", () => {
  it("should return hex signature", async () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    const signature = await signer.signMessage("Hello, World!", "eip155:8453");

    expect(signature).toMatch(/^0x[0-9a-fA-F]+$/);
    // Ethereum signatures are 65 bytes (130 hex chars + 0x prefix)
    expect(signature.length).toBe(132);
  });

  it("should produce different signatures for different messages", async () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    const sig1 = await signer.signMessage("Message 1", "eip155:8453");
    const sig2 = await signer.signMessage("Message 2", "eip155:8453");

    expect(sig1).not.toBe(sig2);
  });

  it("should produce consistent signatures for same message", async () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    const sig1 = await signer.signMessage("Same message", "eip155:8453");
    const sig2 = await signer.signMessage("Same message", "eip155:8453");

    expect(sig1).toBe(sig2);
  });
});

// ---------------------------------------------------------------------------
// getAccount() Tests
// ---------------------------------------------------------------------------

describe("ViemSigner.getAccount()", () => {
  it("should return the account", () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    const account = signer.getAccount();

    expect(account).toBeDefined();
    expect(account.address).toBe(TEST_ADDRESS);
  });

  it("should return same account when initialized with account", () => {
    const originalAccount = privateKeyToAccount(TEST_PRIVATE_KEY);
    const signer = new ViemSigner({ account: originalAccount });
    const returnedAccount = signer.getAccount();

    expect(returnedAccount).toBe(originalAccount);
  });

  it("should return account with signTypedData", () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    const account = signer.getAccount();

    expect(typeof account.signTypedData).toBe("function");
  });

  it("should return account with signMessage", () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    const account = signer.getAccount();

    expect(typeof account.signMessage).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// supportsTypedData() Tests
// ---------------------------------------------------------------------------

describe("ViemSigner.supportsTypedData()", () => {
  it("should return true for signing accounts", () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    expect(signer.supportsTypedData()).toBe(true);
  });

  it("should return true for account initialized signer", () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const signer = new ViemSigner({ account });
    expect(signer.supportsTypedData()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EIP-712 Signing Tests
// ---------------------------------------------------------------------------

describe("ViemSigner EIP-712 signing", () => {
  it("should sign typed data via account.signTypedData", async () => {
    const signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });
    const account = signer.getAccount();

    const domain = {
      name: "Test",
      version: "1",
      chainId: BigInt(8453),
      verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
    };

    const types = {
      Message: [{ name: "content", type: "string" }],
    };

    const message = {
      content: "Hello, World!",
    };

    expect(account.signTypedData).toBeDefined();

    const signature = await account.signTypedData!({
      domain,
      types,
      primaryType: "Message" as const,
      message,
    });

    expect(signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });
});
