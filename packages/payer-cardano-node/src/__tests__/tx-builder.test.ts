/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-node/src/__tests__/tx-builder.test.ts
 * @summary Unit tests for transaction builder utilities.
 *
 * Tests the pure functions in tx-builder.ts without network calls.
 */

import { describe, it, expect } from "vitest";
import {
  calculateTotalAmount,
  buildOutputs,
  selectUtxos,
  estimateMinAda,
  calculateFee,
  isValidCardanoAddress,
} from "../tx-builder.js";
import type { PaymentRequest } from "@poi-sdk/core";
import type { UTxO } from "../providers/interface.js";

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const createPaymentRequest = (
  overrides: Partial<PaymentRequest> = {}
): PaymentRequest => ({
  protocol: "flux",
  chain: "cardano:mainnet",
  asset: "ADA",
  amountUnits: "1000000",
  payTo: "addr1qxxx",
  ...overrides,
});

const createUtxo = (overrides: Partial<UTxO> = {}): UTxO => ({
  txHash: "a".repeat(64),
  outputIndex: 0,
  address: "addr1qxxx",
  lovelace: 10000000n,
  assets: {},
  ...overrides,
});

// ---------------------------------------------------------------------------
// calculateTotalAmount Tests
// ---------------------------------------------------------------------------

describe("calculateTotalAmount", () => {
  it("returns primary amount when no splits", () => {
    const request = createPaymentRequest({
      amountUnits: "5000000",
    });

    const total = calculateTotalAmount(request);

    expect(total).toBe(5000000n);
  });

  it("returns primary amount for inclusive splits", () => {
    const request = createPaymentRequest({
      amountUnits: "10000000",
      splits: {
        mode: "inclusive",
        outputs: [
          { to: "addr1split1", amountUnits: "2000000" },
          { to: "addr1split2", amountUnits: "3000000" },
        ],
      },
    });

    // Inclusive mode: total = primary amount (splits subtracted from primary)
    const total = calculateTotalAmount(request);

    expect(total).toBe(10000000n);
  });

  it("adds splits for additional mode", () => {
    const request = createPaymentRequest({
      amountUnits: "10000000",
      splits: {
        mode: "additional",
        outputs: [
          { to: "addr1split1", amountUnits: "2000000" },
          { to: "addr1split2", amountUnits: "3000000" },
        ],
      },
    });

    // Additional mode: total = primary + splits
    const total = calculateTotalAmount(request);

    expect(total).toBe(15000000n); // 10M + 2M + 3M
  });

  it("throws when inclusive splits exceed primary amount", () => {
    const request = createPaymentRequest({
      amountUnits: "5000000",
      splits: {
        mode: "inclusive",
        outputs: [{ to: "addr1split1", amountUnits: "6000000" }],
      },
    });

    expect(() => calculateTotalAmount(request)).toThrow(
      /exceeds primary amount/
    );
  });
});

// ---------------------------------------------------------------------------
// buildOutputs Tests
// ---------------------------------------------------------------------------

describe("buildOutputs", () => {
  it("creates single output for simple payment", () => {
    const request = createPaymentRequest({
      amountUnits: "5000000",
      payTo: "addr1recipient",
    });

    const outputs = buildOutputs(request);

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toEqual({
      address: "addr1recipient",
      lovelace: 5000000n,
    });
  });

  it("creates multiple outputs for additional splits", () => {
    const request = createPaymentRequest({
      amountUnits: "10000000",
      payTo: "addr1primary",
      splits: {
        mode: "additional",
        outputs: [
          { to: "addr1split1", amountUnits: "2000000" },
          { to: "addr1split2", amountUnits: "3000000" },
        ],
      },
    });

    const outputs = buildOutputs(request);

    expect(outputs).toHaveLength(3);
    expect(outputs[0]).toEqual({ address: "addr1primary", lovelace: 10000000n });
    expect(outputs[1]).toEqual({ address: "addr1split1", lovelace: 2000000n });
    expect(outputs[2]).toEqual({ address: "addr1split2", lovelace: 3000000n });
  });

  it("adjusts primary output for inclusive splits", () => {
    const request = createPaymentRequest({
      amountUnits: "10000000",
      payTo: "addr1primary",
      splits: {
        mode: "inclusive",
        outputs: [
          { to: "addr1split1", amountUnits: "2000000" },
          { to: "addr1split2", amountUnits: "3000000" },
        ],
      },
    });

    const outputs = buildOutputs(request);

    expect(outputs).toHaveLength(3);
    // Primary gets 10M - 2M - 3M = 5M
    expect(outputs[0]).toEqual({ address: "addr1primary", lovelace: 5000000n });
    expect(outputs[1]).toEqual({ address: "addr1split1", lovelace: 2000000n });
    expect(outputs[2]).toEqual({ address: "addr1split2", lovelace: 3000000n });
  });

  it("omits zero primary output in inclusive mode", () => {
    const request = createPaymentRequest({
      amountUnits: "5000000",
      payTo: "addr1primary",
      splits: {
        mode: "inclusive",
        outputs: [{ to: "addr1split1", amountUnits: "5000000" }],
      },
    });

    const outputs = buildOutputs(request);

    // Primary is 5M - 5M = 0, so omitted
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toEqual({ address: "addr1split1", lovelace: 5000000n });
  });
});

// ---------------------------------------------------------------------------
// selectUtxos Tests
// ---------------------------------------------------------------------------

describe("selectUtxos", () => {
  it("selects single UTxO when sufficient", () => {
    const utxos = [
      createUtxo({ lovelace: 50000000n, txHash: "a".repeat(64) }),
      createUtxo({ lovelace: 10000000n, txHash: "b".repeat(64) }),
    ];

    const selected = selectUtxos(utxos, 5000000n);

    // Should select the largest (50M) which is sufficient
    expect(selected).toHaveLength(1);
    expect(selected[0]?.lovelace).toBe(50000000n);
  });

  it("selects multiple UTxOs when needed", () => {
    const utxos = [
      createUtxo({ lovelace: 3000000n, txHash: "a".repeat(64) }),
      createUtxo({ lovelace: 4000000n, txHash: "b".repeat(64) }),
      createUtxo({ lovelace: 2000000n, txHash: "c".repeat(64) }),
    ];

    // Need 8M, largest is 4M, so need multiple
    const selected = selectUtxos(utxos, 8000000n);

    // Should select 4M + 3M = 7M (still not enough) + 2M = 9M
    expect(selected.length).toBeGreaterThanOrEqual(2);
    const total = selected.reduce((sum, u) => sum + u.lovelace, 0n);
    expect(total).toBeGreaterThanOrEqual(8000000n);
  });

  it("throws when insufficient UTxOs", () => {
    const utxos = [
      createUtxo({ lovelace: 1000000n }),
      createUtxo({ lovelace: 2000000n }),
    ];

    expect(() => selectUtxos(utxos, 10000000n)).toThrow(/Insufficient UTxOs/);
  });

  it("handles empty UTxO list", () => {
    expect(() => selectUtxos([], 1000000n)).toThrow(/Insufficient UTxOs/);
  });

  it("considers native assets when required", () => {
    const policyAsset =
      "aabbccdd".repeat(7) + "aabbccdd00112233"; // 56 + 16 = 72 chars

    const utxos = [
      createUtxo({
        lovelace: 10000000n,
        assets: {},
        txHash: "a".repeat(64),
      }),
      createUtxo({
        lovelace: 5000000n,
        assets: { [policyAsset]: 100n },
        txHash: "b".repeat(64),
      }),
    ];

    const selected = selectUtxos(utxos, 1000000n, { [policyAsset]: 50n });

    // Must select the one with the asset
    expect(selected.some((u) => (u.assets[policyAsset] ?? 0n) >= 50n)).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// estimateMinAda Tests
// ---------------------------------------------------------------------------

describe("estimateMinAda", () => {
  it("uses minimum size of 160 bytes", () => {
    const minAda = estimateMinAda(4310, 100); // 100 bytes < 160

    // Should use 160 bytes minimum
    expect(minAda).toBe(BigInt(4310 * 160));
  });

  it("uses actual size when larger than minimum", () => {
    const minAda = estimateMinAda(4310, 200);

    expect(minAda).toBe(BigInt(4310 * 200));
  });
});

// ---------------------------------------------------------------------------
// calculateFee Tests
// ---------------------------------------------------------------------------

describe("calculateFee", () => {
  it("calculates fee using linear formula", () => {
    // fee = minFeeA * size + minFeeB
    // Mainnet params: minFeeA = 44, minFeeB = 155381
    const fee = calculateFee(44, 155381, 300);

    expect(fee).toBe(BigInt(44 * 300 + 155381));
  });

  it("handles small transactions", () => {
    const fee = calculateFee(44, 155381, 200);

    expect(fee).toBe(BigInt(44 * 200 + 155381));
  });
});

// ---------------------------------------------------------------------------
// isValidCardanoAddress Tests
// ---------------------------------------------------------------------------

describe("isValidCardanoAddress", () => {
  it("accepts valid mainnet address prefix", () => {
    expect(
      isValidCardanoAddress(
        "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp"
      )
    ).toBe(true);
  });

  it("accepts valid testnet address prefix", () => {
    expect(
      isValidCardanoAddress(
        "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp"
      )
    ).toBe(true);
  });

  it("rejects invalid address prefix", () => {
    expect(isValidCardanoAddress("bc1qxxx")).toBe(false);
    expect(isValidCardanoAddress("0x123abc")).toBe(false);
    expect(isValidCardanoAddress("")).toBe(false);
  });
});
