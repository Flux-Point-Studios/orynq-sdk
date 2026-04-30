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
  BlobGatewayConfig,
  BlobUploadResult,
  CertifiedReceiptOptions,
  CertifiedReceiptResult,
} from "./types.js";
import { waitForCertification, waitForAnchor } from "./polling.js";
import { stripPrefix, ensureHex, isZeroHash } from "./hex.js";
import { u8aToHex, stringToU8a } from "@polkadot/util";

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

  // Sign the extrinsic first so dry-run can simulate the fully signed payload
  const signed = await tx.signAsync(keypair, { nonce: -1 });

  // ── Dry-run: catch dispatch errors BEFORE consuming a nonce ──────────
  // system.dryRun may not be available on every chain, so wrap in try/catch
  // for graceful degradation.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dryRunResult: any = await (api.rpc as any).system.dryRun(signed.toHex());

    // ApplyExtrinsicResult = Result<DispatchOutcome, TransactionValidityError>
    // DispatchOutcome      = Result<(), DispatchError>
    if (dryRunResult.isErr) {
      // Outer error: TransactionValidityError (invalid nonce, can't pay fees, etc.)
      throw new Error(
        `Receipt submission would fail (transaction invalid): ${dryRunResult.asErr.toString()}. ` +
        `This was caught by dry-run BEFORE broadcasting — no nonce was consumed.`,
      );
    }

    // dryRunResult.asOk is the inner DispatchOutcome (Result<(), DispatchError>)
    const dispatchOutcome = dryRunResult.asOk;
    if (dispatchOutcome.isErr) {
      // Inner error: DispatchError (e.g. ReceiptAlreadyExists, insufficient balance)
      const innerErr = dispatchOutcome.asErr;
      let errorMsg: string;
      if (innerErr.isModule) {
        const decoded = api.registry.findMetaError(innerErr.asModule);
        errorMsg = `${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`;
      } else {
        errorMsg = innerErr.toString();
      }
      throw new Error(
        `Receipt submission would fail at dispatch: ${errorMsg}. ` +
        `This was caught by dry-run BEFORE broadcasting — no nonce was consumed.`,
      );
    }
  } catch (err) {
    // If the error was thrown by our own dry-run checks above, re-throw it
    if (err instanceof Error && err.message.includes("dry-run")) {
      throw err;
    }
    // Otherwise, system.dryRun is likely unavailable on this chain —
    // log a warning and proceed without the safety net.
    console.warn(
      `[materios-sdk] system.dryRun unavailable, skipping pre-flight check: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // ── Broadcast the signed extrinsic ───────────────────────────────────
  return new Promise<ReceiptSubmitResult>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signed.send(({ status, dispatchError, txHash: extrinsicHash }: any) => {
      if (dispatchError) {
        if (dispatchError.isModule) {
          const decoded = api.registry.findMetaError(dispatchError.asModule);
          reject(
            new Error(
              `Receipt dispatch failed: ${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`,
            ),
          );
        } else {
          reject(new Error(`Receipt dispatch failed: ${dispatchError.toString()}`));
        }
        return;
      }
      if (status.isInBlock) {
        const blockHash = status.asInBlock.toHex();
        const txHash = extrinsicHash ? extrinsicHash.toHex() : signed.hash.toHex();

        // ── Post-submit storage confirmation ─────────────────────────
        // Verify the receipt actually landed in on-chain storage.
        // This catches silent dispatch failures that don't surface
        // through the dispatchError callback (e.g. nonce consumed
        // but extrinsic failed at execution).
        const finalReceiptId = ensureHex(receiptId);

        const confirmAndResolve = async () => {
          let blockNumber = 0;
          try {
            const header = await api.rpc.chain.getHeader(blockHash);
            blockNumber = header.number.toNumber();
          } catch {
            // Non-critical: block number is nice-to-have
          }

          let confirmed: boolean;
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const onChain = await (api.query as any).orinqReceipts.receipts(finalReceiptId);
            confirmed = !onChain.isEmpty;
          } catch (storageErr) {
            // If we can't query storage, we can't confirm — warn but don't fail
            console.warn(
              `[materios-sdk] Could not verify receipt in storage: ${
                storageErr instanceof Error ? storageErr.message : String(storageErr)
              }`,
            );
            // Resolve without confirmation info so we don't break existing callers
            resolve({
              receiptId: finalReceiptId,
              blockHash,
              blockNumber,
              txHash,
            });
            return;
          }

          if (!confirmed) {
            reject(
              new Error(
                `Receipt ${finalReceiptId} was included in block ${blockHash} (tx: ${txHash}) ` +
                `but was NOT found in on-chain storage. The extrinsic likely failed at dispatch. ` +
                `Check the block events for details. No receipt was stored — you may retry with a new submission.`,
              ),
            );
            return;
          }

          resolve({
            receiptId: finalReceiptId,
            blockHash,
            blockNumber,
            txHash,
            confirmed: true,
            status: "submitted",
          });
        };

        confirmAndResolve().catch((err) => {
          reject(
            new Error(
              `Receipt post-submit confirmation failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          );
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
 * Query the MOTRA fee token balance for an account.
 *
 * MOTRA is a non-transferable fee token generated from MATRA holdings.
 * Newly funded accounts start with 0 MOTRA and must wait ~2 blocks
 * for sufficient balance to pay transaction fees (~1.4M per receipt).
 */
export async function queryMotraBalance(
  provider: MateriosProvider,
  address?: string,
): Promise<bigint> {
  const api = provider.getApi();
  const addr = address ?? provider.getKeypair().address;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = await (api as any)._rpcCore.provider.send("motra_getBalance", [addr]);
  return BigInt(json.balance ?? json ?? "0");
}

/**
 * Build auth headers for gateway requests (API key or sr25519 signature).
 *
 * Tokens prefixed with `matra_` are routed by the gateway's resolveAuth path
 * which only accepts `Authorization: Bearer ...`. Legacy keys (no prefix) keep
 * the `x-api-key` header for back-compat with pre-v6 deployments.
 *
 * Exported for unit testing; not part of the public package API.
 */
export function buildAuthHeaders(gateway: BlobGatewayConfig, contentHash: string): Record<string, string> {
  if (gateway.apiKey) {
    if (gateway.apiKey.startsWith("matra_")) {
      return { "Authorization": `Bearer ${gateway.apiKey}` };
    }
    return { "x-api-key": gateway.apiKey };
  }
  if (gateway.signerKeypair) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const msg = `materios-upload-v1|${contentHash}|${gateway.signerKeypair.address}|${ts}`;
    const sig = gateway.signerKeypair.sign(stringToU8a(msg));
    return {
      "x-upload-sig": u8aToHex(sig),
      "x-uploader-address": gateway.signerKeypair.address,
      "x-upload-ts": ts,
    };
  }
  return {};
}

/**
 * Upload blob data (manifest + chunks) to a blob gateway.
 * The gateway uses contentHash as the primary key.
 */
export async function uploadBlobs(
  contentHash: string,
  manifest: BlobManifest,
  chunks: Array<{ path: string; data: Buffer }>,
  gateway: BlobGatewayConfig,
): Promise<BlobUploadResult> {
  const strippedHash = stripPrefix(contentHash);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  Object.assign(headers, buildAuthHeaders(gateway, strippedHash));

  try {
    // 1. Upload manifest
    const manifestRes = await fetch(
      `${gateway.baseUrl}/blobs/${strippedHash}/manifest`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(manifest),
      },
    );
    if (!manifestRes.ok && manifestRes.status !== 409) {
      const text = await manifestRes.text();
      return { success: false, error: `Manifest upload failed: ${manifestRes.status} ${text}` };
    }

    // 2. Upload each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const chunkHeaders: Record<string, string> = {
        "Content-Type": "application/octet-stream",
      };
      Object.assign(chunkHeaders, buildAuthHeaders(gateway, strippedHash));

      const chunkRes = await fetch(
        `${gateway.baseUrl}/blobs/${strippedHash}/chunks/${i}`,
        {
          method: "PUT",
          headers: chunkHeaders,
          body: new Uint8Array(chunk.data),
        },
      );
      if (!chunkRes.ok && chunkRes.status !== 409) {
        const text = await chunkRes.text();
        return { success: false, error: `Chunk ${i} upload failed: ${chunkRes.status} ${text}` };
      }
    }

    // 3. Compute storage locator hash (SHA-256 of manifest JSON)
    const manifestJson = JSON.stringify(manifest);
    const storageLocatorHash = ensureHex(
      createHash("sha256").update(manifestJson).digest("hex"),
    );

    return { success: true, storageLocatorHash };
  } catch (err) {
    return { success: false, error: `Upload failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * One-function orchestrator for external devs: submits receipt, uploads blobs,
 * waits for certification, and optionally waits for anchor.
 */
export async function submitCertifiedReceipt(
  provider: MateriosProvider,
  input: ReceiptInput,
  content: Buffer,
  opts: CertifiedReceiptOptions,
): Promise<CertifiedReceiptResult> {
  // 1. Prepare blob data from content
  const contentHashHex = ensureHex(
    createHash("sha256").update(content).digest("hex"),
  );
  // Use contentHash from input if provided, otherwise derive
  const effectiveContentHash = input.contentHash || contentHashHex;

  // Derive receiptId
  const receiptIdHex = ensureHex(
    createHash("sha256")
      .update(Buffer.from(stripPrefix(effectiveContentHash), "hex"))
      .digest("hex"),
  );

  const { manifest, chunks } = prepareBlobData(receiptIdHex, content);

  // 2. Upload blobs to gateway
  const uploadResult = await uploadBlobs(
    stripPrefix(effectiveContentHash),
    manifest,
    chunks,
    opts.blobGateway,
  );
  if (!uploadResult.success) {
    throw new Error(`Blob upload failed: ${uploadResult.error}`);
  }

  // 3. Submit receipt on-chain
  const receiptInput: ReceiptInput = {
    contentHash: effectiveContentHash,
    rootHash: input.rootHash || contentHashHex,
    manifestHash: uploadResult.storageLocatorHash || input.manifestHash || contentHashHex,
  };
  const submitResult = await submitReceipt(provider, receiptInput);

  // 4. Wait for certification
  const certResult = await waitForCertification(
    provider,
    submitResult.receiptId,
    opts.certificationPollOpts,
  );

  const result: CertifiedReceiptResult = {
    receiptId: submitResult.receiptId,
    blockHash: submitResult.blockHash,
    blockNumber: submitResult.blockNumber,
    ...(submitResult.txHash !== undefined ? { txHash: submitResult.txHash } : {}),
    ...(submitResult.confirmed !== undefined ? { confirmed: submitResult.confirmed } : {}),
    certHash: certResult.certHash,
    leafHash: certResult.leafHash,
  };

  // 5. Optionally wait for anchor
  if (opts.waitForAnchor) {
    const anchorResult = await waitForAnchor(
      provider,
      certResult,
      { ...opts.anchorPollOpts, blobGateway: opts.blobGateway },
    );
    result.anchor = anchorResult;
  }

  return result;
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
