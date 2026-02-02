/**
 * @fileoverview Tests for Blockfrost provider.
 *
 * Location: packages/anchors-cardano/src/__tests__/blockfrost.test.ts
 *
 * Tests coverage:
 * - createBlockfrostProvider: creates provider with config
 * - getBlockfrostBaseUrl: returns correct URLs for networks
 * - getTxMetadata: fetches transaction metadata
 * - getTxInfo: fetches transaction info
 * - Error handling and retries
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createBlockfrostProvider,
  getBlockfrostBaseUrl,
  BlockfrostError,
} from "../providers/blockfrost.js";
import { POI_METADATA_LABEL } from "../types.js";
import type { CardanoNetwork } from "../types.js";

// =============================================================================
// TEST FIXTURES
// =============================================================================

const VALID_HASH = "a".repeat(64);
const VALID_PROJECT_ID = "mainnetABCDEF123456";
const TEST_TX_HASH = "abc123def456789012345678901234567890123456789012345678901234";

/**
 * Creates a mock fetch function for testing.
 */
function createMockFetch(responseData: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(responseData),
  });
}

/**
 * Creates a mock metadata response from Blockfrost.
 */
function createMockMetadataResponse(anchorData?: Record<string, unknown>) {
  return [
    {
      label: POI_METADATA_LABEL.toString(),
      json_metadata: anchorData ?? {
        schema: "poi-anchor-v1",
        anchors: [
          {
            type: "process-trace",
            version: "1.0",
            rootHash: VALID_HASH,
            manifestHash: "b".repeat(64),
            timestamp: "2024-01-28T12:00:00Z",
          },
        ],
      },
    },
  ];
}

/**
 * Creates a mock transaction response from Blockfrost.
 */
function createMockTxResponse() {
  return {
    hash: TEST_TX_HASH,
    block: "block" + "b".repeat(58),
    block_height: 1000,
    slot: 50000,
    block_time: 1706443200, // 2024-01-28T12:00:00Z
  };
}

/**
 * Creates a mock block tip response from Blockfrost.
 */
function createMockBlockTipResponse() {
  return {
    slot: 51000, // 1000 slots ahead
  };
}

// =============================================================================
// createBlockfrostProvider TESTS
// =============================================================================

describe("createBlockfrostProvider", () => {
  it("returns provider with all required methods", () => {
    const mockFetch = createMockFetch({});
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    expect(provider).toHaveProperty("getTxMetadata");
    expect(provider).toHaveProperty("getTxInfo");
    expect(provider).toHaveProperty("getNetworkId");
    expect(typeof provider.getTxMetadata).toBe("function");
    expect(typeof provider.getTxInfo).toBe("function");
    expect(typeof provider.getNetworkId).toBe("function");
  });

  it("returns correct network from getNetworkId", () => {
    const mockFetch = createMockFetch({});
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "preprod",
      fetchFn: mockFetch,
    });

    expect(provider.getNetworkId()).toBe("preprod");
  });

  it("throws error for empty projectId", () => {
    expect(() =>
      createBlockfrostProvider({
        projectId: "",
        network: "mainnet",
      })
    ).toThrow(/projectId is required/);
  });

  it("throws error for invalid projectId type", () => {
    expect(() =>
      createBlockfrostProvider({
        projectId: 123 as unknown as string,
        network: "mainnet",
      })
    ).toThrow(/projectId is required/);
  });

  it("throws error for invalid network", () => {
    expect(() =>
      createBlockfrostProvider({
        projectId: VALID_PROJECT_ID,
        network: "invalid" as CardanoNetwork,
      })
    ).toThrow(/Invalid network/);
  });

  it("throws error for missing network", () => {
    expect(() =>
      createBlockfrostProvider({
        projectId: VALID_PROJECT_ID,
        network: undefined as unknown as CardanoNetwork,
      })
    ).toThrow(/network is required/);
  });
});

// =============================================================================
// getBlockfrostBaseUrl TESTS
// =============================================================================

describe("getBlockfrostBaseUrl", () => {
  it("returns correct URL for mainnet", () => {
    const url = getBlockfrostBaseUrl("mainnet");
    expect(url).toBe("https://cardano-mainnet.blockfrost.io/api/v0");
  });

  it("returns correct URL for preprod", () => {
    const url = getBlockfrostBaseUrl("preprod");
    expect(url).toBe("https://cardano-preprod.blockfrost.io/api/v0");
  });

  it("returns correct URL for preview", () => {
    const url = getBlockfrostBaseUrl("preview");
    expect(url).toBe("https://cardano-preview.blockfrost.io/api/v0");
  });
});

// =============================================================================
// getTxMetadata TESTS
// =============================================================================

describe("getTxMetadata", () => {
  it("returns metadata for valid tx", async () => {
    const mockFetch = createMockFetch(createMockMetadataResponse());
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    const metadata = await provider.getTxMetadata(TEST_TX_HASH);

    expect(metadata).not.toBeNull();
    expect(metadata?.[POI_METADATA_LABEL.toString()]).toBeDefined();
  });

  it("returns correct metadata structure", async () => {
    const anchorData = {
      schema: "poi-anchor-v1",
      anchors: [
        {
          type: "process-trace",
          version: "1.0",
          rootHash: VALID_HASH,
          manifestHash: "b".repeat(64),
          timestamp: "2024-01-28T12:00:00Z",
        },
      ],
    };
    const mockFetch = createMockFetch(createMockMetadataResponse(anchorData));
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    const metadata = await provider.getTxMetadata(TEST_TX_HASH);

    expect(metadata?.[POI_METADATA_LABEL.toString()]).toEqual(anchorData);
  });

  it("returns null for 404 (transaction not found)", async () => {
    const mockFetch = createMockFetch({ error: "Not found" }, 404);
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    const metadata = await provider.getTxMetadata(TEST_TX_HASH);

    expect(metadata).toBeNull();
  });

  it("returns null for empty metadata array", async () => {
    const mockFetch = createMockFetch([]);
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    const metadata = await provider.getTxMetadata(TEST_TX_HASH);

    expect(metadata).toBeNull();
  });

  it("returns null if label 2222 not present in metadata", async () => {
    const mockFetch = createMockFetch([
      { label: "1234", json_metadata: {} },
    ]);
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    const metadata = await provider.getTxMetadata(TEST_TX_HASH);

    expect(metadata).toBeNull();
  });

  it("throws BlockfrostError for 403 (invalid project ID)", async () => {
    const mockFetch = createMockFetch({ message: "Invalid project ID" }, 403);
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    await expect(provider.getTxMetadata(TEST_TX_HASH)).rejects.toThrow(
      BlockfrostError
    );
    await expect(provider.getTxMetadata(TEST_TX_HASH)).rejects.toThrow(
      /Invalid Blockfrost project ID/
    );
  });

  it("normalizes 0x prefix from txHash", async () => {
    const mockFetch = createMockFetch(createMockMetadataResponse());
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    await provider.getTxMetadata("0x" + TEST_TX_HASH);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/txs/${TEST_TX_HASH}/metadata`),
      expect.any(Object)
    );
  });

  it("throws error for empty txHash", async () => {
    const mockFetch = createMockFetch({});
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    await expect(provider.getTxMetadata("")).rejects.toThrow(
      /Transaction hash is required/
    );
  });

  it("includes project_id header in request", async () => {
    const mockFetch = createMockFetch(createMockMetadataResponse());
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    await provider.getTxMetadata(TEST_TX_HASH);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          project_id: VALID_PROJECT_ID,
        }),
      })
    );
  });
});

// =============================================================================
// getTxInfo TESTS
// =============================================================================

describe("getTxInfo", () => {
  it("returns txInfo for valid tx", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(createMockTxResponse()),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(createMockBlockTipResponse()),
      });

    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    const txInfo = await provider.getTxInfo(TEST_TX_HASH);

    expect(txInfo).not.toBeNull();
    expect(txInfo?.txHash).toBe(TEST_TX_HASH);
    expect(txInfo?.blockHeight).toBe(1000);
  });

  it("maps Blockfrost response correctly to TxInfo", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(createMockTxResponse()),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(createMockBlockTipResponse()),
      });

    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    const txInfo = await provider.getTxInfo(TEST_TX_HASH);

    expect(txInfo?.txHash).toBe(TEST_TX_HASH);
    expect(txInfo?.blockHash).toBe("block" + "b".repeat(58));
    expect(txInfo?.blockHeight).toBe(1000);
    expect(txInfo?.slot).toBe(50000);
    expect(txInfo?.timestamp).toBe("2024-01-28T12:00:00.000Z");
    expect(typeof txInfo?.confirmations).toBe("number");
  });

  it("calculates confirmations from slot difference", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          ...createMockTxResponse(),
          slot: 50000,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          slot: 51000, // 1000 slots ahead
        }),
      });

    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    const txInfo = await provider.getTxInfo(TEST_TX_HASH);

    // 1000 slots / 20 = 50 blocks
    expect(txInfo?.confirmations).toBe(50);
  });

  it("returns null for 404 (transaction not found)", async () => {
    const mockFetch = createMockFetch({ error: "Not found" }, 404);
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    const txInfo = await provider.getTxInfo(TEST_TX_HASH);

    expect(txInfo).toBeNull();
  });

  it("throws error for empty txHash", async () => {
    const mockFetch = createMockFetch({});
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    await expect(provider.getTxInfo("")).rejects.toThrow(
      /Transaction hash is required/
    );
  });

  it("handles block tip fetch failure gracefully", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(createMockTxResponse()),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: vi.fn().mockResolvedValue({ error: "Server error" }),
      });

    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
      retries: 0, // Disable retries for test speed
    });

    const txInfo = await provider.getTxInfo(TEST_TX_HASH);

    // Should still return txInfo with 0 confirmations
    expect(txInfo).not.toBeNull();
    expect(txInfo?.confirmations).toBe(0);
  });
});

// =============================================================================
// ERROR HANDLING AND RETRIES
// =============================================================================

describe("error handling", () => {
  it("throws BlockfrostError for 403", async () => {
    const mockFetch = createMockFetch({ message: "Forbidden" }, 403);
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    await expect(provider.getTxMetadata(TEST_TX_HASH)).rejects.toThrow(
      BlockfrostError
    );
  });

  it("throws BlockfrostError for 400", async () => {
    const mockFetch = createMockFetch({ message: "Bad request" }, 400);
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    await expect(provider.getTxMetadata(TEST_TX_HASH)).rejects.toThrow(
      BlockfrostError
    );
  });

  it("throws BlockfrostError for 418 (IP banned)", async () => {
    const mockFetch = createMockFetch({ message: "Banned" }, 418);
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    await expect(provider.getTxMetadata(TEST_TX_HASH)).rejects.toThrow(
      /IP address is banned/
    );
  });

  it("BlockfrostError includes statusCode", async () => {
    const mockFetch = createMockFetch({ message: "Bad request" }, 400);
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    try {
      await provider.getTxMetadata(TEST_TX_HASH);
    } catch (error) {
      expect(error).toBeInstanceOf(BlockfrostError);
      expect((error as BlockfrostError).statusCode).toBe(400);
    }
  });
});

describe("retries", () => {
  it("retries on 429 (rate limit)", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: vi.fn().mockResolvedValue({ message: "Rate limited" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(createMockMetadataResponse()),
      });

    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
      retries: 1,
    });

    const metadata = await provider.getTxMetadata(TEST_TX_HASH);

    expect(metadata).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 (server error)", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: vi.fn().mockResolvedValue({ message: "Server error" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(createMockMetadataResponse()),
      });

    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
      retries: 1,
    });

    const metadata = await provider.getTxMetadata(TEST_TX_HASH);

    expect(metadata).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 404", async () => {
    const mockFetch = createMockFetch({ error: "Not found" }, 404);
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
      retries: 3,
    });

    const metadata = await provider.getTxMetadata(TEST_TX_HASH);

    expect(metadata).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 403", async () => {
    const mockFetch = createMockFetch({ message: "Invalid project ID" }, 403);
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
      retries: 3,
    });

    await expect(provider.getTxMetadata(TEST_TX_HASH)).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries and throws on persistent failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({ message: "Server error" }),
    });

    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
      retries: 2,
    });

    await expect(provider.getTxMetadata(TEST_TX_HASH)).rejects.toThrow(
      /internal server error/i
    );
    // Initial + 2 retries = 3 calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("handles network timeout with retry", async () => {
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";

    const mockFetch = vi.fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(createMockMetadataResponse()),
      });

    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
      retries: 1,
      timeout: 100,
    });

    const metadata = await provider.getTxMetadata(TEST_TX_HASH);

    expect(metadata).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// CONFIGURATION TESTS
// =============================================================================

describe("configuration", () => {
  it("uses custom timeout", async () => {
    const mockFetch = createMockFetch(createMockMetadataResponse());
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
      timeout: 5000,
    });

    await provider.getTxMetadata(TEST_TX_HASH);

    // Verify the abort signal was passed (indicates timeout configuration)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("uses default timeout when not specified", async () => {
    const mockFetch = createMockFetch(createMockMetadataResponse());
    const provider = createBlockfrostProvider({
      projectId: VALID_PROJECT_ID,
      network: "mainnet",
      fetchFn: mockFetch,
    });

    await provider.getTxMetadata(TEST_TX_HASH);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("uses correct base URL for each network", async () => {
    const networks: CardanoNetwork[] = ["mainnet", "preprod", "preview"];

    for (const network of networks) {
      const mockFetch = createMockFetch(createMockMetadataResponse());
      const provider = createBlockfrostProvider({
        projectId: VALID_PROJECT_ID,
        network,
        fetchFn: mockFetch,
      });

      await provider.getTxMetadata(TEST_TX_HASH);

      const expectedUrl = getBlockfrostBaseUrl(network);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(expectedUrl),
        expect.any(Object)
      );
    }
  });
});
