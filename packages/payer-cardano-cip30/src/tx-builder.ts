/**
 * @summary Transaction building utilities for Cardano payments using MeshJS.
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
 * - @meshsdk/core (peer dependency) for transaction construction
 */

import { Transaction, BrowserWallet } from "@meshsdk/core";
import type { Asset, Recipient } from "@meshsdk/core";
import type { PaymentRequest } from "@fluxpointstudios/poi-sdk-core";

// ---------------------------------------------------------------------------
// Configuration Types
// ---------------------------------------------------------------------------

/**
 * Configuration for the transaction builder.
 */
export interface TxBuilderConfig {
  /** BrowserWallet instance for UTxO fetching and signing */
  wallet: BrowserWallet;
}

/**
 * Options for building a payment transaction.
 */
export interface BuildPaymentOptions {
  /** Optional metadata to attach to the transaction (key: label number, value: metadata content) */
  metadata?: Record<number, unknown>;
  /** Optional TTL (time to live) in slots from current slot */
  ttlSlots?: number;
  /** Change address override (defaults to wallet change address) */
  changeAddress?: string;
}

/**
 * Represents a payment output for transaction building.
 */
export interface PaymentOutput {
  /** Recipient address (bech32) */
  address: string;
  /** Asset identifier (ADA or policyId.assetName) */
  asset: string;
  /** Amount in atomic units */
  amount: bigint;
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

  // Assume it's already in the correct format (policyId + assetName)
  return { policyId: asset.slice(0, 56), assetName: asset.slice(56) };
}

/**
 * Convert asset identifier to MeshJS unit format.
 *
 * MeshJS uses the format: policyId + assetNameHex (concatenated, no separator).
 * For ADA, use "lovelace".
 *
 * @param asset - Asset identifier in any supported format
 * @returns MeshJS unit string, or "lovelace" for ADA
 */
export function toMeshUnit(asset: string): string {
  if (isAdaAsset(asset)) {
    return "lovelace";
  }

  const parsed = parseAssetId(asset);
  if (!parsed) {
    return "lovelace";
  }

  return parsed.policyId + parsed.assetName;
}

/**
 * Convert asset identifier to MeshJS Asset format.
 *
 * @param asset - Asset identifier
 * @param amount - Amount in atomic units
 * @returns MeshJS Asset object
 */
export function toMeshAsset(asset: string, amount: bigint): Asset {
  const unit = toMeshUnit(asset);
  return {
    unit,
    quantity: amount.toString(),
  };
}

// Alias for backward compatibility
export const toLucidUnit = toMeshUnit;

// ---------------------------------------------------------------------------
// Transaction Building
// ---------------------------------------------------------------------------

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
 * Calculate required amounts per asset from a payment request.
 * Returns a map of asset -> total required amount.
 *
 * @param request - Payment request
 * @returns Map of asset identifier to required amount
 */
export function calculateRequiredAmounts(request: PaymentRequest): Map<string, bigint> {
  const amounts = new Map<string, bigint>();
  const primaryAsset = toMeshUnit(request.asset);
  const primaryAmount = BigInt(request.amountUnits);

  // Start with primary amount
  amounts.set(primaryAsset, primaryAmount);

  // Add split amounts
  if (request.splits && request.splits.outputs.length > 0) {
    for (const split of request.splits.outputs) {
      const splitAsset = toMeshUnit(split.asset ?? request.asset);
      const splitAmount = BigInt(split.amountUnits);
      const existing = amounts.get(splitAsset) ?? 0n;

      if (request.splits.mode === "additional") {
        // Additional mode: add split amounts on top
        amounts.set(splitAsset, existing + splitAmount);
      }
      // Inclusive mode: splits are already part of primary, no need to add
    }
  }

  return amounts;
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
 * Collect all payment outputs from a payment request.
 *
 * @param request - Payment request
 * @returns Array of payment outputs
 */
export function collectPaymentOutputs(request: PaymentRequest): PaymentOutput[] {
  const outputs: PaymentOutput[] = [];
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
        outputs.push({
          address: request.payTo,
          asset: primaryAsset,
          amount: primaryNet,
        });
      }
    } else {
      // Additional mode: primary recipient gets full amountUnits
      outputs.push({
        address: request.payTo,
        asset: primaryAsset,
        amount: primaryAmount,
      });
    }

    // Add split outputs
    for (const split of request.splits.outputs) {
      outputs.push({
        address: split.to,
        asset: split.asset ?? primaryAsset,
        amount: BigInt(split.amountUnits),
      });
    }
  } else {
    // No splits - simple single-output payment
    outputs.push({
      address: request.payTo,
      asset: primaryAsset,
      amount: primaryAmount,
    });
  }

  return outputs;
}

/**
 * Build a payment transaction from a PaymentRequest using MeshJS.
 *
 * This function constructs a Cardano transaction that:
 * 1. Sends the primary amount to the primary recipient (payTo)
 * 2. Optionally includes split outputs to additional recipients
 * 3. Handles both inclusive and additional split modes
 *
 * @param wallet - MeshJS BrowserWallet instance
 * @param request - Payment request specifying recipients and amounts
 * @param options - Optional build parameters
 * @returns Promise resolving to hex-encoded unsigned transaction
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
 * const unsignedTx = await buildPaymentTx(wallet, request);
 * const signedTx = await wallet.signTx(unsignedTx);
 * const txHash = await wallet.submitTx(signedTx);
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
  wallet: BrowserWallet,
  request: PaymentRequest,
  _options?: BuildPaymentOptions
): Promise<string> {
  // Validate the request
  validatePaymentRequest(request);

  // Collect all payment outputs
  const outputs = collectPaymentOutputs(request);

  // Create a Transaction instance with the wallet as initiator
  const tx = new Transaction({ initiator: wallet });

  // Add outputs to the transaction
  for (const output of outputs) {
    const recipient: Recipient = { address: output.address };
    const assets: Asset[] = [toMeshAsset(output.asset, output.amount)];
    tx.sendAssets(recipient, assets);
  }

  // Build the transaction (handles coin selection and fee calculation)
  const unsignedTx = await tx.build();

  return unsignedTx;
}

/**
 * Build a multi-output transaction for batch payments.
 *
 * This is useful when you need to send to multiple recipients
 * in a single transaction without the split semantics.
 *
 * @param wallet - MeshJS BrowserWallet instance
 * @param outputs - Array of payment outputs
 * @param _options - Optional build parameters
 * @returns Promise resolving to hex-encoded unsigned transaction
 */
export async function buildBatchPaymentTx(
  wallet: BrowserWallet,
  outputs: Array<{ to: string; asset: string; amount: bigint }>,
  _options?: BuildPaymentOptions
): Promise<string> {
  if (outputs.length === 0) {
    throw new Error("At least one output is required");
  }

  // Filter out zero or negative amounts
  const validOutputs = outputs.filter((o) => o.amount > 0n);

  if (validOutputs.length === 0) {
    throw new Error("At least one output with positive amount is required");
  }

  // Create a Transaction instance with the wallet as initiator
  const tx = new Transaction({ initiator: wallet });

  // Add outputs to the transaction
  for (const output of validOutputs) {
    const recipient: Recipient = { address: output.to };
    const assets: Asset[] = [toMeshAsset(output.asset, output.amount)];
    tx.sendAssets(recipient, assets);
  }

  // Build the transaction
  const unsignedTx = await tx.build();

  return unsignedTx;
}
