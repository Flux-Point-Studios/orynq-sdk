/**
 * S3 Storage Adapter.
 * Stores data on AWS S3 or S3-compatible services.
 */

import type {
  StorageAdapter,
  StorageRef,
  StorableManifest,
  S3AdapterConfig,
} from "../../types.js";
import { StorageError, StorageException } from "../../types.js";
import { sha256 } from "../../utils/content-addressing.js";

/**
 * S3 client interface (minimal subset used).
 * This allows using the actual AWS SDK or a compatible implementation.
 */
export interface S3Client {
  send(command: unknown): Promise<unknown>;
}

/**
 * Storage adapter for S3 and S3-compatible services.
 */
export class S3Adapter implements StorageAdapter {
  readonly type = "s3" as const;
  private readonly bucket: string;
  private readonly region: string;
  private readonly prefix: string;
  private readonly credentials: { accessKeyId: string; secretAccessKey: string } | undefined;
  private readonly endpoint: string | undefined;
  private readonly serverSideEncryption: boolean;
  private readonly presignedUrlExpiry: number;

  private s3Client: S3Client | undefined;

  constructor(config: S3AdapterConfig) {
    this.bucket = config.bucket;
    this.region = config.region;
    this.prefix = config.prefix ?? "";
    this.credentials = config.credentials;
    this.endpoint = config.endpoint;
    this.serverSideEncryption = config.serverSideEncryption ?? false;
    this.presignedUrlExpiry = config.presignedUrlExpiry ?? 3600;
  }

  /**
   * Store data on S3.
   */
  async store(data: Uint8Array): Promise<StorageRef> {
    const hash = sha256(data, "chunk");
    const key = this.buildKey(`chunks/${hash}.bin`);

    await this.putObject(key, data);

    return {
      type: "s3",
      uri: `s3://${this.bucket}/${key}`,
      hash,
      size: data.length,
    };
  }

  /**
   * Store a manifest on S3.
   */
  async storeManifest(manifest: StorableManifest): Promise<StorageRef> {
    const json = JSON.stringify(manifest, null, 2);
    const data = new TextEncoder().encode(json);
    const hash = manifest.manifestHash ?? sha256(data, "manifest");
    const key = this.buildKey(`manifests/${manifest.sessionId}-${hash.slice(0, 16)}.json`);

    await this.putObject(key, data, "application/json");

    return {
      type: "s3",
      uri: `s3://${this.bucket}/${key}`,
      hash,
      size: data.length,
    };
  }

  /**
   * Fetch data from S3.
   */
  async fetch(ref: StorageRef): Promise<Uint8Array> {
    const key = this.extractKey(ref.uri);

    try {
      return await this.getObject(key);
    } catch (error) {
      throw new StorageException(
        StorageError.FETCH_FAILED,
        `Failed to fetch from S3: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Fetch a manifest from S3.
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
   * Delete data from S3.
   */
  async delete(ref: StorageRef): Promise<void> {
    const key = this.extractKey(ref.uri);

    try {
      await this.deleteObject(key);
    } catch (error) {
      throw new StorageException(
        StorageError.DELETE_FAILED,
        `Failed to delete from S3: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Generate a presigned URL for reading.
   */
  async getPresignedUrl(ref: StorageRef): Promise<string> {
    const key = this.extractKey(ref.uri);
    return this.generatePresignedUrl(key, "GET");
  }

  /**
   * Generate a presigned URL for uploading.
   */
  async getUploadUrl(filename: string): Promise<{ url: string; key: string }> {
    const key = this.buildKey(`uploads/${filename}`);
    const url = await this.generatePresignedUrl(key, "PUT");
    return { url, key };
  }

  /**
   * Check if an object exists.
   */
  async exists(ref: StorageRef): Promise<boolean> {
    const key = this.extractKey(ref.uri);
    return this.headObject(key);
  }

  // === Private Methods ===

  private async getS3Client(): Promise<S3Client> {
    if (this.s3Client) {
      return this.s3Client;
    }

    try {
      // Dynamically import AWS SDK
      const { S3Client: AwsS3Client } = await import("@aws-sdk/client-s3");

      const config: Record<string, unknown> = {
        region: this.region,
      };

      if (this.credentials) {
        config.credentials = this.credentials;
      }

      if (this.endpoint) {
        config.endpoint = this.endpoint;
        config.forcePathStyle = true;
      }

      this.s3Client = new AwsS3Client(config) as unknown as S3Client;
      return this.s3Client;
    } catch (error) {
      throw new StorageException(
        StorageError.INVALID_CONFIG,
        "AWS SDK not available. Install @aws-sdk/client-s3 to use S3 adapter.",
        error instanceof Error ? error : undefined
      );
    }
  }

  private async putObject(
    key: string,
    data: Uint8Array,
    contentType: string = "application/octet-stream"
  ): Promise<void> {
    const client = await this.getS3Client();

    try {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");

      // Use explicit type casting to avoid TypeScript issues with dynamic imports
      interface PutObjectParams {
        Bucket: string;
        Key: string;
        Body: Uint8Array;
        ContentType: string;
        ServerSideEncryption?: string;
      }

      const params: PutObjectParams = {
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      };

      if (this.serverSideEncryption) {
        params.ServerSideEncryption = "AES256";
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.send(new PutObjectCommand(params as any));
    } catch (error) {
      throw new StorageException(
        StorageError.STORE_FAILED,
        `S3 PutObject failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  private async getObject(key: string): Promise<Uint8Array> {
    const client = await this.getS3Client();

    try {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");

      const result = await client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      ) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };

      if (!result.Body) {
        throw new Error("No body in response");
      }

      return result.Body.transformToByteArray();
    } catch (error) {
      const errorObj = error as { name?: string };
      if (errorObj.name === "NoSuchKey") {
        throw new StorageException(
          StorageError.NOT_FOUND,
          `Object not found: ${key}`
        );
      }
      throw error;
    }
  }

  private async deleteObject(key: string): Promise<void> {
    const client = await this.getS3Client();

    try {
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");

      await client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );
    } catch (error) {
      throw new StorageException(
        StorageError.DELETE_FAILED,
        `S3 DeleteObject failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  private async headObject(key: string): Promise<boolean> {
    const client = await this.getS3Client();

    try {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");

      await client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  private async generatePresignedUrl(
    key: string,
    operation: "GET" | "PUT"
  ): Promise<string> {
    const client = await this.getS3Client();

    try {
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

      if (operation === "GET") {
        const { GetObjectCommand } = await import("@aws-sdk/client-s3");
        return getSignedUrl(
          client as Parameters<typeof getSignedUrl>[0],
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
          }),
          { expiresIn: this.presignedUrlExpiry }
        );
      } else {
        const { PutObjectCommand } = await import("@aws-sdk/client-s3");
        return getSignedUrl(
          client as Parameters<typeof getSignedUrl>[0],
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
          }),
          { expiresIn: this.presignedUrlExpiry }
        );
      }
    } catch (error) {
      throw new StorageException(
        StorageError.STORE_FAILED,
        `Failed to generate presigned URL: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  private buildKey(suffix: string): string {
    if (this.prefix) {
      return `${this.prefix}/${suffix}`;
    }
    return suffix;
  }

  private extractKey(uri: string): string {
    // s3://bucket/key/path
    if (uri.startsWith("s3://")) {
      const match = uri.match(/s3:\/\/[^\/]+\/(.+)/);
      if (match?.[1]) {
        return match[1];
      }
    }

    // https://bucket.s3.region.amazonaws.com/key
    const httpsMatch = uri.match(/https?:\/\/[^\/]+\/(.+)/);
    if (httpsMatch?.[1]) {
      return httpsMatch[1];
    }

    return uri;
  }
}

/**
 * Create an S3 storage adapter.
 */
export function createS3Adapter(config: S3AdapterConfig): S3Adapter {
  return new S3Adapter(config);
}
