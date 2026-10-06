import { describe, expect, it } from "vitest";
import { DEFAULT_COST_PARAMETERS, costParametersOf, openWallet } from "../src/wallet.js";

// wallet-sdk-dust-wallet 4.2.0 pays a fee by selecting DUST until it covers the fee its dry run
// computes. For a transaction whose computed fee is 0 it selects nothing, the dry run then costs
// 1 SPECK, and every later round reads that fee as a surplus and selects nothing again: the
// synchronous loop never ends, and its ledger allocations grow the wasm heap until the ledger
// traps. On preprod the same balancing of a maintenance update, stuck that way, finished in one
// round with 1 SPECK of overhead.
describe("the wallet's fee overhead", () => {
  it("is 1 SPECK unless the caller sets more", () => {
    expect(DEFAULT_COST_PARAMETERS.additionalFeeOverhead).toBe(1n);
    expect(costParametersOf(undefined)).toEqual(DEFAULT_COST_PARAMETERS);
    expect(costParametersOf({ additionalFeeOverhead: 5n, feeBlocksMargin: 3 })).toEqual({ additionalFeeOverhead: 5n, feeBlocksMargin: 3 });
  });

  it("is refused at 0, before the wallet reads its mnemonic", async () => {
    expect(() => costParametersOf({ additionalFeeOverhead: 0n, feeBlocksMargin: 5 })).toThrow(/additionalFeeOverhead must be at least 1 SPECK/);
    await expect(
      openWallet({ network: "preprod", mnemonicFile: "/nonexistent/wallet.mnemonic", endpoints: undefined as never, source: undefined as never, zkDir: "/nonexistent", costParameters: { additionalFeeOverhead: 0n, feeBlocksMargin: 5 } }),
    ).rejects.toThrow(/additionalFeeOverhead must be at least 1 SPECK/);
  });
});
