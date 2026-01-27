/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-node/src/tx-builder.ts
 * @summary Server-side Cardano transaction builder for payment flows.
 *
 * This file provides utilities for building Cardano transactions from
 * payment requests using @emurgo/cardano-serialization-lib-nodejs.
 *
 * Used by:
 * - CardanoNodePayer for transaction construction
 *
 * Requires:
 * - @emurgo/cardano-serialization-lib-nodejs for transaction building
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

/**
 * Extended signer interface with transaction signing support.
 */
export interface ExtendedSigner extends Signer {
  /** Sign transaction body and return vkey witness CBOR hex */
  signTx?(txBodyHash: Uint8Array, chain: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// CSL Import Helper
// ---------------------------------------------------------------------------

/**
 * CSL module type
 */
type CSLType = typeof import("@emurgo/cardano-serialization-lib-nodejs");

/**
 * Dynamically import cardano-serialization-lib-nodejs.
 * This allows the package to be used without CSL for basic provider operations.
 */
async function loadCSL(): Promise<CSLType> {
  try {
    const CSL = await import("@emurgo/cardano-serialization-lib-nodejs");
    return CSL;
  } catch {
    throw new Error(
      "Transaction building requires @emurgo/cardano-serialization-lib-nodejs.\n" +
        "Install it with: pnpm add @emurgo/cardano-serialization-lib-nodejs"
    );
  }
}

// ---------------------------------------------------------------------------
// Transaction Building
// ---------------------------------------------------------------------------

/**
 * Build and sign a payment transaction.
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
  const { request, utxos, changeAddress, protocolParameters, signer } = params;

  // Validate inputs
  if (utxos.length === 0) {
    throw new Error("No UTxOs available for transaction building");
  }

  const CSL = await loadCSL();

  // Calculate total amount needed (including estimated fee)
  const totalRequired = calculateTotalAmount(request);
  const estimatedFee = calculateFee(
    protocolParameters.minFeeA,
    protocolParameters.minFeeB,
    300 // Estimated initial tx size
  );
  const totalWithFee = totalRequired + estimatedFee;

  // Select UTxOs
  const selectedUtxos = selectUtxos(utxos, totalWithFee);

  // Build outputs list
  const outputs = buildOutputs(request);

  // Create transaction builder with protocol parameters
  const txBuilderConfig = CSL.TransactionBuilderConfigBuilder.new()
    .fee_algo(
      CSL.LinearFee.new(
        CSL.BigNum.from_str(protocolParameters.minFeeA.toString()),
        CSL.BigNum.from_str(protocolParameters.minFeeB.toString())
      )
    )
    .coins_per_utxo_byte(
      CSL.BigNum.from_str(protocolParameters.coinsPerUtxoByte.toString())
    )
    .pool_deposit(
      CSL.BigNum.from_str(protocolParameters.poolDeposit.toString())
    )
    .key_deposit(
      CSL.BigNum.from_str(protocolParameters.keyDeposit.toString())
    )
    .max_value_size(protocolParameters.maxValSize)
    .max_tx_size(protocolParameters.maxTxSize)
    .build();

  const txBuilder = CSL.TransactionBuilder.new(txBuilderConfig);

  // Add inputs
  for (const utxo of selectedUtxos) {
    const txInput = CSL.TransactionInput.new(
      CSL.TransactionHash.from_hex(utxo.txHash),
      utxo.outputIndex
    );

    // Build the value for this UTxO
    const value = CSL.Value.new(CSL.BigNum.from_str(utxo.lovelace.toString()));

    // Add native assets if present
    if (Object.keys(utxo.assets).length > 0) {
      const multiAsset = CSL.MultiAsset.new();

      for (const [assetId, amount] of Object.entries(utxo.assets)) {
        // Asset ID format: policyId (56 chars hex) + assetNameHex
        const policyId = assetId.slice(0, 56);
        const assetNameHex = assetId.slice(56);

        const scriptHash = CSL.ScriptHash.from_hex(policyId);
        const assetName = CSL.AssetName.new(Buffer.from(assetNameHex, "hex"));

        let assets = multiAsset.get(scriptHash);
        if (assets === undefined) {
          assets = CSL.Assets.new();
        }
        assets.insert(assetName, CSL.BigNum.from_str(amount.toString()));
        multiAsset.insert(scriptHash, assets);
      }

      value.set_multiasset(multiAsset);
    }

    // Use add_regular_input for simplicity
    txBuilder.add_regular_input(
      CSL.Address.from_bech32(utxo.address),
      txInput,
      value
    );
  }

  // Add outputs
  for (const output of outputs) {
    const outputAddress = CSL.Address.from_bech32(output.address);
    const outputValue = CSL.Value.new(
      CSL.BigNum.from_str(output.lovelace.toString())
    );

    // Add native assets to output if present
    if (output.assets !== undefined && Object.keys(output.assets).length > 0) {
      const multiAsset = CSL.MultiAsset.new();

      for (const [assetId, amount] of Object.entries(output.assets)) {
        const policyId = assetId.slice(0, 56);
        const assetNameHex = assetId.slice(56);

        const scriptHash = CSL.ScriptHash.from_hex(policyId);
        const assetName = CSL.AssetName.new(Buffer.from(assetNameHex, "hex"));

        let assets = multiAsset.get(scriptHash);
        if (assets === undefined) {
          assets = CSL.Assets.new();
        }
        assets.insert(assetName, CSL.BigNum.from_str(amount.toString()));
        multiAsset.insert(scriptHash, assets);
      }

      outputValue.set_multiasset(multiAsset);
    }

    // Calculate minimum ADA for this output
    const txOutput = CSL.TransactionOutput.new(outputAddress, outputValue);
    const minAda = CSL.min_ada_for_output(
      txOutput,
      CSL.DataCost.new_coins_per_byte(
        CSL.BigNum.from_str(protocolParameters.coinsPerUtxoByte.toString())
      )
    );

    // Ensure output has at least minimum ADA
    if (BigInt(minAda.to_str()) > output.lovelace) {
      throw new Error(
        `Output requires minimum ${minAda.to_str()} lovelace, but only ${output.lovelace} provided`
      );
    }

    txBuilder.add_output(txOutput);
  }

  // Add change output
  const changeAddr = CSL.Address.from_bech32(changeAddress);
  txBuilder.add_change_if_needed(changeAddr);

  // Build transaction body
  const txBody = txBuilder.build();

  // Create an empty witness set for now (we'll populate it with the signature)
  const emptyWitnesses = CSL.TransactionWitnessSet.new();

  // Create a FixedTransaction to get the transaction hash
  // FixedTransaction preserves the exact CBOR encoding
  const unsignedTx = CSL.FixedTransaction.new(
    txBody.to_bytes(),
    emptyWitnesses.to_bytes(),
    true // is_valid
  );

  // Get the transaction hash
  const txHashObj = unsignedTx.transaction_hash();
  const txHash = txHashObj.to_hex();
  const txBodyHashBytes = txHashObj.to_bytes();

  // Check if signer has signTx method for proper witness construction
  const extendedSigner = signer as ExtendedSigner;

  if (typeof extendedSigner.signTx === "function") {
    // Use the extended signTx method which returns a complete vkey witness
    const vkeyWitnessHex = await extendedSigner.signTx(
      txBodyHashBytes,
      request.chain
    );

    // Add the witness to the transaction
    unsignedTx.add_vkey_witness(
      CSL.Vkeywitness.from_bytes(Buffer.from(vkeyWitnessHex, "hex"))
    );
  } else {
    // Fallback: Build witness manually using basic sign() method
    // This requires more complex logic to construct the vkey witness
    throw new Error(
      "Signer must implement signTx() method for transaction signing.\n" +
        "The basic sign() method does not provide enough information to construct witnesses.\n" +
        "Use MemorySigner.signTx() or implement a custom signer with signTx()."
    );
  }

  // Serialize to CBOR
  const txCbor = unsignedTx.to_hex();

  return { txCbor, txHash };
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

/**
 * Validate a Cardano address format.
 *
 * @param address - Address to validate
 * @returns True if the address is a valid bech32 Cardano address
 */
export function isValidCardanoAddress(address: string): boolean {
  // Basic validation: Cardano addresses start with "addr" for mainnet
  // or "addr_test" for testnets
  if (!address.startsWith("addr")) {
    return false;
  }

  // Try to parse with CSL (sync validation without CSL)
  // For a quick check, just verify the format
  return /^addr[a-z0-9_]+[a-z0-9]+$/.test(address);
}

/**
 * Validate a Cardano address using CSL (more thorough validation).
 *
 * @param address - Address to validate
 * @returns Promise resolving to true if valid
 */
export async function validateCardanoAddress(address: string): Promise<boolean> {
  try {
    const CSL = await loadCSL();
    CSL.Address.from_bech32(address);
    return true;
  } catch {
    return false;
  }
}
