/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-cip30/src/__tests__/tx-builder.test.ts
 * @summary Unit tests for transaction builder utilities.
 *
 * Tests asset parsing, amount calculations, and payment output collection.
 * MeshJS wallet interaction is mocked for unit testing.
 */

import { describe, it, expect, vi } from "vitest";

// Mock @meshsdk/core to prevent ESM import issues with libsodium
vi.mock("@meshsdk/core", () => {
  const mockTx = {
    sendAssets: vi.fn().mockReturnThis(),
    build: vi.fn().mockResolvedValue("unsignedTxCbor"),
  };
  return {
    BrowserWallet: {
      enable: vi.fn(),
    },
    Transaction: vi.fn(() => mockTx),
  };
});

import {
  isAdaAsset,
  parseAssetId,
  toMeshUnit,
  toMeshAsset,
  calculateTotalAmount,
  calculateRequiredAmounts,
  collectPaymentOutputs,
} from "../tx-builder.js";
import type { PaymentRequest } from "@poi-sdk/core";

// ---------------------------------------------------------------------------
// Helper to create test payment requests
// ---------------------------------------------------------------------------

function createPaymentRequest(
  overrides: Partial<PaymentRequest> = {}
): PaymentRequest {
  return {
    protocol: "flux",
    chain: "cardano:mainnet",
    asset: "ADA",
    amountUnits: "5000000",
    payTo: "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isAdaAsset tests
// ---------------------------------------------------------------------------

describe("isAdaAsset", () => {
  it("should return true for ADA", () => {
    expect(isAdaAsset("ADA")).toBe(true);
  });

  it("should return true for ada (lowercase)", () => {
    expect(isAdaAsset("ada")).toBe(true);
  });

  it("should return true for lovelace", () => {
    expect(isAdaAsset("lovelace")).toBe(true);
  });

  it("should return true for LOVELACE (uppercase)", () => {
    expect(isAdaAsset("LOVELACE")).toBe(true);
  });

  it("should return true for empty string", () => {
    expect(isAdaAsset("")).toBe(true);
  });

  it("should return false for native token", () => {
    expect(
      isAdaAsset(
        "a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235484f534b59"
      )
    ).toBe(false);
  });

  it("should return false for policy.asset format", () => {
    expect(
      isAdaAsset(
        "a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235.484f534b59"
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAssetId tests
// ---------------------------------------------------------------------------

describe("parseAssetId", () => {
  const validPolicyId = "a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235";
  const validAssetName = "484f534b59";

  it("should return null for ADA", () => {
    expect(parseAssetId("ADA")).toBeNull();
    expect(parseAssetId("lovelace")).toBeNull();
    expect(parseAssetId("")).toBeNull();
  });

  it("should parse dot-separated format", () => {
    const result = parseAssetId(`${validPolicyId}.${validAssetName}`);
    expect(result).toEqual({
      policyId: validPolicyId,
      assetName: validAssetName,
    });
  });

  it("should parse dot-separated format with empty asset name", () => {
    const result = parseAssetId(`${validPolicyId}.`);
    expect(result).toEqual({
      policyId: validPolicyId,
      assetName: "",
    });
  });

  it("should parse concatenated format", () => {
    const result = parseAssetId(`${validPolicyId}${validAssetName}`);
    expect(result).toEqual({
      policyId: validPolicyId,
      assetName: validAssetName,
    });
  });

  it("should parse policy-only format (56 chars)", () => {
    const result = parseAssetId(validPolicyId);
    expect(result).toEqual({
      policyId: validPolicyId,
      assetName: "",
    });
  });
});

// ---------------------------------------------------------------------------
// toMeshUnit tests
// ---------------------------------------------------------------------------

describe("toMeshUnit", () => {
  const validPolicyId = "a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235";
  const validAssetName = "484f534b59";

  it("should return lovelace for ADA", () => {
    expect(toMeshUnit("ADA")).toBe("lovelace");
    expect(toMeshUnit("ada")).toBe("lovelace");
    expect(toMeshUnit("lovelace")).toBe("lovelace");
    expect(toMeshUnit("")).toBe("lovelace");
  });

  it("should convert dot-separated to concatenated", () => {
    const result = toMeshUnit(`${validPolicyId}.${validAssetName}`);
    expect(result).toBe(`${validPolicyId}${validAssetName}`);
  });

  it("should return concatenated format as-is", () => {
    const result = toMeshUnit(`${validPolicyId}${validAssetName}`);
    expect(result).toBe(`${validPolicyId}${validAssetName}`);
  });
});

// ---------------------------------------------------------------------------
// toMeshAsset tests
// ---------------------------------------------------------------------------

describe("toMeshAsset", () => {
  it("should create lovelace asset for ADA", () => {
    const result = toMeshAsset("ADA", 5000000n);
    expect(result).toEqual({
      unit: "lovelace",
      quantity: "5000000",
    });
  });

  it("should create native token asset", () => {
    const policyId = "a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235";
    const assetName = "484f534b59";
    const result = toMeshAsset(`${policyId}.${assetName}`, 1000n);
    expect(result).toEqual({
      unit: `${policyId}${assetName}`,
      quantity: "1000",
    });
  });

  it("should handle large amounts", () => {
    const result = toMeshAsset("ADA", 1000000000000000n);
    expect(result).toEqual({
      unit: "lovelace",
      quantity: "1000000000000000",
    });
  });
});

// ---------------------------------------------------------------------------
// calculateTotalAmount tests
// ---------------------------------------------------------------------------

describe("calculateTotalAmount", () => {
  it("should return primary amount when no splits", () => {
    const request = createPaymentRequest({ amountUnits: "5000000" });
    expect(calculateTotalAmount(request)).toBe(5000000n);
  });

  it("should return primary amount for inclusive splits", () => {
    const request = createPaymentRequest({
      amountUnits: "10000000",
      splits: {
        mode: "inclusive",
        outputs: [
          { to: "addr1...", amountUnits: "500000" },
          { to: "addr2...", amountUnits: "500000" },
        ],
      },
    });
    // Inclusive: total is still the primary amount
    expect(calculateTotalAmount(request)).toBe(10000000n);
  });

  it("should return primary + splits for additional mode", () => {
    const request = createPaymentRequest({
      amountUnits: "10000000",
      splits: {
        mode: "additional",
        outputs: [
          { to: "addr1...", amountUnits: "500000" },
          { to: "addr2...", amountUnits: "500000" },
        ],
      },
    });
    // Additional: 10 ADA + 0.5 ADA + 0.5 ADA = 11 ADA
    expect(calculateTotalAmount(request)).toBe(11000000n);
  });

  it("should handle empty splits array", () => {
    const request = createPaymentRequest({
      amountUnits: "5000000",
      splits: {
        mode: "inclusive",
        outputs: [],
      },
    });
    expect(calculateTotalAmount(request)).toBe(5000000n);
  });
});

// ---------------------------------------------------------------------------
// calculateRequiredAmounts tests
// ---------------------------------------------------------------------------

describe("calculateRequiredAmounts", () => {
  it("should return single entry for simple ADA payment", () => {
    const request = createPaymentRequest({ amountUnits: "5000000" });
    const amounts = calculateRequiredAmounts(request);
    expect(amounts.size).toBe(1);
    expect(amounts.get("lovelace")).toBe(5000000n);
  });

  it("should not double-count for inclusive splits", () => {
    const request = createPaymentRequest({
      amountUnits: "10000000",
      splits: {
        mode: "inclusive",
        outputs: [{ to: "addr1...", amountUnits: "500000" }],
      },
    });
    const amounts = calculateRequiredAmounts(request);
    // Inclusive: splits are part of primary, so total is still 10 ADA
    expect(amounts.get("lovelace")).toBe(10000000n);
  });

  it("should add amounts for additional splits", () => {
    const request = createPaymentRequest({
      amountUnits: "10000000",
      splits: {
        mode: "additional",
        outputs: [{ to: "addr1...", amountUnits: "500000" }],
      },
    });
    const amounts = calculateRequiredAmounts(request);
    // Additional: 10 ADA + 0.5 ADA = 10.5 ADA
    expect(amounts.get("lovelace")).toBe(10500000n);
  });

  it("should handle multiple assets in additional mode", () => {
    const tokenUnit = "a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235484f534b59";
    const request = createPaymentRequest({
      amountUnits: "10000000",
      splits: {
        mode: "additional",
        outputs: [
          { to: "addr1...", asset: tokenUnit, amountUnits: "100" },
        ],
      },
    });
    const amounts = calculateRequiredAmounts(request);
    expect(amounts.get("lovelace")).toBe(10000000n);
    expect(amounts.get(tokenUnit)).toBe(100n);
  });
});

// ---------------------------------------------------------------------------
// collectPaymentOutputs tests
// ---------------------------------------------------------------------------

describe("collectPaymentOutputs", () => {
  const merchantAddr = "addr1_merchant";
  const platformAddr = "addr1_platform";
  const referrerAddr = "addr1_referrer";

  it("should create single output for simple payment", () => {
    const request = createPaymentRequest({
      amountUnits: "5000000",
      payTo: merchantAddr,
    });
    const outputs = collectPaymentOutputs(request);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toEqual({
      address: merchantAddr,
      asset: "ADA",
      amount: 5000000n,
    });
  });

  it("should split amounts correctly in inclusive mode", () => {
    const request = createPaymentRequest({
      amountUnits: "10000000", // 10 ADA total
      payTo: merchantAddr,
      splits: {
        mode: "inclusive",
        outputs: [
          { role: "platform", to: platformAddr, amountUnits: "500000" }, // 0.5 ADA
          { role: "referrer", to: referrerAddr, amountUnits: "300000" }, // 0.3 ADA
        ],
      },
    });
    const outputs = collectPaymentOutputs(request);

    // Merchant gets 10 - 0.5 - 0.3 = 9.2 ADA
    expect(outputs).toHaveLength(3);

    const merchantOutput = outputs.find((o) => o.address === merchantAddr);
    expect(merchantOutput?.amount).toBe(9200000n);

    const platformOutput = outputs.find((o) => o.address === platformAddr);
    expect(platformOutput?.amount).toBe(500000n);

    const referrerOutput = outputs.find((o) => o.address === referrerAddr);
    expect(referrerOutput?.amount).toBe(300000n);
  });

  it("should add amounts in additional mode", () => {
    const request = createPaymentRequest({
      amountUnits: "10000000", // 10 ADA to merchant
      payTo: merchantAddr,
      splits: {
        mode: "additional",
        outputs: [
          { role: "platform", to: platformAddr, amountUnits: "500000" }, // 0.5 ADA extra
        ],
      },
    });
    const outputs = collectPaymentOutputs(request);

    expect(outputs).toHaveLength(2);

    // Merchant gets full 10 ADA
    const merchantOutput = outputs.find((o) => o.address === merchantAddr);
    expect(merchantOutput?.amount).toBe(10000000n);

    // Platform gets 0.5 ADA additional
    const platformOutput = outputs.find((o) => o.address === platformAddr);
    expect(platformOutput?.amount).toBe(500000n);
  });

  it("should handle splits with different assets", () => {
    const tokenUnit = "a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235.484f534b59";
    const request = createPaymentRequest({
      amountUnits: "10000000",
      payTo: merchantAddr,
      splits: {
        mode: "additional",
        outputs: [
          { to: platformAddr, asset: tokenUnit, amountUnits: "100" },
        ],
      },
    });
    const outputs = collectPaymentOutputs(request);

    expect(outputs).toHaveLength(2);

    const adaOutput = outputs.find((o) => o.asset === "ADA");
    expect(adaOutput?.amount).toBe(10000000n);

    const tokenOutput = outputs.find((o) => o.asset === tokenUnit);
    expect(tokenOutput?.amount).toBe(100n);
  });

  it("should not create primary output if all goes to splits (edge case)", () => {
    const request = createPaymentRequest({
      amountUnits: "1000000", // 1 ADA total
      payTo: merchantAddr,
      splits: {
        mode: "inclusive",
        outputs: [
          { to: platformAddr, amountUnits: "600000" },
          { to: referrerAddr, amountUnits: "300000" },
          // 100k lovelace left for merchant
        ],
      },
    });
    const outputs = collectPaymentOutputs(request);

    // Merchant gets 1000000 - 600000 - 300000 = 100000
    const merchantOutput = outputs.find((o) => o.address === merchantAddr);
    expect(merchantOutput?.amount).toBe(100000n);
  });
});
