/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-node/src/tx-builder.ts
 * @summary Server-side Cardano transaction builder for payment flows.
 *
 * This file provides utilities for building Cardano transactions from
 * payment requests. The actual transaction building requires
 * @emurgo/cardano-serialization-lib-nodejs.
 *
 * Used by:
 * - CardanoNodePayer for transaction construction
 *
 * Requires:
 * - @emurgo/cardano-serialization-lib-nodejs for full functionality
 */

import type { PaymentRequest, Signer } from "@poi-sdk/core";
import type { UTxO, ProtocolParameters } from "./providers/interface.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parameters for building a payment transaction.
 */
export interface BuildTxParams {
  /** Payment request to fulfill */
  request: PaymentRequest;

  /** Available UTxOs to spend */
  utxos: UTxO[];

  /** Address to send change to */
  changeAddress: string;

  /** Current protocol parameters */
  protocolParameters: ProtocolParameters;

  /** Signer for transaction signing */
  signer: Signer;
}

/**
 * Result of building a transaction.
 */
export interface BuiltTx {
  /** Hex-encoded CBOR of the signed transaction */
  txCbor: string;

  /** Transaction hash (64-character hex) */
  txHash: string;
}

/**
 * Represents a single output to include in the transaction.
 */
export interface TxOutput {
  /** Recipient address */
  address: string;

  /** Amount in lovelace */
  lovelace: bigint;

  /** Native assets to include (optional) */
  assets?: Record<string, bigint>;
}

// ---------------------------------------------------------------------------
// Transaction Building
// ---------------------------------------------------------------------------

/**
 * Build and sign a payment transaction.
 *
 * This is a stub implementation that outlines the transaction building flow.
 * Full implementation requires @emurgo/cardano-serialization-lib-nodejs.
 *
 * Transaction building flow:
 * 1. Calculate total output amount (primary payment + splits)
 * 2. Select UTxOs to cover outputs + estimated fees
 * 3. Build transaction body with inputs, outputs, and fee
 * 4. Calculate actual fee and adjust change
 * 5. Sign transaction with provided signer
 * 6. Serialize to CBOR
 *
 * @param params - Transaction building parameters
 * @returns Promise resolving to built transaction
 * @throws If UTxOs are insufficient or transaction building fails
 *
 * @example
 * ```typescript
 * const { txCbor, txHash } = await buildPaymentTx({
 *   request: paymentRequest,
 *   utxos: await provider.getUtxos(address),
 *   changeAddress: address,
 *   protocolParameters: await provider.getProtocolParameters(),
 *   signer: mySigner,
 * });
 * ```
 */
export async function buildPaymentTx(params: BuildTxParams): Promise<BuiltTx> {
  const { request, utxos, changeAddress: _changeAddress, protocolParameters: _protocolParameters, signer: _signer } = params;

  // Validate inputs
  if (utxos.length === 0) {
    throw new Error("No UTxOs available for transaction building");
  }

  // Calculate total amount needed
  const totalRequired = calculateTotalAmount(request);
  const totalAvailable = utxos.reduce((sum, u) => sum + u.lovelace, 0n);

  if (totalAvailable < totalRequired) {
    throw new Error(
      `Insufficient balance: need ${totalRequired} lovelace, have ${totalAvailable}`
    );
  }

  // Build outputs list (used in actual implementation)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void buildOutputs(request);

  // This is where the actual transaction building would happen
  // using cardano-serialization-lib-nodejs

  throw new Error(
    "buildPaymentTx requires @emurgo/cardano-serialization-lib-nodejs.\n" +
      "Install it with: pnpm add @emurgo/cardano-serialization-lib-nodejs\n" +
      "\n" +
      "Implementation outline:\n" +
      "```typescript\n" +
      "import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';\n" +
      "\n" +
      "// 1. Create transaction builder\n" +
      "const txBuilder = CSL.TransactionBuilder.new(\n" +
      "  CSL.TransactionBuilderConfigBuilder.new()\n" +
      "    .fee_algo(CSL.LinearFee.new(\n" +
      "      CSL.BigNum.from_str(protocolParameters.minFeeA.toString()),\n" +
      "      CSL.BigNum.from_str(protocolParameters.minFeeB.toString())\n" +
      "    ))\n" +
      "    .coins_per_utxo_byte(\n" +
      "      CSL.BigNum.from_str(protocolParameters.coinsPerUtxoByte.toString())\n" +
      "    )\n" +
      "    .build()\n" +
      ");\n" +
      "\n" +
      "// 2. Add inputs (selected UTxOs)\n" +
      "// 3. Add outputs (payment + splits)\n" +
      "// 4. Add change output\n" +
      "// 5. Build transaction body\n" +
      "// 6. Sign with signer\n" +
      "// 7. Assemble and serialize\n" +
      "```"
  );
}

/**
 * Calculate the total amount needed for a payment request.
 *
 * Handles both inclusive and additional split modes:
 * - inclusive: Total equals amountUnits (splits are subtracted from primary)
 * - additional: Total equals amountUnits + sum of splits
 *
 * @param request - Payment request
 * @returns Total amount in atomic units (lovelace)
 */
export function calculateTotalAmount(request: PaymentRequest): bigint {
  const primaryAmount = BigInt(request.amountUnits);

  // No splits - return primary amount
  if (request.splits === undefined) {
    return primaryAmount;
  }

  // Calculate total split amount
  const splitTotal = request.splits.outputs.reduce(
    (sum, split) => sum + BigInt(split.amountUnits),
    0n
  );

  // Inclusive mode: splits are part of primary amount
  if (request.splits.mode === "inclusive") {
    // Validate that splits don't exceed primary amount
    if (splitTotal > primaryAmount) {
      throw new Error(
        `Split total (${splitTotal}) exceeds primary amount (${primaryAmount}) in inclusive mode`
      );
    }
    return primaryAmount;
  }

  // Additional mode: splits are on top of primary amount
  return primaryAmount + splitTotal;
}

/**
 * Build the list of transaction outputs from a payment request.
 *
 * Creates outputs for:
 * 1. Primary payment recipient
 * 2. Split recipients (if any)
 *
 * @param request - Payment request
 * @returns Array of transaction outputs
 */
export function buildOutputs(request: PaymentRequest): TxOutput[] {
  const outputs: TxOutput[] = [];

  // Determine primary payment amount
  let primaryAmount = BigInt(request.amountUnits);

  // In inclusive mode, subtract splits from primary
  if (request.splits !== undefined && request.splits.mode === "inclusive") {
    const splitTotal = request.splits.outputs.reduce(
      (sum, split) => sum + BigInt(split.amountUnits),
      0n
    );
    primaryAmount -= splitTotal;
  }

  // Add primary recipient output (if amount > 0)
  if (primaryAmount > 0n) {
    outputs.push({
      address: request.payTo,
      lovelace: primaryAmount,
    });
  }

  // Add split outputs
  if (request.splits !== undefined) {
    for (const split of request.splits.outputs) {
      outputs.push({
        address: split.to,
        lovelace: BigInt(split.amountUnits),
        // Note: Native asset splits would need additional handling
      });
    }
  }

  return outputs;
}

/**
 * Select UTxOs to cover the required amount using a simple greedy algorithm.
 *
 * This is a basic implementation. Production use cases may want more
 * sophisticated coin selection (e.g., random-improve, largest-first).
 *
 * @param utxos - Available UTxOs
 * @param requiredLovelace - Required amount in lovelace
 * @param requiredAssets - Required native assets (optional)
 * @returns Selected UTxOs
 * @throws If insufficient UTxOs
 */
export function selectUtxos(
  utxos: UTxO[],
  requiredLovelace: bigint,
  requiredAssets?: Record<string, bigint>
): UTxO[] {
  // Sort UTxOs by lovelace (largest first for better change)
  const sorted = [...utxos].sort((a, b) => {
    if (b.lovelace > a.lovelace) return 1;
    if (b.lovelace < a.lovelace) return -1;
    return 0;
  });

  const selected: UTxO[] = [];
  let accumulatedLovelace = 0n;
  const accumulatedAssets: Record<string, bigint> = {};

  // Check if we've covered all requirements
  const isSufficient = (): boolean => {
    if (accumulatedLovelace < requiredLovelace) return false;

    if (requiredAssets !== undefined) {
      for (const [asset, amount] of Object.entries(requiredAssets)) {
        const accumulated = accumulatedAssets[asset] ?? 0n;
        if (accumulated < amount) return false;
      }
    }

    return true;
  };

  // Greedy selection
  for (const utxo of sorted) {
    selected.push(utxo);
    accumulatedLovelace += utxo.lovelace;

    // Accumulate assets
    for (const [asset, amount] of Object.entries(utxo.assets)) {
      accumulatedAssets[asset] = (accumulatedAssets[asset] ?? 0n) + amount;
    }

    if (isSufficient()) {
      break;
    }
  }

  if (!isSufficient()) {
    throw new Error(
      `Insufficient UTxOs: need ${requiredLovelace} lovelace, ` +
        `accumulated ${accumulatedLovelace}`
    );
  }

  return selected;
}

/**
 * Estimate the minimum ADA required for a UTxO based on its size.
 *
 * Uses the coinsPerUtxoByte parameter to calculate minimum ADA.
 *
 * @param coinsPerUtxoByte - Protocol parameter for min-ada calculation
 * @param outputSize - Estimated output size in bytes
 * @returns Minimum ADA in lovelace
 */
export function estimateMinAda(
  coinsPerUtxoByte: number,
  outputSize: number
): bigint {
  // Minimum 160 bytes for the output header
  const size = Math.max(outputSize, 160);
  return BigInt(coinsPerUtxoByte) * BigInt(size);
}

/**
 * Calculate transaction fee estimate.
 *
 * Uses the linear fee formula: fee = minFeeA * tx_size + minFeeB
 *
 * @param minFeeA - Fee coefficient A
 * @param minFeeB - Fee coefficient B (base fee)
 * @param txSizeBytes - Transaction size in bytes
 * @returns Estimated fee in lovelace
 */
export function calculateFee(
  minFeeA: number,
  minFeeB: number,
  txSizeBytes: number
): bigint {
  return BigInt(minFeeA) * BigInt(txSizeBytes) + BigInt(minFeeB);
}
