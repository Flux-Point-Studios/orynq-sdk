/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-node/src/__tests__/providers.test.ts
 * @summary Unit tests for Blockfrost and Koios provider implementations.
 *
 * Tests provider construction and configuration. API calls are tested
 * with mocked fetch in integration tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BlockfrostProvider } from "../providers/blockfrost.js";
import { KoiosProvider } from "../providers/koios.js";

// ---------------------------------------------------------------------------
// BlockfrostProvider Tests
// ---------------------------------------------------------------------------

describe("BlockfrostProvider", () => {
  describe("constructor", () => {
    it("sets mainnet URL by default", () => {
      const provider = new BlockfrostProvider({
        projectId: "test-project-id",
      });

      expect(provider.getNetworkId()).toBe("mainnet");
    });

    it("sets preprod URL when specified", () => {
      const provider = new BlockfrostProvider({
        projectId: "test-project-id",
        network: "preprod",
      });

      expect(provider.getNetworkId()).toBe("preprod");
    });

    it("allows custom base URL", () => {
      const provider = new BlockfrostProvider({
        projectId: "test-project-id",
        baseUrl: "http://localhost:3000",
      });

      // Network ID should reflect the configured network (mainnet by default)
      expect(provider.getNetworkId()).toBe("mainnet");
    });
  });

  describe("getUtxos", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue([
            {
              tx_hash: "a".repeat(64),
              output_index: 0,
              address: "addr1qxxx",
              amount: [{ unit: "lovelace", quantity: "10000000" }],
              data_hash: null,
              inline_datum: null,
              reference_script_hash: null,
            },
          ]),
        })
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("validates address format", async () => {
      const provider = new BlockfrostProvider({
        projectId: "test-project-id",
      });

      await expect(provider.getUtxos("invalid-address")).rejects.toThrow(
        /Invalid Cardano address/
      );
    });

    it("maps UTxO response correctly", async () => {
      const provider = new BlockfrostProvider({
        projectId: "test-project-id",
      });

      const utxos = await provider.getUtxos("addr1qxxx");

      expect(utxos).toHaveLength(1);
      expect(utxos[0]).toEqual({
        txHash: "a".repeat(64),
        outputIndex: 0,
        address: "addr1qxxx",
        lovelace: 10000000n,
        assets: {},
      });
    });

    it("handles native assets", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue([
            {
              tx_hash: "b".repeat(64),
              output_index: 1,
              address: "addr1qyyy",
              amount: [
                { unit: "lovelace", quantity: "5000000" },
                {
                  unit: "abc123def456abc123def456abc123def456abc123def456abc123def456token1",
                  quantity: "100",
                },
              ],
              data_hash: null,
              inline_datum: null,
              reference_script_hash: null,
            },
          ]),
        })
      );

      const provider = new BlockfrostProvider({
        projectId: "test-project-id",
      });

      const utxos = await provider.getUtxos("addr1qyyy");

      expect(utxos[0]?.lovelace).toBe(5000000n);
      expect(
        utxos[0]?.assets[
          "abc123def456abc123def456abc123def456abc123def456abc123def456token1"
        ]
      ).toBe(100n);
    });

    it("returns empty array for 404 (no UTxOs)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
        })
      );

      const provider = new BlockfrostProvider({
        projectId: "test-project-id",
      });

      const utxos = await provider.getUtxos("addr1qzzz");

      expect(utxos).toEqual([]);
    });
  });

  describe("submitTx", () => {
    it("validates hex format", async () => {
      const provider = new BlockfrostProvider({
        projectId: "test-project-id",
      });

      await expect(provider.submitTx("not-hex!@#")).rejects.toThrow(
        /must be hex-encoded/
      );
    });
  });
});

// ---------------------------------------------------------------------------
// KoiosProvider Tests
// ---------------------------------------------------------------------------

describe("KoiosProvider", () => {
  describe("constructor", () => {
    it("sets mainnet URL by default", () => {
      const provider = new KoiosProvider();

      expect(provider.getNetworkId()).toBe("mainnet");
    });

    it("sets preprod URL when specified", () => {
      const provider = new KoiosProvider({
        network: "preprod",
      });

      expect(provider.getNetworkId()).toBe("preprod");
    });

    it("accepts optional API key", () => {
      const provider = new KoiosProvider({
        apiKey: "test-api-key",
      });

      expect(provider.getNetworkId()).toBe("mainnet");
    });
  });

  describe("getUtxos", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue([
            {
              tx_hash: "c".repeat(64),
              tx_index: 2,
              address: "addr1qabc",
              value: "15000000",
              asset_list: [],
              datum_hash: null,
              inline_datum: null,
              reference_script: null,
            },
          ]),
        })
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("validates address format", async () => {
      const provider = new KoiosProvider();

      await expect(provider.getUtxos("invalid-address")).rejects.toThrow(
        /Invalid Cardano address/
      );
    });

    it("maps UTxO response correctly", async () => {
      const provider = new KoiosProvider();

      const utxos = await provider.getUtxos("addr1qabc");

      expect(utxos).toHaveLength(1);
      expect(utxos[0]).toEqual({
        txHash: "c".repeat(64),
        outputIndex: 2,
        address: "addr1qabc",
        lovelace: 15000000n,
        assets: {},
      });
    });

    it("handles native assets", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue([
            {
              tx_hash: "d".repeat(64),
              tx_index: 0,
              address: "addr1qdef",
              value: "7000000",
              asset_list: [
                {
                  policy_id: "abc123def456abc123def456abc123def456abc123def456abc123de",
                  asset_name: "f456",
                  quantity: "500",
                },
              ],
              datum_hash: null,
              inline_datum: null,
              reference_script: null,
            },
          ]),
        })
      );

      const provider = new KoiosProvider();

      const utxos = await provider.getUtxos("addr1qdef");

      expect(utxos[0]?.lovelace).toBe(7000000n);
      expect(
        utxos[0]?.assets[
          "abc123def456abc123def456abc123def456abc123def456abc123def456"
        ]
      ).toBe(500n);
    });
  });

  describe("submitTx", () => {
    it("validates hex format", async () => {
      const provider = new KoiosProvider();

      await expect(provider.submitTx("not-hex!@#")).rejects.toThrow(
        /must be hex-encoded/
      );
    });
  });
});
