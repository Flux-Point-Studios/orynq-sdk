/**
 * Pinning service integrations for IPFS.
 * Supports Pinata, Infura, and web3.storage.
 */

import type { PinningServiceConfig } from "../../types.js";
import { StorageError, StorageException } from "../../types.js";

/**
 * Abstract pinning service interface.
 */
export interface PinningService {
  /**
   * Upload data and return CID.
   */
  upload(data: Uint8Array, filename?: string): Promise<string>;

  /**
   * Pin an existing CID.
   */
  pin(cid: string): Promise<void>;

  /**
   * Unpin a CID.
   */
  unpin?(cid: string): Promise<void>;

  /**
   * Check if a CID is pinned.
   */
  isPinned?(cid: string): Promise<boolean>;
}

/**
 * Pinata pinning service.
 */
export class PinataPinningService implements PinningService {
  private readonly apiKey: string;
  private readonly apiSecret: string | undefined;
  private readonly endpoint: string;

  constructor(config: PinningServiceConfig) {
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.endpoint = config.endpoint ?? "https://api.pinata.cloud";
  }

  async upload(data: Uint8Array, filename?: string): Promise<string> {
    try {
      const formData = new FormData();
      // Create a new ArrayBuffer to ensure type compatibility
      const buffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(buffer).set(data);
      const blob = new Blob([buffer]);
      formData.append("file", blob, filename ?? "data.bin");

      const response = await fetch(`${this.endpoint}/pinning/pinFileToIPFS`, {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: formData,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Pinata upload failed: ${response.status} - ${error}`);
      }

      const result = await response.json() as { IpfsHash: string };
      return result.IpfsHash;
    } catch (error) {
      throw new StorageException(
        StorageError.STORE_FAILED,
        `Pinata upload failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async pin(cid: string): Promise<void> {
    try {
      const response = await fetch(`${this.endpoint}/pinning/pinByHash`, {
        method: "POST",
        headers: {
          ...this.getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hashToPin: cid }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Pinata pin failed: ${response.status} - ${error}`);
      }
    } catch (error) {
      throw new StorageException(
        StorageError.PIN_FAILED,
        `Pinata pin failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async unpin(cid: string): Promise<void> {
    try {
      const response = await fetch(`${this.endpoint}/pinning/unpin/${cid}`, {
        method: "DELETE",
        headers: this.getAuthHeaders(),
      });

      if (!response.ok && response.status !== 404) {
        throw new Error(`Pinata unpin failed: ${response.status}`);
      }
    } catch (error) {
      throw new StorageException(
        StorageError.DELETE_FAILED,
        `Pinata unpin failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async isPinned(cid: string): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.endpoint}/data/pinList?hashContains=${cid}&status=pinned`,
        {
          headers: this.getAuthHeaders(),
        }
      );

      if (!response.ok) {
        return false;
      }

      const result = await response.json() as { rows: unknown[] };
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }

  private getAuthHeaders(): Record<string, string> {
    if (this.apiSecret) {
      return {
        pinata_api_key: this.apiKey,
        pinata_secret_api_key: this.apiSecret,
      };
    }
    return {
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}

/**
 * Infura IPFS pinning service.
 */
export class InfuraPinningService implements PinningService {
  private readonly projectId: string;
  private readonly projectSecret: string | undefined;
  private readonly endpoint: string;

  constructor(config: PinningServiceConfig) {
    this.projectId = config.apiKey;
    this.projectSecret = config.apiSecret;
    this.endpoint = config.endpoint ?? "https://ipfs.infura.io:5001";
  }

  async upload(data: Uint8Array, filename?: string): Promise<string> {
    try {
      const formData = new FormData();
      // Create a new ArrayBuffer to ensure type compatibility
      const buffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(buffer).set(data);
      const blob = new Blob([buffer]);
      formData.append("file", blob, filename ?? "data.bin");

      const response = await fetch(`${this.endpoint}/api/v0/add?pin=true`, {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Infura upload failed: ${response.status}`);
      }

      const result = await response.json() as { Hash: string };
      return result.Hash;
    } catch (error) {
      throw new StorageException(
        StorageError.STORE_FAILED,
        `Infura upload failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async pin(cid: string): Promise<void> {
    try {
      const response = await fetch(
        `${this.endpoint}/api/v0/pin/add?arg=${cid}`,
        {
          method: "POST",
          headers: this.getAuthHeaders(),
        }
      );

      if (!response.ok) {
        throw new Error(`Infura pin failed: ${response.status}`);
      }
    } catch (error) {
      throw new StorageException(
        StorageError.PIN_FAILED,
        `Infura pin failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async unpin(cid: string): Promise<void> {
    try {
      const response = await fetch(
        `${this.endpoint}/api/v0/pin/rm?arg=${cid}`,
        {
          method: "POST",
          headers: this.getAuthHeaders(),
        }
      );

      if (!response.ok && response.status !== 500) {
        // Infura returns 500 for not pinned
        throw new Error(`Infura unpin failed: ${response.status}`);
      }
    } catch (error) {
      throw new StorageException(
        StorageError.DELETE_FAILED,
        `Infura unpin failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  private getAuthHeaders(): Record<string, string> {
    if (this.projectSecret) {
      const auth = Buffer.from(`${this.projectId}:${this.projectSecret}`).toString("base64");
      return {
        Authorization: `Basic ${auth}`,
      };
    }
    return {};
  }
}

/**
 * web3.storage pinning service.
 */
export class Web3StoragePinningService implements PinningService {
  private readonly token: string;
  private readonly endpoint: string;

  constructor(config: PinningServiceConfig) {
    this.token = config.apiKey;
    this.endpoint = config.endpoint ?? "https://api.web3.storage";
  }

  async upload(data: Uint8Array, filename?: string): Promise<string> {
    try {
      // Create a new ArrayBuffer to ensure type compatibility
      const buffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(buffer).set(data);
      const blob = new Blob([buffer]);
      const response = await fetch(`${this.endpoint}/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "X-Name": filename ?? "data.bin",
        },
        body: blob,
      });

      if (!response.ok) {
        throw new Error(`web3.storage upload failed: ${response.status}`);
      }

      const result = await response.json() as { cid: string };
      return result.cid;
    } catch (error) {
      throw new StorageException(
        StorageError.STORE_FAILED,
        `web3.storage upload failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async pin(cid: string): Promise<void> {
    // web3.storage automatically pins uploads
    // For existing CIDs, we'd use the pinning API
    try {
      const response = await fetch(`${this.endpoint}/pins`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ cid }),
      });

      if (!response.ok && response.status !== 409) {
        // 409 means already pinned
        throw new Error(`web3.storage pin failed: ${response.status}`);
      }
    } catch (error) {
      throw new StorageException(
        StorageError.PIN_FAILED,
        `web3.storage pin failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }
}

/**
 * Create a pinning service based on configuration.
 */
export function createPinningService(config: PinningServiceConfig): PinningService {
  switch (config.name) {
    case "pinata":
      return new PinataPinningService(config);
    case "infura":
      return new InfuraPinningService(config);
    case "web3.storage":
      return new Web3StoragePinningService(config);
    case "custom":
      throw new StorageException(
        StorageError.INVALID_CONFIG,
        "Custom pinning service requires implementation"
      );
    default:
      throw new StorageException(
        StorageError.INVALID_CONFIG,
        `Unknown pinning service: ${config.name}`
      );
  }
}
