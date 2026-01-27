/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-cip30/src/tx-builder.ts
 * @summary Transaction building utilities for Cardano payments using Lucid.
 *
 * This file provides functions for constructing multi-output Cardano transactions
 * that support split payments (multiple recipients in a single transaction).
 *
 * Split modes:
 * - "inclusive": splits are subtracted from amountUnits (total paid = amountUnits)
 * - "additional": splits are added on top of amountUnits (total paid = amountUnits + splits)
 *
 * Used by:
 * - cip30-payer.ts for building payment transactions
 *
 * Dependencies:
 * - lucid-cardano (peer dependency) for transaction construction
 */

import type { Lucid, Tx, TxComplete } from "lucid-cardano";
import type { PaymentRequest } from "@poi-sdk/core";

// ---------------------------------------------------------------------------
// Configuration Types
// ---------------------------------------------------------------------------

/**
 * Configuration for the transaction builder.
 */
export interface TxBuilderConfig {
  /** Lucid instance configured with wallet and network */
  lucid: Lucid;
}

/**
 * Options for building a payment transaction.
 */
export interface BuildPaymentOptions {
  /** Optional metadata to attach to the transaction */
  metadata?: Record<number, unknown>;
  /** Optional TTL (time to live) in slots from current slot */
  ttlSlots?: number;
}

// ---------------------------------------------------------------------------
// Asset Helpers
// ---------------------------------------------------------------------------

/**
 * Check if an asset identifier represents ADA (the native asset).
 *
 * @param asset - Asset identifier to check
 * @returns true if asset is ADA/lovelace
 */
export function isAdaAsset(asset: string): boolean {
  const normalized = asset.toLowerCase();
  return normalized === "ada" || normalized === "lovelace" || normalized === "";
}

/**
 * Parse a native token asset identifier.
 *
 * Cardano native tokens are identified by policyId + assetName (hex).
 * Common formats:
 * - "policyId.assetNameHex" (dot-separated)
 * - "policyIdassetNameHex" (concatenated, 56 char policy + asset)
 *
 * @param asset - Asset identifier string
 * @returns Object with policyId and assetName, or null if ADA
 */
export function parseAssetId(asset: string): { policyId: string; assetName: string } | null {
  if (isAdaAsset(asset)) {
    return null;
  }

  // Check for dot-separated format (policyId.assetName)
  if (asset.includes(".")) {
    const [policyId, assetName] = asset.split(".", 2);
    if (policyId && policyId.length === 56) {
      return { policyId, assetName: assetName ?? "" };
    }
  }

  // Check for concatenated format (policyId is always 56 hex chars)
  if (asset.length >= 56 && /^[0-9a-fA-F]+$/.test(asset)) {
    return {
      policyId: asset.slice(0, 56),
      assetName: asset.slice(56),
    };
  }

  // Assume it's already in the correct Lucid format (policyId + assetName)
  return { policyId: asset.slice(0, 56), assetName: asset.slice(56) };
}

/**
 * Convert asset identifier to Lucid unit format.
 *
 * Lucid uses the format: policyId + assetNameHex (concatenated, no separator).
 *
 * @param asset - Asset identifier in any supported format
 * @returns Lucid unit string, or "lovelace" for ADA
 */
export function toLucidUnit(asset: string): string {
  if (isAdaAsset(asset)) {
    return "lovelace";
  }

  const parsed = parseAssetId(asset);
  if (!parsed) {
    return "lovelace";
  }

  return parsed.policyId + parsed.assetName;
}

// ---------------------------------------------------------------------------
// Transaction Building
// ---------------------------------------------------------------------------

/**
 * Add a payment output to a transaction.
 *
 * @param tx - Lucid transaction builder
 * @param to - Recipient address (bech32)
 * @param amount - Amount in atomic units
 * @param asset - Asset identifier
 * @returns Updated transaction builder
 */
function addPaymentOutput(tx: Tx, to: string, amount: bigint, asset: string): Tx {
  if (amount <= 0n) {
    // Skip zero or negative amounts
    return tx;
  }

  const unit = toLucidUnit(asset);

  if (unit === "lovelace") {
    return tx.payToAddress(to, { lovelace: amount });
  } else {
    // For native tokens, we need to include minimum ADA
    // Lucid handles this automatically with payToAddress
    return tx.payToAddress(to, { [unit]: amount });
  }
}

/**
 * Calculate the total amount including all split outputs.
 *
 * @param request - Payment request
 * @returns Total amount that will be sent
 */
export function calculateTotalAmount(request: PaymentRequest): bigint {
  const primaryAmount = BigInt(request.amountUnits);

  if (!request.splits || request.splits.outputs.length === 0) {
    return primaryAmount;
  }

  const splitTotal = request.splits.outputs.reduce(
    (sum, split) => sum + BigInt(split.amountUnits),
    0n
  );

  if (request.splits.mode === "inclusive") {
    // Splits are part of the primary amount
    return primaryAmount;
  } else {
    // mode === "additional" - splits are added on top
    return primaryAmount + splitTotal;
  }
}

/**
 * Validate a payment request before building.
 *
 * @param request - Payment request to validate
 * @throws Error if request is invalid
 */
function validatePaymentRequest(request: PaymentRequest): void {
  // Validate primary amount
  const primaryAmount = BigInt(request.amountUnits);
  if (primaryAmount <= 0n) {
    throw new Error("Payment amount must be positive");
  }

  // Validate primary recipient
  if (!request.payTo || request.payTo.trim() === "") {
    throw new Error("Payment recipient (payTo) is required");
  }

  // Validate splits if present
  if (request.splits && request.splits.outputs.length > 0) {
    const splitTotal = request.splits.outputs.reduce(
      (sum, split) => sum + BigInt(split.amountUnits),
      0n
    );

    // For inclusive mode, splits cannot exceed primary amount
    if (request.splits.mode === "inclusive") {
      if (splitTotal > primaryAmount) {
        throw new Error(
          `Split total (${splitTotal.toString()}) exceeds payment amount (${primaryAmount.toString()}) in inclusive mode`
        );
      }

      if (splitTotal === primaryAmount) {
        throw new Error(
          "Split total equals payment amount - primary recipient would receive nothing"
        );
      }
    }

    // Validate each split output
    for (const split of request.splits.outputs) {
      if (!split.to || split.to.trim() === "") {
        throw new Error("Split output recipient (to) is required");
      }

      const splitAmount = BigInt(split.amountUnits);
      if (splitAmount <= 0n) {
        throw new Error("Split output amount must be positive");
      }
    }
  }
}

/**
 * Build a payment transaction from a PaymentRequest.
 *
 * This function constructs a Cardano transaction that:
 * 1. Sends the primary amount to the primary recipient (payTo)
 * 2. Optionally includes split outputs to additional recipients
 * 3. Handles both inclusive and additional split modes
 *
 * @param lucid - Lucid instance with wallet selected
 * @param request - Payment request specifying recipients and amounts
 * @param options - Optional build parameters
 * @returns Promise resolving to a complete transaction ready for signing
 * @throws Error if request is invalid or transaction cannot be built
 *
 * @example
 * // Simple payment
 * const request: PaymentRequest = {
 *   protocol: "flux",
 *   chain: "cardano:mainnet",
 *   asset: "ADA",
 *   amountUnits: "5000000", // 5 ADA
 *   payTo: "addr1...",
 * };
 * const tx = await buildPaymentTx(lucid, request);
 * const signed = await tx.sign().complete();
 * const txHash = await signed.submit();
 *
 * @example
 * // Payment with inclusive splits
 * const request: PaymentRequest = {
 *   protocol: "flux",
 *   chain: "cardano:mainnet",
 *   asset: "ADA",
 *   amountUnits: "10000000", // 10 ADA total
 *   payTo: "addr1_merchant...",
 *   splits: {
 *     mode: "inclusive",
 *     outputs: [
 *       { role: "platform", to: "addr1_platform...", amountUnits: "500000" }, // 0.5 ADA
 *     ],
 *   },
 * };
 * // Merchant receives 9.5 ADA, platform receives 0.5 ADA
 */
export async function buildPaymentTx(
  lucid: Lucid,
  request: PaymentRequest,
  options?: BuildPaymentOptions
): Promise<TxComplete> {
  // Validate the request
  validatePaymentRequest(request);

  // Start building the transaction
  let tx = lucid.newTx();

  const primaryAmount = BigInt(request.amountUnits);
  const primaryAsset = request.asset;

  // Handle splits
  if (request.splits && request.splits.outputs.length > 0) {
    const splitTotal = request.splits.outputs.reduce(
      (sum, split) => sum + BigInt(split.amountUnits),
      0n
    );

    if (request.splits.mode === "inclusive") {
      // Inclusive mode: primary recipient gets amountUnits minus splits
      const primaryNet = primaryAmount - splitTotal;

      if (primaryNet > 0n) {
        tx = addPaymentOutput(tx, request.payTo, primaryNet, primaryAsset);
      }
    } else {
      // Additional mode: primary recipient gets full amountUnits
      tx = addPaymentOutput(tx, request.payTo, primaryAmount, primaryAsset);
    }

    // Add split outputs
    for (const split of request.splits.outputs) {
      const splitAsset = split.asset ?? primaryAsset;
      tx = addPaymentOutput(tx, split.to, BigInt(split.amountUnits), splitAsset);
    }
  } else {
    // No splits - simple single-output payment
    tx = addPaymentOutput(tx, request.payTo, primaryAmount, primaryAsset);
  }

  // Add metadata if provided
  if (options?.metadata) {
    for (const [label, data] of Object.entries(options.metadata)) {
      tx = tx.attachMetadata(parseInt(label, 10), data);
    }
  }

  // Set TTL if provided
  if (options?.ttlSlots) {
    const currentSlot = lucid.currentSlot();
    tx = tx.validTo(currentSlot + options.ttlSlots);
  }

  // Complete the transaction (coin selection, fee calculation)
  return tx.complete();
}

/**
 * Build a multi-output transaction for batch payments.
 *
 * This is useful when you need to send to multiple recipients
 * in a single transaction without the split semantics.
 *
 * @param lucid - Lucid instance with wallet selected
 * @param outputs - Array of payment outputs
 * @param options - Optional build parameters
 * @returns Promise resolving to a complete transaction
 */
export async function buildBatchPaymentTx(
  lucid: Lucid,
  outputs: Array<{ to: string; asset: string; amount: bigint }>,
  options?: BuildPaymentOptions
): Promise<TxComplete> {
  if (outputs.length === 0) {
    throw new Error("At least one output is required");
  }

  let tx = lucid.newTx();

  for (const output of outputs) {
    tx = addPaymentOutput(tx, output.to, output.amount, output.asset);
  }

  if (options?.metadata) {
    for (const [label, data] of Object.entries(options.metadata)) {
      tx = tx.attachMetadata(parseInt(label, 10), data);
    }
  }

  if (options?.ttlSlots) {
    const currentSlot = lucid.currentSlot();
    tx = tx.validTo(currentSlot + options.ttlSlots);
  }

  return tx.complete();
}
