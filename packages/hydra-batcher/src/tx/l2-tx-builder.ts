/**
 * Location: packages/hydra-batcher/src/tx/l2-tx-builder.ts
 *
 * L2 Transaction Builder for Hydra Batcher.
 *
 * This module provides the L2TransactionBuilder class which constructs transactions
 * for updating commitment UTxOs in a Hydra head. L2 transactions in Hydra do not
 * require fees or TTL (time-to-live) since the head operates with instant finality.
 *
 * The builder creates transactions that:
 * - Consume the current commitment UTxO
 * - Produce a new commitment UTxO with updated datum (accumulator state)
 * - Serialize to CBOR hex for submission via the Hydra NewTx command
 *
 * Used by:
 * - batcher.ts: For building commitment update transactions
 * - head-manager.ts: For submitting transactions to the Hydra head
 */

import type {
  BatchItem,
  CommitmentDatum,
  HydraUtxo,
  L2Transaction,
  L2Output,
  UtxoValue,
} from "../types.js";

/**
 * Result of building an L2 transaction.
 */
export interface L2TransactionBuildResult {
  /** The built transaction */
  transaction: L2Transaction;
  /** CBOR hex string for Hydra NewTx command */
  cborHex: string;
  /** New datum to be placed in the output */
  newDatum: CommitmentDatum;
  /** Computed batch root from the items */
  batchRoot: string;
}

/**
 * Options for building a commitment transaction.
 */
export interface CommitmentTxOptions {
  /** Minimum lovelace to keep in the output (default: 2_000_000) */
  minLovelace?: bigint;
  /** Whether to trim batch history to last N entries (default: 100) */
  maxHistoryEntries?: number;
}

/**
 * Simple SHA-256 hash function using Web Crypto API or Node crypto.
 */
async function sha256(data: Uint8Array): Promise<string> {
  const crypto = globalThis.crypto ?? (await import("node:crypto")).webcrypto;
  const hashBuffer = await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hash a string with domain separation.
 */
async function hashString(str: string, domain: string): Promise<string> {
  const prefix = new TextEncoder().encode(`${domain}|`);
  const data = new TextEncoder().encode(str);
  const combined = new Uint8Array(prefix.length + data.length);
  combined.set(prefix, 0);
  combined.set(data, prefix.length);
  return sha256(combined);
}

/**
 * Convert hex string to bytes.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert bytes to hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hash two hashes together (Merkle node).
 */
async function hashPair(left: string, right: string): Promise<string> {
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);
  const combined = new Uint8Array(leftBytes.length + rightBytes.length);
  combined.set(leftBytes, 0);
  combined.set(rightBytes, leftBytes.length);
  return hashString(bytesToHex(combined), "poi-hydra:node:v1");
}

/**
 * Hash a batch item to create a leaf hash.
 */
async function hashItem(item: BatchItem): Promise<string> {
  const canonical = JSON.stringify({
    sessionId: item.sessionId,
    rootHash: item.rootHash,
    merkleRoot: item.merkleRoot,
    manifestHash: item.manifestHash,
    timestamp: item.timestamp,
  });
  return hashString(canonical, "poi-hydra:item:v1");
}

/**
 * Build Merkle root from leaf hashes.
 */
async function buildMerkleRoot(hashes: string[]): Promise<string> {
  if (hashes.length === 0) {
    return hashString("empty", "poi-hydra:merkle:v1");
  }

  if (hashes.length === 1) {
    const first = hashes[0];
    if (!first) {
      return hashString("empty", "poi-hydra:merkle:v1");
    }
    return first;
  }

  let currentLevel = hashes;

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1];

      if (left && right) {
        nextLevel.push(await hashPair(left, right));
      } else if (left) {
        // Odd number of elements - promote to next level
        nextLevel.push(left);
      }
    }

    currentLevel = nextLevel;
  }

  const root = currentLevel[0];
  if (!root) {
    return hashString("empty", "poi-hydra:merkle:v1");
  }
  return root;
}

/**
 * Compute the Merkle root for a batch of items.
 */
export async function computeBatchMerkleRoot(items: BatchItem[]): Promise<string> {
  if (items.length === 0) {
    return hashString("empty-batch", "poi-hydra:batch:v1");
  }

  const leafHashes = await Promise.all(items.map(item => hashItem(item)));
  return buildMerkleRoot(leafHashes);
}

/**
 * Generate a unique transaction ID based on inputs and outputs.
 * In production, this would be the Blake2b-256 hash of the transaction body.
 */
function generateTxId(inputs: string[], timestamp: number): string {
  // Mock implementation - in production would compute proper Cardano tx hash
  const inputStr = inputs.join(",");
  const combined = `${inputStr}|${timestamp}`;
  // Simple hash for now - would use Blake2b in production
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(64, "0").slice(0, 64);
}

/**
 * L2TransactionBuilder - Constructs L2 transactions for Hydra commitment updates.
 *
 * Hydra L2 transactions have unique characteristics:
 * - No transaction fees (handled by the head)
 * - No TTL/validity intervals (instant finality in the head)
 * - Must consume and produce UTxOs within the head's UTxO set
 *
 * @example
 * ```typescript
 * const builder = new L2TransactionBuilder();
 *
 * // Build a commitment update transaction
 * const result = await builder.buildCommitmentTx(
 *   items,
 *   currentDatum,
 *   currentUtxo
 * );
 *
 * // Get CBOR hex for Hydra NewTx command
 * const cborHex = result.cborHex;
 * ```
 */
export class L2TransactionBuilder {
  private transaction: L2Transaction | null = null;
  private newDatum: CommitmentDatum | null = null;
  private batchRoot: string = "";

  constructor() {}

  /**
   * Build a transaction that updates the commitment UTxO with new batch items.
   *
   * @param items - Batch items to commit
   * @param currentDatum - Current commitment datum state
   * @param currentUtxo - Current commitment UTxO to consume
   * @param options - Build options
   * @returns Build result containing transaction, CBOR hex, and new datum
   */
  async buildCommitmentTx(
    items: BatchItem[],
    currentDatum: CommitmentDatum,
    currentUtxo: HydraUtxo,
    options: CommitmentTxOptions = {}
  ): Promise<L2TransactionBuildResult> {
    const {
      minLovelace = BigInt(2_000_000),
      maxHistoryEntries = 100,
    } = options;

    // Compute the Merkle root of the batch items
    this.batchRoot = await computeBatchMerkleRoot(items);
    const timestamp = Date.now();

    // Compute new accumulator root by chaining with previous
    let newAccumulatorRoot: string;
    if (currentDatum.accumulatorRoot === "" || currentDatum.commitCount === 0) {
      newAccumulatorRoot = this.batchRoot;
    } else {
      newAccumulatorRoot = await hashPair(currentDatum.accumulatorRoot, this.batchRoot);
    }

    // Build new batch history (trimmed if necessary)
    const newHistoryEntry = {
      batchRoot: this.batchRoot,
      timestamp,
      itemCount: items.length,
    };

    let newBatchHistory = [...currentDatum.batchHistory, newHistoryEntry];
    if (newBatchHistory.length > maxHistoryEntries) {
      newBatchHistory = newBatchHistory.slice(-maxHistoryEntries);
    }

    // Create new datum
    this.newDatum = {
      accumulatorRoot: newAccumulatorRoot,
      commitCount: currentDatum.commitCount + 1,
      latestBatchRoot: this.batchRoot,
      latestBatchTimestamp: timestamp,
      batchHistory: newBatchHistory,
    };

    // Ensure output has minimum lovelace
    const outputValue: UtxoValue = {
      lovelace: currentUtxo.value.lovelace >= minLovelace
        ? currentUtxo.value.lovelace
        : minLovelace,
      ...(currentUtxo.value.assets && { assets: currentUtxo.value.assets }),
    };

    // Build output
    const output: L2Output = {
      address: currentUtxo.address,
      value: outputValue,
      datum: this.newDatum,
    };

    // Build transaction
    this.transaction = {
      txId: generateTxId([currentUtxo.txIn], timestamp),
      inputs: [currentUtxo.txIn],
      outputs: [output],
    };

    return {
      transaction: this.transaction,
      cborHex: this.toCborHex(),
      newDatum: this.newDatum,
      batchRoot: this.batchRoot,
    };
  }

  /**
   * Build an initial commitment transaction (when no UTxO exists yet).
   *
   * @param items - Initial batch items to commit
   * @param address - Address to send the commitment UTxO to
   * @param options - Build options
   * @returns Build result containing transaction, CBOR hex, and new datum
   */
  async buildInitialCommitmentTx(
    items: BatchItem[],
    address: string,
    options: CommitmentTxOptions = {}
  ): Promise<L2TransactionBuildResult> {
    const {
      minLovelace = BigInt(2_000_000),
    } = options;

    // Compute the Merkle root of the batch items
    this.batchRoot = await computeBatchMerkleRoot(items);
    const timestamp = Date.now();

    // For initial commitment, accumulator root is just the batch root
    const newHistoryEntry = {
      batchRoot: this.batchRoot,
      timestamp,
      itemCount: items.length,
    };

    // Create initial datum
    this.newDatum = {
      accumulatorRoot: this.batchRoot,
      commitCount: 1,
      latestBatchRoot: this.batchRoot,
      latestBatchTimestamp: timestamp,
      batchHistory: [newHistoryEntry],
    };

    // Build output with minimum lovelace
    const output: L2Output = {
      address,
      value: {
        lovelace: minLovelace,
      },
      datum: this.newDatum,
    };

    // Build transaction (no inputs for initial - would come from head's initial UTxOs)
    // In practice, would need to consume an existing UTxO to fund this
    this.transaction = {
      txId: generateTxId(["initial"], timestamp),
      inputs: [], // Would need funding input in production
      outputs: [output],
    };

    return {
      transaction: this.transaction,
      cborHex: this.toCborHex(),
      newDatum: this.newDatum,
      batchRoot: this.batchRoot,
    };
  }

  /**
   * Serialize the current transaction to CBOR hex format.
   *
   * This produces a format suitable for the Hydra NewTx command.
   * Note: This is a mock implementation - in production, would use
   * cardano-serialization-lib or similar for proper CBOR encoding.
   *
   * @returns CBOR hex string
   */
  toCborHex(): string {
    if (!this.transaction) {
      throw new Error("No transaction built. Call buildCommitmentTx or buildInitialCommitmentTx first.");
    }

    // Mock CBOR serialization
    // In production, would use cardano-serialization-lib:
    // 1. Create TransactionBody with inputs, outputs, no fee, no TTL
    // 2. Create Transaction with body and empty witness set
    // 3. Serialize to CBOR bytes
    // 4. Convert to hex

    const txBody = this.serializeTxBody();
    const witnessSet = this.serializeWitnessSet();
    const auxiliary = this.serializeAuxiliaryData();

    // CBOR array of [body, witness_set, is_valid, auxiliary_data]
    // 84 = array(4) in CBOR
    const cborPrefix = "84";
    const isValid = "f5"; // true in CBOR

    return cborPrefix + txBody + witnessSet + isValid + auxiliary;
  }

  /**
   * Get the last built transaction.
   */
  getTransaction(): L2Transaction | null {
    return this.transaction;
  }

  /**
   * Get the last computed datum.
   */
  getDatum(): CommitmentDatum | null {
    return this.newDatum;
  }

  /**
   * Get the last computed batch root.
   */
  getBatchRoot(): string {
    return this.batchRoot;
  }

  // === Private Serialization Methods (Mock Implementation) ===

  /**
   * Serialize transaction body to CBOR hex (mock).
   * Real implementation would encode:
   * - 0: set of inputs (transaction_id || index)
   * - 1: list of outputs (address, value, datum)
   * - 2: fee (0 for L2)
   * - 3: ttl (omitted for L2)
   */
  private serializeTxBody(): string {
    if (!this.transaction) return "a0";

    // Mock: Create a deterministic "CBOR" based on transaction data
    // In production, would properly encode according to Cardano CDDL spec

    const parts: string[] = [];

    // a4 = map(4) - transaction body map
    parts.push("a4");

    // 00 = key 0 (inputs)
    parts.push("00");
    // Encode inputs as a set
    const inputsHex = this.encodeInputs();
    parts.push(inputsHex);

    // 01 = key 1 (outputs)
    parts.push("01");
    // Encode outputs as a list
    const outputsHex = this.encodeOutputs();
    parts.push(outputsHex);

    // 02 = key 2 (fee) - 0 for L2
    parts.push("02");
    parts.push("00"); // 0 in CBOR

    // 07 = key 7 (auxiliary_data_hash) - optional, using for datum
    parts.push("07");
    const datumHex = this.encodeDatum();
    parts.push(datumHex);

    return parts.join("");
  }

  /**
   * Encode inputs to CBOR hex (mock).
   */
  private encodeInputs(): string {
    if (!this.transaction) return "80"; // empty array

    const inputs = this.transaction.inputs;
    if (inputs.length === 0) return "80";

    // d8 79 80 = set(0) in our mock encoding
    // Use array for simplicity
    const count = inputs.length;
    const prefix = count < 24 ? (0x80 + count).toString(16).padStart(2, "0") : "98" + count.toString(16).padStart(2, "0");

    const encodedInputs = inputs.map(input => {
      // Input format: txHash#index
      const [txHash, indexStr] = input.split("#");
      const index = parseInt(indexStr || "0", 10);
      // 82 = array(2)
      // 58 20 = bytes(32) for tx hash
      // Then the index as uint
      const txHashHex = (txHash || "").padStart(64, "0");
      const indexHex = index < 24 ? index.toString(16).padStart(2, "0") : "18" + index.toString(16).padStart(2, "0");
      return "82" + "5820" + txHashHex + indexHex;
    }).join("");

    return prefix + encodedInputs;
  }

  /**
   * Encode outputs to CBOR hex (mock).
   */
  private encodeOutputs(): string {
    if (!this.transaction) return "80"; // empty array

    const outputs = this.transaction.outputs;
    if (outputs.length === 0) return "80";

    const count = outputs.length;
    const prefix = count < 24 ? (0x80 + count).toString(16).padStart(2, "0") : "98" + count.toString(16).padStart(2, "0");

    const encodedOutputs = outputs.map(output => {
      // Post-Alonzo output format: map with address, value, optional datum
      // a3 = map(3) or a2 = map(2)
      const parts: string[] = [];
      const hasData = output.datum !== undefined;
      parts.push(hasData ? "a3" : "a2");

      // 00 = key 0 (address)
      parts.push("00");
      // Address as bytes - mock encoding
      const addressHex = this.encodeAddress(output.address);
      parts.push(addressHex);

      // 01 = key 1 (value)
      parts.push("01");
      const valueHex = this.encodeValue(output.value);
      parts.push(valueHex);

      // 02 = key 2 (datum) if present
      if (hasData) {
        parts.push("02");
        // a2 = map(2) for inline datum
        // 00 = tag for inline datum (vs datum hash)
        // 01 = the actual datum value
        parts.push("a2");
        parts.push("00"); // datum type (0 = inline)
        parts.push("01"); // datum kind
        // Encode datum as CBOR - simplified
        parts.push(this.encodeInlineDatum(output.datum));
      }

      return parts.join("");
    }).join("");

    return prefix + encodedOutputs;
  }

  /**
   * Encode address to CBOR hex (mock).
   */
  private encodeAddress(address: string): string {
    // In production, would properly decode bech32 address
    // For mock, just encode as bytes
    const bytes = new TextEncoder().encode(address);
    const len = bytes.length;
    const prefix = len < 24 ? (0x40 + len).toString(16).padStart(2, "0")
      : len < 256 ? "58" + len.toString(16).padStart(2, "0")
      : "59" + len.toString(16).padStart(4, "0");
    return prefix + bytesToHex(bytes);
  }

  /**
   * Encode value to CBOR hex (mock).
   */
  private encodeValue(value: UtxoValue): string {
    // If only lovelace, encode as uint
    if (!value.assets || Object.keys(value.assets).length === 0) {
      return this.encodeUint(value.lovelace);
    }

    // With assets, encode as [lovelace, multiasset_map]
    // 82 = array(2)
    return "82" + this.encodeUint(value.lovelace) + this.encodeMultiAsset(value.assets);
  }

  /**
   * Encode unsigned integer to CBOR hex.
   */
  private encodeUint(value: bigint): string {
    if (value < 24n) {
      return value.toString(16).padStart(2, "0");
    }
    if (value < 256n) {
      return "18" + value.toString(16).padStart(2, "0");
    }
    if (value < 65536n) {
      return "19" + value.toString(16).padStart(4, "0");
    }
    if (value < 4294967296n) {
      return "1a" + value.toString(16).padStart(8, "0");
    }
    return "1b" + value.toString(16).padStart(16, "0");
  }

  /**
   * Encode multi-asset map to CBOR hex (mock).
   */
  private encodeMultiAsset(assets: Record<string, bigint>): string {
    const entries = Object.entries(assets);
    if (entries.length === 0) return "a0"; // empty map

    // Simplified - just encode as a map
    const count = entries.length;
    const prefix = count < 24 ? (0xa0 + count).toString(16).padStart(2, "0") : "b8" + count.toString(16).padStart(2, "0");

    const encodedEntries = entries.map(([key, val]) => {
      // Key is policyId.assetName, value is amount
      const keyBytes = new TextEncoder().encode(key);
      const keyHex = "58" + keyBytes.length.toString(16).padStart(2, "0") + bytesToHex(keyBytes);
      return keyHex + this.encodeUint(val);
    }).join("");

    return prefix + encodedEntries;
  }

  /**
   * Encode inline datum to CBOR hex (mock).
   */
  private encodeInlineDatum(datum: unknown): string {
    // Encode the datum as JSON then as CBOR bytes
    // In production, would use proper Plutus data encoding
    const json = JSON.stringify(datum);
    const bytes = new TextEncoder().encode(json);
    const len = bytes.length;
    const prefix = len < 24 ? (0x40 + len).toString(16).padStart(2, "0")
      : len < 256 ? "58" + len.toString(16).padStart(2, "0")
      : "59" + len.toString(16).padStart(4, "0");
    return prefix + bytesToHex(bytes);
  }

  /**
   * Encode datum for auxiliary data (mock).
   */
  private encodeDatum(): string {
    if (!this.newDatum) return "f6"; // null

    const json = JSON.stringify(this.newDatum);
    const bytes = new TextEncoder().encode(json);
    const len = bytes.length;
    const prefix = len < 24 ? (0x40 + len).toString(16).padStart(2, "0")
      : len < 256 ? "58" + len.toString(16).padStart(2, "0")
      : "59" + len.toString(16).padStart(4, "0");
    return prefix + bytesToHex(bytes);
  }

  /**
   * Serialize witness set to CBOR hex (mock).
   * For L2 transactions, witness set is typically empty or minimal.
   */
  private serializeWitnessSet(): string {
    // a0 = empty map
    return "a0";
  }

  /**
   * Serialize auxiliary data to CBOR hex (mock).
   */
  private serializeAuxiliaryData(): string {
    // f6 = null (no auxiliary data)
    return "f6";
  }
}

/**
 * Convenience function to build a commitment transaction.
 */
export async function buildCommitmentTransaction(
  items: BatchItem[],
  currentDatum: CommitmentDatum,
  currentUtxo: HydraUtxo,
  options?: CommitmentTxOptions
): Promise<L2TransactionBuildResult> {
  const builder = new L2TransactionBuilder();
  return builder.buildCommitmentTx(items, currentDatum, currentUtxo, options);
}

/**
 * Convenience function to build an initial commitment transaction.
 */
export async function buildInitialCommitmentTransaction(
  items: BatchItem[],
  address: string,
  options?: CommitmentTxOptions
): Promise<L2TransactionBuildResult> {
  const builder = new L2TransactionBuilder();
  return builder.buildInitialCommitmentTx(items, address, options);
}
