/**
 * Batch Accumulator - Merkle accumulator for batching PoI commitments.
 * Maintains a running Merkle tree of all committed items.
 */

import type {
  BatchItem,
  CommitmentDatum,
  BatchHistoryEntry,
} from "../types.js";

/**
 * Simple SHA-256 hash function using Web Crypto API.
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

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
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

export class BatchAccumulator {
  private items: BatchItem[] = [];
  private leafHashes: string[] = [];
  private batchHistory: BatchHistoryEntry[] = [];
  private accumulatorRoot: string = "";
  private commitCount = 0;

  constructor(initialState?: CommitmentDatum) {
    if (initialState) {
      this.accumulatorRoot = initialState.accumulatorRoot;
      this.commitCount = initialState.commitCount;
      this.batchHistory = [...initialState.batchHistory];
    }
  }

  /**
   * Add items to the current batch.
   */
  async addItems(items: BatchItem[]): Promise<void> {
    for (const item of items) {
      const leafHash = await this.hashItem(item);
      this.items.push(item);
      this.leafHashes.push(leafHash);
    }
  }

  /**
   * Get current batch size.
   */
  getBatchSize(): number {
    return this.items.length;
  }

  /**
   * Get items in the current batch.
   */
  getItems(): BatchItem[] {
    return [...this.items];
  }

  /**
   * Compute the batch root from current items.
   */
  async computeBatchRoot(): Promise<string> {
    if (this.leafHashes.length === 0) {
      return hashString("empty-batch", "poi-hydra:batch:v1");
    }
    return buildMerkleRoot(this.leafHashes);
  }

  /**
   * Commit the current batch and update the accumulator.
   * Returns the new accumulator state.
   */
  async commit(): Promise<CommitmentDatum> {
    const batchRoot = await this.computeBatchRoot();
    const timestamp = Date.now();
    const itemCount = this.items.length;

    // Update accumulator root by combining with batch root
    if (this.accumulatorRoot === "") {
      this.accumulatorRoot = batchRoot;
    } else {
      this.accumulatorRoot = await hashPair(this.accumulatorRoot, batchRoot);
    }

    // Record in history
    const historyEntry: BatchHistoryEntry = {
      batchRoot,
      timestamp,
      itemCount,
    };
    this.batchHistory.push(historyEntry);

    this.commitCount++;

    // Clear current batch
    this.items = [];
    this.leafHashes = [];

    return {
      accumulatorRoot: this.accumulatorRoot,
      commitCount: this.commitCount,
      latestBatchRoot: batchRoot,
      latestBatchTimestamp: timestamp,
      batchHistory: this.batchHistory,
    };
  }

  /**
   * Get current accumulator root.
   */
  getAccumulatorRoot(): string {
    return this.accumulatorRoot;
  }

  /**
   * Get total commit count.
   */
  getCommitCount(): number {
    return this.commitCount;
  }

  /**
   * Get batch history.
   */
  getBatchHistory(): BatchHistoryEntry[] {
    return [...this.batchHistory];
  }

  /**
   * Get current datum state for UTxO.
   */
  async getDatum(): Promise<CommitmentDatum> {
    const latestBatch = this.batchHistory[this.batchHistory.length - 1];
    return {
      accumulatorRoot: this.accumulatorRoot,
      commitCount: this.commitCount,
      latestBatchRoot: latestBatch?.batchRoot ?? "",
      latestBatchTimestamp: latestBatch?.timestamp ?? 0,
      batchHistory: this.batchHistory,
    };
  }

  /**
   * Verify an item is included in a specific batch.
   */
  async verifyInclusion(
    item: BatchItem,
    batchRoot: string,
    proof: string[]
  ): Promise<boolean> {
    let currentHash = await this.hashItem(item);

    for (const sibling of proof) {
      // Determine order by comparing hashes
      if (currentHash < sibling) {
        currentHash = await hashPair(currentHash, sibling);
      } else {
        currentHash = await hashPair(sibling, currentHash);
      }
    }

    return currentHash === batchRoot;
  }

  /**
   * Generate inclusion proof for an item.
   */
  async generateInclusionProof(itemIndex: number): Promise<string[]> {
    if (itemIndex < 0 || itemIndex >= this.leafHashes.length) {
      throw new Error(`Invalid item index: ${itemIndex}`);
    }

    const proof: string[] = [];
    let currentLevel = [...this.leafHashes];
    let currentIndex = itemIndex;

    while (currentLevel.length > 1) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;

      if (siblingIndex < currentLevel.length) {
        const sibling = currentLevel[siblingIndex];
        if (sibling) {
          proof.push(sibling);
        }
      }

      // Build next level
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1];
        if (left && right) {
          nextLevel.push(await hashPair(left, right));
        } else if (left) {
          nextLevel.push(left);
        }
      }

      currentLevel = nextLevel;
      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  /**
   * Reset the accumulator to initial state.
   */
  reset(): void {
    this.items = [];
    this.leafHashes = [];
    this.batchHistory = [];
    this.accumulatorRoot = "";
    this.commitCount = 0;
  }

  /**
   * Export state for persistence.
   */
  exportState(): {
    accumulatorRoot: string;
    commitCount: number;
    batchHistory: BatchHistoryEntry[];
    pendingItems: BatchItem[];
    pendingHashes: string[];
  } {
    return {
      accumulatorRoot: this.accumulatorRoot,
      commitCount: this.commitCount,
      batchHistory: [...this.batchHistory],
      pendingItems: [...this.items],
      pendingHashes: [...this.leafHashes],
    };
  }

  /**
   * Import state from persistence.
   */
  importState(state: {
    accumulatorRoot: string;
    commitCount: number;
    batchHistory: BatchHistoryEntry[];
    pendingItems?: BatchItem[];
    pendingHashes?: string[];
  }): void {
    this.accumulatorRoot = state.accumulatorRoot;
    this.commitCount = state.commitCount;
    this.batchHistory = [...state.batchHistory];
    this.items = state.pendingItems ? [...state.pendingItems] : [];
    this.leafHashes = state.pendingHashes ? [...state.pendingHashes] : [];
  }

  // === Private Methods ===

  private async hashItem(item: BatchItem): Promise<string> {
    const canonical = JSON.stringify({
      sessionId: item.sessionId,
      rootHash: item.rootHash,
      merkleRoot: item.merkleRoot,
      manifestHash: item.manifestHash,
      timestamp: item.timestamp,
    });
    return hashString(canonical, "poi-hydra:item:v1");
  }
}
