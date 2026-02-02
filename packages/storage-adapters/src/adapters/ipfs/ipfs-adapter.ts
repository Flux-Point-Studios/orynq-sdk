/**
 * IPFS Storage Adapter.
 * Stores data on IPFS with optional pinning service integration.
 */

import type {
  StorageAdapter,
  StorageRef,
  StorableManifest,
  IpfsAdapterConfig,
} from "../../types.js";
import { StorageError, StorageException } from "../../types.js";
import { sha256 } from "../../utils/content-addressing.js";
import { PinningService, createPinningService } from "./pinning-service.js";

/**
 * IPFS Add Response
 */
interface IpfsAddResponse {
  Hash: string;
  Size: string;
  Name?: string;
}

/**
 * Storage adapter for IPFS.
 */
export class IpfsAdapter implements StorageAdapter {
  readonly type = "ipfs" as const;
  private readonly gateway: string;
  private readonly apiEndpoint: string | undefined;
  private readonly timeoutMs: number;
  private readonly pinningService: PinningService | undefined;

  constructor(config: IpfsAdapterConfig) {
    this.gateway = config.gateway.replace(/\/$/, "");
    this.apiEndpoint = config.apiEndpoint?.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 30000;

    if (config.pinningService) {
      this.pinningService = createPinningService(config.pinningService);
    }
  }

  /**
   * Store data on IPFS.
   */
  async store(data: Uint8Array): Promise<StorageRef> {
    const cid = await this.addToIpfs(data);
    const hash = sha256(data, "chunk");

    return {
      type: "ipfs",
      uri: `ipfs://${cid}`,
      hash,
      size: data.length,
    };
  }

  /**
   * Store a manifest on IPFS.
   */
  async storeManifest(manifest: StorableManifest): Promise<StorageRef> {
    const json = JSON.stringify(manifest, null, 2);
    const data = new TextEncoder().encode(json);
    const cid = await this.addToIpfs(data, `${manifest.sessionId}.json`);
    const hash = manifest.manifestHash ?? sha256(data, "manifest");

    return {
      type: "ipfs",
      uri: `ipfs://${cid}`,
      hash,
      size: data.length,
    };
  }

  /**
   * Fetch data from IPFS.
   */
  async fetch(ref: StorageRef): Promise<Uint8Array> {
    const cid = this.extractCid(ref.uri);

    try {
      const response = await fetch(`${this.gateway}/ipfs/${cid}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw new StorageException(
          StorageError.FETCH_FAILED,
          `Failed to fetch from IPFS: ${response.status} ${response.statusText}`
        );
      }

      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (error) {
      if (error instanceof StorageException) throw error;
      throw new StorageException(
        StorageError.FETCH_FAILED,
        `Failed to fetch from IPFS: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Fetch a manifest from IPFS.
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
   * Pin data on IPFS (via pinning service if configured).
   */
  async pin(ref: StorageRef): Promise<void> {
    const cid = this.extractCid(ref.uri);

    if (this.pinningService) {
      await this.pinningService.pin(cid);
      return;
    }

    // Pin via local IPFS node
    if (this.apiEndpoint) {
      try {
        const response = await fetch(
          `${this.apiEndpoint}/api/v0/pin/add?arg=${cid}`,
          {
            method: "POST",
            signal: AbortSignal.timeout(this.timeoutMs),
          }
        );

        if (!response.ok) {
          throw new Error(`Pin failed: ${response.status}`);
        }
      } catch (error) {
        throw new StorageException(
          StorageError.PIN_FAILED,
          `Failed to pin CID ${cid}`,
          error instanceof Error ? error : undefined
        );
      }
    }
  }

  /**
   * Get the gateway URL for a reference.
   */
  getGatewayUrl(ref: StorageRef): string {
    const cid = this.extractCid(ref.uri);
    return `${this.gateway}/ipfs/${cid}`;
  }

  // === Private Methods ===

  private async addToIpfs(data: Uint8Array, filename?: string): Promise<string> {
    // Try pinning service first
    if (this.pinningService) {
      return this.pinningService.upload(data, filename);
    }

    // Fall back to local IPFS node
    if (!this.apiEndpoint) {
      throw new StorageException(
        StorageError.INVALID_CONFIG,
        "No IPFS API endpoint or pinning service configured"
      );
    }

    try {
      const formData = new FormData();
      // Create a new ArrayBuffer to ensure type compatibility
      const buffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(buffer).set(data);
      const blob = new Blob([buffer]);
      formData.append("file", blob, filename ?? "data.bin");

      const response = await fetch(`${this.apiEndpoint}/api/v0/add`, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`IPFS add failed: ${response.status}`);
      }

      const result = await response.json() as IpfsAddResponse;
      return result.Hash;
    } catch (error) {
      if (error instanceof StorageException) throw error;
      throw new StorageException(
        StorageError.STORE_FAILED,
        `Failed to store on IPFS: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  private extractCid(uri: string): string {
    // Handle ipfs:// URIs
    if (uri.startsWith("ipfs://")) {
      return uri.slice(7);
    }

    // Handle /ipfs/ paths
    const match = uri.match(/\/ipfs\/(\w+)/);
    if (match?.[1]) {
      return match[1];
    }

    // Assume it's a raw CID
    return uri;
  }
}

/**
 * Create an IPFS storage adapter.
 */
export function createIpfsAdapter(config: IpfsAdapterConfig): IpfsAdapter {
  return new IpfsAdapter(config);
}
