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
  TimeoutOptions,
} from "./types.js";
import { waitForCertification, waitForAnchor } from "./polling.js";
import { timeoutBudget, withinDeadline } from "./deadline.js";
import { watchSubmission } from "./subscription.js";
import { MateriosSubmissionError } from "./errors.js";
import { merkleRoot } from "./merkle.js";
import { stripPrefix, ensureHex, isZeroHash, assertHex32 } from "./hex.js";
import { u8aToHex, stringToU8a } from "@polkadot/util";
import type { SubmittableExtrinsic } from "@polkadot/api/types";

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
  opts: TimeoutOptions = {},
): Promise<ReceiptSubmitResult> {
  const api = provider.getApi();
  const keypair = provider.getKeypair();
  const timeoutMs = timeoutBudget(opts.timeoutMs ?? provider.inclusionTimeoutMs ?? 120_000);
  const deadline = Date.now() + timeoutMs;
  const watchDeadline = deadline - Math.min(30_000, timeoutMs / 2);

  // Validate at the SDK boundary. `toBytes32` will silently pad short
  // input and silently truncate long input — both produce a different
  // on-chain value than the caller intended. Surfacing format errors
  // here as Error throws (not silent on-chain corruption) is the
  // operator-friendly default.
  const contentHex = assertHex32(input.contentHash, "contentHash");
  const rootHex = assertHex32(input.rootHash, "rootHash");
  const manifestHex = assertHex32(input.manifestHash, "manifestHash");
  // schemaHash defaults to legacy (32 zero bytes) when caller omits it,
  // preserving the prior behaviour for plain blob receipts. A discriminator
  // identifies a receipt class on chain; it does not guarantee that the
  // deployed committee supports semantic roots. The operator-kit 3ec33237
  // deployment still requires the uploaded chunks' Merkle root for every
  // class. See ReceiptInput.schemaHash before submitting a semantic root.
  const schemaHex = input.schemaHash
    ? assertHex32(input.schemaHash, "schemaHash")
    : "00".repeat(32);

  // Derive receipt_id from contentHash if not provided
  const receiptId =
    input.receiptId ??
    "0x" +
      createHash("sha256")
        .update(Buffer.from(contentHex, "hex"))
        .digest("hex");

  // Positional arg order MUST track live runtime metadata exactly. Two
  // drift hazards that have bitten us before (task #115; observed again
  // 2026-05-11 when every orynq_trace_v1 + compute_metering_v2 receipt
  // landed with schema_hash=0x00…):
  //
  //   1. arg ordering — fields 5-10 changed shape and the SDK was sending
  //      schemaHash in the slot the runtime now decodes as
  //      baseManifestHash. The verifier read schema_hash=0, fell through
  //      to the legacy chunk-Merkle path, computed against the wrong
  //      field, and rejected every receipt.
  //   2. Option<[u8;32]> on zkRootPoseidon + poseidonParamsHash — passing
  //      a raw 32-byte buffer for an Option<> arg corrupts SCALE encoding
  //      because polkadot-js takes the first byte as the Option tag.
  //      Pass `null` for None; pass the bytes directly only if Some is
  //      genuinely intended.
  //
  // Live metadata as of 2026-05-11 (queried via api.tx.orinqReceipts.submitReceipt.meta):
  //   0  receipt_id              : H256
  //   1  content_hash            : H256
  //   2  base_root_sha256        : [u8;32]
  //   3  zk_root_poseidon        : Option<[u8;32]>
  //   4  poseidon_params_hash    : Option<[u8;32]>
  //   5  base_manifest_hash      : [u8;32]
  //   6  safety_manifest_hash    : [u8;32]
  //   7  monitor_config_hash     : [u8;32]
  //   8  attestation_evidence_hash : [u8;32]
  //   9  storage_locator_hash    : [u8;32]
  //   10 schema_hash             : [u8;32]
  //
  // If you change this, add a regression test that fetches live metadata
  // and asserts the name + type of each positional arg.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx = (api.tx as any).orinqReceipts.submitReceipt(
    ensureHex(receiptId),         // 0  receipt_id
    ensureHex(contentHex),        // 1  content_hash (H256)
    toBytes32(rootHex),           // 2  base_root_sha256
    null,                         // 3  zk_root_poseidon: Option<None>
    null,                         // 4  poseidon_params_hash: Option<None>
    toBytes32(manifestHex),       // 5  base_manifest_hash
    toBytes32("00".repeat(32)),   // 6  safety_manifest_hash
    toBytes32("00".repeat(32)),   // 7  monitor_config_hash
    toBytes32("00".repeat(32)),   // 8  attestation_evidence_hash
    toBytes32("00".repeat(32)),   // 9  storage_locator_hash
    toBytes32(schemaHex),         // 10 schema_hash
  );

  // Sign the extrinsic first so dry-run can simulate the fully signed payload
  const finalReceiptId = ensureHex(receiptId);
  const notBroadcast = () => new MateriosSubmissionError("not-landed", finalReceiptId,
    "Receipt preparation timed out before broadcast; resubmission is safe");
  const unknown = () => new MateriosSubmissionError("inclusion-unknown", finalReceiptId,
    "Receipt inclusion could not be established within the deadline; do not blindly resubmit");
  const matchesReceipt = (value: Record<string, unknown>) => {
    const matches = (snake: string, camel: string, expected: string) =>
      String(value[snake] ?? value[camel]).toLowerCase() === ensureHex(expected).toLowerCase();
    return matches("content_hash", "contentHash", contentHex)
      && matches("base_root_sha256", "baseRootSha256", rootHex)
      && matches("base_manifest_hash", "baseManifestHash", manifestHex)
      && matches("schema_hash", "schemaHash", schemaHex);
  };
  let signed: SubmittableExtrinsic<"promise">;
  try {
    signed = await withinDeadline<SubmittableExtrinsic<"promise">>(() => tx.signAsync(keypair, { nonce: -1 }), watchDeadline, notBroadcast);
  } catch (cause) {
    if (cause instanceof MateriosSubmissionError) throw cause;
    throw new MateriosSubmissionError("not-landed", finalReceiptId,
      "Receipt signing failed before broadcast; resubmission is safe", { cause });
  }

  // ── Dry-run: catch dispatch errors BEFORE consuming a nonce ──────────
  // system.dryRun may not be available on every chain, so wrap in try/catch
  // for graceful degradation.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dryRunResult: any = await withinDeadline(() => (api.rpc as any).system.dryRun(signed.toHex()), watchDeadline, notBroadcast);

    // ApplyExtrinsicResult = Result<DispatchOutcome, TransactionValidityError>
    // DispatchOutcome      = Result<(), DispatchError>
    if (dryRunResult.isErr) {
      // Outer error: TransactionValidityError (invalid nonce, can't pay fees, etc.)
      throw new MateriosSubmissionError("dispatch", finalReceiptId,
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
      throw new MateriosSubmissionError("dispatch", finalReceiptId,
        `Receipt submission would fail at dispatch: ${errorMsg}. ` +
        `This was caught by dry-run BEFORE broadcasting — no nonce was consumed.`,
      );
    }
  } catch (err) {
    // If the error was thrown by our own dry-run checks above, re-throw it
    if (err instanceof MateriosSubmissionError) {
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

  if (Date.now() >= watchDeadline) throw notBroadcast();
  const result = await watchSubmission(api, callback => signed.send(callback), watchDeadline, finalReceiptId, false);
  const txHash = result?.txHash?.toHex() ?? signed.hash.toHex();
  if (result) {
    const blockHash = result.status.asInBlock.toHex();
    try {
      const header = await withinDeadline(() => api.rpc.chain.getHeader(blockHash), watchDeadline, unknown);
      const onChain = await withinDeadline(() => api.query.orinqReceipts!.receipts!(finalReceiptId), watchDeadline, unknown);
      if (!onChain.isEmpty && matchesReceipt(onChain.toJSON() as Record<string, unknown>)) {
        return { receiptId: finalReceiptId, blockHash, blockNumber: header.number.toNumber(), txHash, confirmed: true, status: "submitted" };
      }
    } catch (error) {
      if (Date.now() >= deadline) throw unknown();
      // The fresh connection below decides when the original connection cannot confirm storage.
    }
  }

  try {
    return await provider.withRecoveryApi(async recovery => {
      const header = await withinDeadline(() => recovery.rpc.chain.getHeader(), deadline, unknown);
      const blockHash = header.hash.toHex();
      const at = await withinDeadline(() => recovery.at(blockHash), deadline, unknown);
      const record = await withinDeadline(() => at.query.orinqReceipts!.receipts!(finalReceiptId), deadline, unknown);
      if (record.isEmpty) throw unknown();
      const value = record.toJSON() as Record<string, unknown>;
      if (!matchesReceipt(value)) {
        throw new MateriosSubmissionError("inclusion-unknown", finalReceiptId,
          "Stored receipt does not match the submitted payload; do not blindly resubmit");
      }
      return {
        receiptId: finalReceiptId, blockHash, blockNumber: header.number.toNumber(),
        txHash, confirmed: true, status: "submitted" as const, reconciled: true,
      };
    }, deadline - Date.now());
  } catch (cause) {
    if (cause instanceof MateriosSubmissionError) throw cause;
    throw new MateriosSubmissionError("inclusion-unknown", finalReceiptId,
      "Receipt recovery could not read matching storage before the deadline; do not blindly resubmit", { cause });
  }
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

/** One gateway request, as the materios-upload-v2 signature covers it. */
export interface GatewayRequest {
  method: string;
  /** Path appended to the gateway base URL, without a query. */
  path: string;
  /** The exact bytes sent as the body; empty when there is none. */
  body: Uint8Array;
  /** Content hash in the path, without 0x. */
  id: string;
}

/**
 * The materios-upload-v2 signing string. The gateway rebuilds it from the
 * request it receives. Exported for unit testing; not part of the public
 * package API.
 */
export function uploadSigV2Message(p: {
  method: string;
  path: string;
  bodySha256: string;
  id: string;
  address: string;
  ts: number;
}): string {
  return ["materios-upload-v2", p.method, p.path, p.bodySha256, p.id, p.address, p.ts].join("|");
}

/**
 * Build auth headers for gateway requests (API key or sr25519 signature).
 *
 * Tokens prefixed with `matra_` are routed by the gateway's resolveAuth path
 * which only accepts `Authorization: Bearer ...`. Legacy keys (no prefix) keep
 * the `x-api-key` header for back-compat with pre-v6 deployments.
 *
 * A signed request carries a materios-upload-v2 signature, which binds the
 * method, path and body. No v1 signature is sent: it covers only the content
 * hash, so a copy lifted from the request could authorize a different body.
 * The gateway refuses reuse, so every request is signed afresh.
 *
 * Exported for unit testing; not part of the public package API.
 */
export function buildAuthHeaders(gateway: BlobGatewayConfig, request: GatewayRequest): Record<string, string> {
  if (gateway.apiKey) {
    if (gateway.apiKey.startsWith("matra_")) {
      return { "Authorization": `Bearer ${gateway.apiKey}` };
    }
    return { "x-api-key": gateway.apiKey };
  }
  if (gateway.signerKeypair) {
    const signer = gateway.signerKeypair;
    const address = signer.address;
    const ts = Math.floor(Date.now() / 1000);
    const v2 = uploadSigV2Message({
      method: request.method,
      path: request.path,
      bodySha256: createHash("sha256").update(request.body).digest("hex"),
      id: request.id,
      address,
      ts,
    });
    return {
      "x-upload-sig-v2": u8aToHex(signer.sign(stringToU8a(v2))),
      "x-uploader-address": address,
      "x-upload-ts": String(ts),
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

  try {
    // 1. Upload manifest
    const manifestPath = `/blobs/${strippedHash}/manifest`;
    const manifestBody = JSON.stringify(manifest);
    const manifestRes = await fetch(
      `${gateway.baseUrl}${manifestPath}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAuthHeaders(gateway, {
            method: "POST",
            path: manifestPath,
            body: stringToU8a(manifestBody),
            id: strippedHash,
          }),
        },
        body: manifestBody,
      },
    );
    if (!manifestRes.ok && manifestRes.status !== 409) {
      const text = await manifestRes.text();
      return { success: false, error: `Manifest upload failed: ${manifestRes.status} ${text}` };
    }

    // 2. Upload each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const chunkPath = `/blobs/${strippedHash}/chunks/${i}`;
      const chunkBody = new Uint8Array(chunk.data);

      const chunkRes = await fetch(
        `${gateway.baseUrl}${chunkPath}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            ...buildAuthHeaders(gateway, { method: "PUT", path: chunkPath, body: chunkBody, id: strippedHash }),
          },
          body: chunkBody,
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

  // Derive the *default* receiptId from contentHash. If the caller passed
  // their own `input.receiptId`, honor it for BOTH the blob-storage path
  // (prepareBlobData) AND the on-chain submit, so the gateway and chain
  // agree on the key. Letting these diverge — derive for blob, caller-
  // value for chain — strands the blob: cert-daemon looks up the manifest
  // under the on-chain receiptId, doesn't find it, fails verification.
  const derivedReceiptIdHex = ensureHex(
    createHash("sha256")
      .update(Buffer.from(stripPrefix(effectiveContentHash), "hex"))
      .digest("hex"),
  );
  const effectiveReceiptIdHex = input.receiptId
    ? ensureHex(input.receiptId)
    : derivedReceiptIdHex;

  const { manifest, chunks } = prepareBlobData(effectiveReceiptIdHex, content);

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

  // 3. Submit receipt on-chain. Forward `schemaHash` and `receiptId`
  // from the caller's input to preserve its on-chain receipt class and id.
  // Omitting schemaHash falls back to legacy (zero bytes) = chunk-Merkle.
  const receiptInput: ReceiptInput = {
    contentHash: effectiveContentHash,
    // A blob receipt (no schema hash) is certified only when its base root is the Merkle root of
    // the uploaded chunk hashes. Non-zero schema hashes preserve the caller's root, but the
    // operator-kit 3ec33237 deployment also requires a chunk-Merkle root for those classes;
    // a semantic root needs a committee running the schema-aware verifier (see ReceiptInput).
    rootHash: !input.schemaHash || isZeroHash(input.schemaHash)
      ? merkleRoot(manifest.chunks.map((chunk) => chunk.sha256))
      : input.rootHash || contentHashHex,
    manifestHash: uploadResult.storageLocatorHash || input.manifestHash || contentHashHex,
    // Always pass effectiveReceiptIdHex (derived OR caller-supplied) so
    // the gateway-side blob path and the on-chain receipt agree on the
    // key. submitReceipt's own derivation would re-derive from
    // contentHash and ignore the override — pass it explicitly.
    receiptId: effectiveReceiptIdHex,
    // exactOptionalPropertyTypes forbids assigning `undefined`, so spread.
    ...(input.schemaHash !== undefined ? { schemaHash: input.schemaHash } : {}),
  };
  const submitResult = await submitReceipt(provider, receiptInput, opts.submissionOpts);

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
    ...(submitResult.reconciled !== undefined ? { reconciled: submitResult.reconciled } : {}),
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
