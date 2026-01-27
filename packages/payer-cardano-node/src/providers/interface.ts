/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-node/src/providers/interface.ts
 * @summary Cardano blockchain provider interface definitions.
 *
 * This file defines the abstract interfaces for interacting with Cardano blockchain
 * data providers. Implementations handle UTxO fetching, protocol parameters, and
 * transaction submission.
 *
 * Used by:
 * - BlockfrostProvider for Blockfrost API integration
 * - KoiosProvider for Koios API integration
 * - CardanoNodePayer for building and submitting transactions
 */

// ---------------------------------------------------------------------------
// UTxO Type
// ---------------------------------------------------------------------------

/**
 * Unspent transaction output representation.
 *
 * Represents a single UTxO that can be consumed in a transaction.
 * All amounts are represented as bigint to prevent precision loss.
 */
export interface UTxO {
  /** Transaction hash where this UTxO was created (64-character hex) */
  txHash: string;

  /** Output index within the transaction */
  outputIndex: number;

  /** Address that controls this UTxO (bech32 format) */
  address: string;

  /** ADA amount in lovelace (1 ADA = 1,000,000 lovelace) */
  lovelace: bigint;

  /**
   * Native assets (tokens) in this UTxO.
   * Keys are policy ID concatenated with asset name hex (e.g., "policyId.assetNameHex")
   * Values are amounts as bigint.
   */
  assets: Record<string, bigint>;

  /** Datum hash if this UTxO has a datum hash attached */
  datumHash?: string;

  /** Inline datum CBOR hex if this UTxO has an inline datum */
  datum?: string;

  /** Reference script CBOR hex if this UTxO contains a reference script */
  scriptRef?: string;
}

// ---------------------------------------------------------------------------
// Protocol Parameters
// ---------------------------------------------------------------------------

/**
 * Cardano protocol parameters required for transaction building.
 *
 * These parameters determine fees, limits, and deposit amounts
 * for various on-chain operations.
 */
export interface ProtocolParameters {
  /** Fee coefficient A (fee = A * tx_size + B) */
  minFeeA: number;

  /** Fee coefficient B (base fee) */
  minFeeB: number;

  /** Maximum transaction size in bytes */
  maxTxSize: number;

  /** Lovelace per UTxO byte (min-ada calculation) */
  coinsPerUtxoByte: number;

  /** Pool registration deposit in lovelace */
  poolDeposit: number;

  /** Key registration deposit in lovelace */
  keyDeposit: number;

  /** Maximum value size in bytes */
  maxValSize: number;

  /** Collateral percentage for script execution (100 = 100%) */
  collateralPercentage: number;

  /** Maximum number of collateral inputs */
  maxCollateralInputs: number;
}

// ---------------------------------------------------------------------------
// Provider Interface
// ---------------------------------------------------------------------------

/**
 * Cardano blockchain data provider interface.
 *
 * Implementations provide access to UTxOs, protocol parameters,
 * and transaction submission capabilities.
 */
export interface CardanoProvider {
  /**
   * Fetch all UTxOs for a given address.
   *
   * @param address - Bech32-encoded Cardano address
   * @returns Promise resolving to array of UTxOs
   * @throws If the address is invalid or provider request fails
   */
  getUtxos(address: string): Promise<UTxO[]>;

  /**
   * Fetch current protocol parameters.
   *
   * @returns Promise resolving to protocol parameters
   * @throws If provider request fails
   */
  getProtocolParameters(): Promise<ProtocolParameters>;

  /**
   * Submit a signed transaction to the network.
   *
   * @param txCbor - Hex-encoded CBOR of the signed transaction
   * @returns Promise resolving to the transaction hash
   * @throws If submission fails (e.g., validation error, network issue)
   */
  submitTx(txCbor: string): Promise<string>;

  /**
   * Wait for a transaction to be confirmed on-chain.
   *
   * @param txHash - Transaction hash to monitor (64-character hex)
   * @param timeout - Maximum time to wait in milliseconds (default: 120000)
   * @returns Promise resolving to true if confirmed, false if timeout
   */
  awaitTx(txHash: string, timeout?: number): Promise<boolean>;

  /**
   * Get the network ID for this provider.
   *
   * @returns "mainnet" or "preprod"
   */
  getNetworkId(): "mainnet" | "preprod";
}
