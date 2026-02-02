/**
 * Arweave Storage Adapter.
 * Stores data permanently on the Arweave network.
 */

import type {
  StorageAdapter,
  StorageRef,
  StorableManifest,
  ArweaveAdapterConfig,
  ArweaveWallet,
} from "../../types.js";
import { StorageError, StorageException } from "../../types.js";
import { sha256 } from "../../utils/content-addressing.js";

/**
 * Minimal Arweave client interface.
 */
interface ArweaveClient {
  createTransaction(
    attrs: { data: Uint8Array },
    key: ArweaveWallet
  ): Promise<ArweaveTransaction>;
  transactions: {
    sign(tx: ArweaveTransaction, key: ArweaveWallet): Promise<void>;
    post(tx: ArweaveTransaction): Promise<{ status: number }>;
    getStatus(id: string): Promise<{ status: number; confirmed: { block_height: number } | null }>;
    getData(id: string, options?: { decode: boolean }): Promise<Uint8Array | string>;
  };
}

interface ArweaveTransaction {
  id: string;
  addTag(name: string, value: string): void;
}

/**
 * Storage adapter for Arweave permanent storage.
 */
export class ArweaveAdapter implements StorageAdapter {
  readonly type = "arweave" as const;
  private readonly gateway: string;
  private readonly wallet: ArweaveWallet | undefined;
  private readonly timeoutMs: number;

  private arweaveClient: ArweaveClient | undefined;

  constructor(config: ArweaveAdapterConfig) {
    this.gateway = config.gateway ?? "https://arweave.net";
    this.wallet = config.wallet;
    this.timeoutMs = config.timeoutMs ?? 60000;
  }

  /**
   * Store data on Arweave.
   */
  async store(data: Uint8Array): Promise<StorageRef> {
    if (!this.wallet) {
      throw new StorageException(
        StorageError.INVALID_CONFIG,
        "Arweave wallet required for storing data"
      );
    }

    const hash = sha256(data, "chunk");
    const txId = await this.uploadData(data, [
      { name: "Content-Type", value: "application/octet-stream" },
      { name: "poi-hash", value: hash },
    ]);

    return {
      type: "arweave",
      uri: `ar://${txId}`,
      hash,
      size: data.length,
    };
  }

  /**
   * Store a manifest on Arweave.
   */
  async storeManifest(manifest: StorableManifest): Promise<StorageRef> {
    if (!this.wallet) {
      throw new StorageException(
        StorageError.INVALID_CONFIG,
        "Arweave wallet required for storing data"
      );
    }

    const json = JSON.stringify(manifest, null, 2);
    const data = new TextEncoder().encode(json);
    const hash = manifest.manifestHash ?? sha256(data, "manifest");

    const txId = await this.uploadData(data, [
      { name: "Content-Type", value: "application/json" },
      { name: "poi-hash", value: hash },
      { name: "poi-session", value: manifest.sessionId },
    ]);

    return {
      type: "arweave",
      uri: `ar://${txId}`,
      hash,
      size: data.length,
    };
  }

  /**
   * Fetch data from Arweave.
   */
  async fetch(ref: StorageRef): Promise<Uint8Array> {
    const txId = this.extractTxId(ref.uri);

    try {
      // Try gateway first for faster access
      const response = await fetch(`${this.gateway}/${txId}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Gateway fetch failed: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (error) {
      // Fall back to Arweave client
      try {
        const client = await this.getArweaveClient();
        const data = await client.transactions.getData(txId, { decode: true });

        if (typeof data === "string") {
          return new TextEncoder().encode(data);
        }
        return data;
      } catch (clientError) {
        throw new StorageException(
          StorageError.FETCH_FAILED,
          `Failed to fetch from Arweave: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined
        );
      }
    }
  }

  /**
   * Fetch a manifest from Arweave.
   */
  async fetchManifest(ref: StorageRef): Promise<StorableManifest> {
    const data = await this.fetch(ref);
    const json = new TextDecoder().decode(data);

    try {
      return JSON.parse(json) as StorableManifest;
    } catch (error) {
      throw new StorageException(
        StorageError.FETCH_FAILED,
        "Failed to parse manifest JSON",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Verify data integrity.
   */
  async verify(ref: StorageRef): Promise<boolean> {
    try {
      const data = await this.fetch(ref);
      const hash = sha256(data, "chunk");
      return hash === ref.hash;
    } catch {
      return false;
    }
  }

  /**
   * Check if a transaction is confirmed.
   */
  async isConfirmed(ref: StorageRef): Promise<boolean> {
    const txId = this.extractTxId(ref.uri);

    try {
      const client = await this.getArweaveClient();
      const status = await client.transactions.getStatus(txId);
      return status.confirmed !== null;
    } catch {
      return false;
    }
  }

  /**
   * Get the gateway URL for a reference.
   */
  getGatewayUrl(ref: StorageRef): string {
    const txId = this.extractTxId(ref.uri);
    return `${this.gateway}/${txId}`;
  }

  // === Private Methods ===

  private async getArweaveClient(): Promise<ArweaveClient> {
    if (this.arweaveClient) {
      return this.arweaveClient;
    }

    try {
      const ArweaveLib = await import("arweave");
      const Arweave = ArweaveLib.default;

      const gatewayUrl = new URL(this.gateway);
      this.arweaveClient = Arweave.init({
        host: gatewayUrl.hostname,
        port: gatewayUrl.port ? parseInt(gatewayUrl.port, 10) : 443,
        protocol: gatewayUrl.protocol.replace(":", ""),
      }) as unknown as ArweaveClient;

      return this.arweaveClient;
    } catch (error) {
      throw new StorageException(
        StorageError.INVALID_CONFIG,
        "Arweave library not available. Install arweave to use Arweave adapter.",
        error instanceof Error ? error : undefined
      );
    }
  }

  private async uploadData(
    data: Uint8Array,
    tags: Array<{ name: string; value: string }>
  ): Promise<string> {
    if (!this.wallet) {
      throw new StorageException(
        StorageError.INVALID_CONFIG,
        "Arweave wallet required"
      );
    }

    const client = await this.getArweaveClient();

    try {
      const tx = await client.createTransaction({ data }, this.wallet);

      for (const tag of tags) {
        tx.addTag(tag.name, tag.value);
      }

      await client.transactions.sign(tx, this.wallet);
      const response = await client.transactions.post(tx);

      if (response.status !== 200 && response.status !== 202) {
        throw new Error(`Transaction post failed: ${response.status}`);
      }

      return tx.id;
    } catch (error) {
      throw new StorageException(
        StorageError.STORE_FAILED,
        `Arweave upload failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  private extractTxId(uri: string): string {
    // ar://txid
    if (uri.startsWith("ar://")) {
      return uri.slice(5);
    }

    // https://arweave.net/txid
    const match = uri.match(/arweave\.net\/(\w+)/);
    if (match?.[1]) {
      return match[1];
    }

    return uri;
  }
}

/**
 * Create an Arweave storage adapter.
 */
export function createArweaveAdapter(config: ArweaveAdapterConfig = {}): ArweaveAdapter {
  return new ArweaveAdapter(config);
}
