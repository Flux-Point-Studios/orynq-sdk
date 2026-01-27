/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/server-middleware/src/verifiers/__tests__/cardano.test.ts
 * @summary Unit tests for Cardano payment verifier.
 *
 * Tests cover:
 * - Transaction hash validation
 * - Blockfrost API integration (mocked)
 * - Koios API integration (mocked)
 * - ADA (lovelace) verification
 * - Native token verification
 * - Confirmation depth checking
 * - Error handling scenarios
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CardanoVerifier } from "../cardano.js";
import type { CardanoTxHashProof, CardanoSignedCborProof } from "@poi-sdk/core";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("CardanoVerifier", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should create verifier with default config", () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
      });

      expect(verifier.supportedChains).toEqual(["cardano:mainnet"]);
    });

    it("should support preprod network", () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        network: "preprod",
      });

      expect(verifier.supportedChains).toEqual(["cardano:preprod"]);
    });

    it("should support preview network", () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        network: "preview",
      });

      expect(verifier.supportedChains).toEqual(["cardano:preview"]);
    });

    it("should support Koios provider", () => {
      const verifier = new CardanoVerifier({
        provider: "koios",
        network: "mainnet",
      });

      expect(verifier.supportedChains).toEqual(["cardano:mainnet"]);
    });
  });

  describe("verify - proof validation", () => {
    it("should reject unsupported proof kind", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
      });

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: "0x123" } as any,
        BigInt("1000000"),
        "addr1test",
        "cardano:mainnet"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("Unsupported proof kind");
    });

    it("should reject unsupported chain", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        network: "mainnet",
      });

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: "a".repeat(64) },
        BigInt("1000000"),
        "addr1test",
        "cardano:preprod"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("not supported");
    });

    it("should reject invalid transaction hash format", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
      });

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: "invalid-hash" },
        BigInt("1000000"),
        "addr1test",
        "cardano:mainnet"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("Invalid transaction hash format");
    });

    it("should accept valid 64-character hex hash", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        retryAttempts: 1,
      });

      // Mock API to return 404 for all retry attempts
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: "a".repeat(64) },
        BigInt("1000000"),
        "addr1test",
        "cardano:mainnet"
      );

      // Should fail for "not found", not "invalid format"
      expect(result.verified).toBe(false);
      expect(result.error).not.toContain("Invalid transaction hash format");
    });
  });

  describe("verify - Blockfrost integration", () => {
    const validTxHash = "abc123def456789012345678901234567890123456789012345678901234abcd";
    const validRecipient = "addr1qy0000000000000000000000000000000000000000000000000000000000000000000000000000000";

    it("should verify successful ADA payment", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        minConfirmations: 1,
      });

      // Mock UTXOs response
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            hash: validTxHash,
            inputs: [],
            outputs: [
              {
                address: validRecipient,
                amount: [{ unit: "lovelace", quantity: "2000000" }],
                output_index: 0,
              },
            ],
          }),
        })
        // Mock tx info response
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            hash: validTxHash,
            block_height: 100,
            block_time: 1700000000,
          }),
        })
        // Mock tip response
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            height: 105,
          }),
        });

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "cardano:mainnet"
      );

      expect(result.verified).toBe(true);
      expect(result.txHash).toBe(validTxHash);
      expect(result.confirmations).toBe(6); // 105 - 100 + 1
      expect(result.blockNumber).toBe(100);
    });

    it("should return transaction not found error", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        retryAttempts: 1, // Reduce retries for faster test
      });

      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "cardano:mainnet"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toBe(`Transaction not found: ${validTxHash}`);
    });

    it("should detect insufficient confirmations", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        minConfirmations: 10,
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            hash: validTxHash,
            outputs: [
              {
                address: validRecipient,
                amount: [{ unit: "lovelace", quantity: "1000000" }],
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            block_height: 100,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            height: 105,
          }),
        });

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "cardano:mainnet"
      );

      expect(result.verified).toBe(false);
      expect(result.confirmations).toBe(6);
      expect(result.error).toContain("Insufficient confirmations");
    });

    it("should detect amount mismatch", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        minConfirmations: 1,
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            hash: validTxHash,
            outputs: [
              {
                address: validRecipient,
                amount: [{ unit: "lovelace", quantity: "500000" }], // Less than expected
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            block_height: 100,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            height: 105,
          }),
        });

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: validTxHash },
        BigInt("1000000"), // Expecting 1 ADA
        validRecipient,
        "cardano:mainnet"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("No output found");
    });

    it("should accept overpayment", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        minConfirmations: 1,
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            hash: validTxHash,
            outputs: [
              {
                address: validRecipient,
                amount: [{ unit: "lovelace", quantity: "5000000" }], // 5 ADA - more than expected
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            block_height: 100,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            height: 105,
          }),
        });

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: validTxHash },
        BigInt("1000000"), // Expecting 1 ADA
        validRecipient,
        "cardano:mainnet"
      );

      expect(result.verified).toBe(true);
    });
  });

  describe("verify - Native token verification", () => {
    const validTxHash = "abc123def456789012345678901234567890123456789012345678901234abcd";
    const validRecipient = "addr1qy0000000000000000000000000000000000000000000000000000000000000000000000000000000";
    const policyId = "d5e6bf0500378d4f0da4e8dde6becec7621cd8cbf5cbb9b87013d4cc";
    const assetName = "7454455354"; // hex encoded "TEST"

    it("should verify native token payment", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        minConfirmations: 1,
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            hash: validTxHash,
            outputs: [
              {
                address: validRecipient,
                amount: [
                  { unit: "lovelace", quantity: "2000000" },
                  { unit: `${policyId}${assetName}`, quantity: "100" },
                ],
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            block_height: 100,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            height: 105,
          }),
        });

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: validTxHash },
        BigInt("50"), // Expecting 50 tokens
        validRecipient,
        "cardano:mainnet",
        `${policyId}.${assetName}` // Asset with dot separator
      );

      expect(result.verified).toBe(true);
    });

    it("should verify native token with concatenated format", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        minConfirmations: 1,
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            hash: validTxHash,
            outputs: [
              {
                address: validRecipient,
                amount: [
                  { unit: "lovelace", quantity: "2000000" },
                  { unit: `${policyId}${assetName}`, quantity: "100" },
                ],
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            block_height: 100,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            height: 105,
          }),
        });

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: validTxHash },
        BigInt("50"),
        validRecipient,
        "cardano:mainnet",
        `${policyId}${assetName}` // Asset without dot separator
      );

      expect(result.verified).toBe(true);
    });

    it("should fail if native token amount insufficient", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        minConfirmations: 1,
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            hash: validTxHash,
            outputs: [
              {
                address: validRecipient,
                amount: [
                  { unit: "lovelace", quantity: "2000000" },
                  { unit: `${policyId}${assetName}`, quantity: "10" }, // Only 10 tokens
                ],
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            block_height: 100,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            height: 105,
          }),
        });

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: validTxHash },
        BigInt("50"), // Expecting 50 tokens
        validRecipient,
        "cardano:mainnet",
        `${policyId}.${assetName}`
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("No output found");
    });
  });

  describe("verify - Koios integration", () => {
    const validTxHash = "abc123def456789012345678901234567890123456789012345678901234abcd";
    const validRecipient = "addr1qy0000000000000000000000000000000000000000000000000000000000000000000000000000000";

    it("should verify via Koios API", async () => {
      const verifier = new CardanoVerifier({
        provider: "koios",
        network: "mainnet",
        minConfirmations: 1,
      });

      // Mock Koios UTXOs response
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              tx_hash: validTxHash,
              outputs: [
                {
                  payment_addr: { bech32: validRecipient },
                  value: "2000000",
                  asset_list: [],
                },
              ],
            },
          ],
        })
        // Mock Koios tx_info response
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              tx_hash: validTxHash,
              block_height: 100,
              tx_timestamp: 1700000000,
            },
          ],
        })
        // Mock Koios tip response
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              block_no: 105,
            },
          ],
        });

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "cardano:mainnet"
      );

      expect(result.verified).toBe(true);
      expect(result.confirmations).toBe(6);
    });
  });

  describe("verify - CBOR proof", () => {
    it("should reject CBOR proof (not yet implemented)", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
      });

      const proof: CardanoSignedCborProof = {
        kind: "cardano-signed-cbor",
        cborHex: "84a400...", // Truncated for brevity
      };

      const result = await verifier.verify(
        proof,
        BigInt("1000000"),
        "addr1test",
        "cardano:mainnet"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("CBOR transaction submission is not yet implemented");
    });
  });

  describe("verify - output index", () => {
    const validTxHash = "abc123def456789012345678901234567890123456789012345678901234abcd";
    const validRecipient = "addr1qy0000000000000000000000000000000000000000000000000000000000000000000000000000000";
    const otherRecipient = "addr1qx1111111111111111111111111111111111111111111111111111111111111111111111111111111";

    it("should verify specific output index", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        minConfirmations: 1,
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            hash: validTxHash,
            outputs: [
              {
                address: otherRecipient, // index 0 - different recipient
                amount: [{ unit: "lovelace", quantity: "1000000" }],
              },
              {
                address: validRecipient, // index 1 - our recipient
                amount: [{ unit: "lovelace", quantity: "2000000" }],
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            block_height: 100,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            height: 105,
          }),
        });

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "cardano:mainnet",
        undefined, // no specific asset
        1 // output index 1
      );

      expect(result.verified).toBe(true);
    });

    it("should fail if output index does not exist", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        minConfirmations: 1,
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            hash: validTxHash,
            outputs: [
              {
                address: validRecipient,
                amount: [{ unit: "lovelace", quantity: "1000000" }],
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            block_height: 100,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            height: 105,
          }),
        });

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "cardano:mainnet",
        undefined,
        5 // non-existent output index
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("Output index 5 not found");
    });
  });

  describe("error handling", () => {
    it("should handle API errors gracefully", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        retryAttempts: 1,
      });

      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: "a".repeat(64) },
        BigInt("1000000"),
        "addr1test",
        "cardano:mainnet"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("Verification failed");
    });

    it("should handle timeout", async () => {
      const verifier = new CardanoVerifier({
        blockfrostProjectId: "test-project-id",
        timeout: 100,
        retryAttempts: 1,
      });

      mockFetch.mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Timeout")), 200);
          })
      );

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: "a".repeat(64) },
        BigInt("1000000"),
        "addr1test",
        "cardano:mainnet"
      );

      expect(result.verified).toBe(false);
    });
  });
});
