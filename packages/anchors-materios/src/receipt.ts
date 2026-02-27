/**
 * Receipt submission and querying for the Materios chain.
 *
 * Receipts are the fundamental unit of data anchoring on Materios.
 * After submission, the cert daemon committee attests availability,
 * and the checkpoint system batches certified receipts into L1 anchors.
 */

import { createHash } from "crypto";
import type { MateriosProvider } from "./provider.js";
import type {
  ReceiptInput,
  ReceiptSubmitResult,
  ReceiptRecord,
  BlobManifest,
} from "./types.js";
import { stripPrefix, ensureHex, isZeroHash } from "./hex.js";

/**
 * Submit a receipt to the Materios chain.
 *
 * The receipt is stored on-chain and the cert daemon committee will
 * attempt to locate and verify the blob data, then attest availability.
 *
 * @example
 * ```ts
 * const result = await submitReceipt(provider, {
 *   contentHash: bundle.rootHash,
 *   rootHash: bundle.rootHash,
 *   manifestHash: bundle.manifestHash,
 * });
 * console.log("Receipt ID:", result.receiptId);
 * ```
 */
export async function submitReceipt(
  provider: MateriosProvider,
  input: ReceiptInput,
): Promise<ReceiptSubmitResult> {
  const api = provider.getApi();
  const keypair = provider.getKeypair();

  const contentHex = stripPrefix(input.contentHash);
  const rootHex = stripPrefix(input.rootHash);
  const manifestHex = stripPrefix(input.manifestHash);

  // Derive receipt_id from contentHash if not provided
  const receiptId =
    input.receiptId ??
    "0x" +
      createHash("sha256")
        .update(Buffer.from(contentHex, "hex"))
        .digest("hex");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx = (api.tx as any).orinqReceipts.submitReceipt(
    ensureHex(receiptId), // receipt_id: H256
    toBytes32(contentHex), // content_hash: [u8; 32]
    toBytes32(rootHex), // base_root_sha256: [u8; 32]
    toBytes32("00".repeat(32)), // zk_root_poseidon: [u8; 32]
    toBytes32("00".repeat(32)), // poseidon_params_hash: [u8; 32]
    toBytes32("00".repeat(32)), // schema_hash: [u8; 32]
    toBytes32("00".repeat(32)), // storage_locator_hash: [u8; 32]
    toBytes32(manifestHex), // base_manifest_hash: [u8; 32]
    toBytes32("00".repeat(32)), // safety_manifest_hash: [u8; 32]
    toBytes32("00".repeat(32)), // monitor_config_hash: [u8; 32]
    toBytes32("00".repeat(32)), // attestation_evidence_hash: [u8; 32]
  );

  return new Promise<ReceiptSubmitResult>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx.signAndSend(keypair, ({ status, dispatchError }: any) => {
      if (dispatchError) {
        if (dispatchError.isModule) {
          const decoded = api.registry.findMetaError(dispatchError.asModule);
          reject(
            new Error(
              `${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`,
            ),
          );
        } else {
          reject(new Error(dispatchError.toString()));
        }
        return;
      }
      if (status.isInBlock) {
        const blockHash = status.asInBlock.toHex();
        // Get block number from the block hash
        api.rpc.chain
          .getHeader(blockHash)
          .then((header) => {
            resolve({
              receiptId: ensureHex(receiptId),
              blockHash,
              blockNumber: header.number.toNumber(),
            });
          })
          .catch(() => {
            resolve({
              receiptId: ensureHex(receiptId),
              blockHash,
              blockNumber: 0,
            });
          });
      }
    }).catch(reject);
  });
}

/**
 * Query a receipt from on-chain storage.
 *
 * Returns null if the receipt doesn't exist.
 */
export async function getReceipt(
  provider: MateriosProvider,
  receiptId: string,
): Promise<ReceiptRecord | null> {
  const api = provider.getApi();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (api.query as any).orinqReceipts.receipts(
    ensureHex(receiptId),
  );

  if (result.isEmpty) return null;

  const record = result.toJSON() as Record<string, unknown>;
  return {
    receiptId: ensureHex(receiptId),
    contentHash: String(
      record.content_hash ?? record.contentHash ?? "",
    ),
    availabilityCertHash: String(
      record.availability_cert_hash ?? record.availabilityCertHash ?? "",
    ),
    submitter: String(record.submitter ?? ""),
  };
}

/**
 * Check if a receipt has been certified (availability_cert_hash != zero).
 */
export async function isCertified(
  provider: MateriosProvider,
  receiptId: string,
): Promise<boolean> {
  const receipt = await getReceipt(provider, receiptId);
  if (!receipt) return false;
  return !isZeroHash(receipt.availabilityCertHash);
}

/**
 * Prepare blob manifest and chunk files for the cert daemon.
 *
 * Creates the directory structure expected by the daemon's filesystem
 * locator at `<basePath>/<receiptId>/manifest.json`.
 *
 * @returns The manifest object and the directory path.
 */
export function prepareBlobData(
  receiptId: string,
  content: Buffer,
  chunkSize = 256 * 1024,
): { manifest: BlobManifest; chunks: Array<{ path: string; data: Buffer }> } {
  const receiptHex = stripPrefix(receiptId);
  const chunks: Array<{ path: string; data: Buffer }> = [];
  const chunkInfos: BlobManifest["chunks"] = [];

  for (let i = 0; i * chunkSize < content.length; i++) {
    const start = i * chunkSize;
    const data = content.subarray(start, start + chunkSize);
    const hash = createHash("sha256").update(data).digest("hex");
    const path = `chunks/${i}.bin`;
    chunks.push({ path, data });
    chunkInfos.push({ index: i, sha256: hash, size: data.length, path });
  }

  const manifest: BlobManifest = {
    receipt_id: "0x" + receiptHex,
    content_hash: createHash("sha256").update(content).digest("hex"),
    total_size: content.length,
    chunk_count: chunks.length,
    chunks: chunkInfos,
  };

  return { manifest, chunks };
}

/**
 * Convert a hex string to a [u8; 32] byte array for Substrate encoding.
 */
function toBytes32(hex: string): number[] {
  const clean = stripPrefix(hex).padStart(64, "0");
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return bytes;
}
