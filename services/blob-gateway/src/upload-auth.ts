/**
 * Upload signature verification for sig-based blob uploads.
 *
 * Signing string format (consistent with heartbeat pattern):
 *   materios-upload-v1|{contentHash}|{uploaderAddress}|{timestamp}
 */

import { signatureVerify } from "@polkadot/util-crypto";
import { hexToU8a, stringToU8a } from "@polkadot/util";
import type { Request } from "express";
import { config } from "./config.js";

export interface UploadAuthResult {
  valid: boolean;
  address?: string;
  error?: string;
}

/** Extract and verify upload signature from request headers. */
export function verifyUploadSig(req: Request, contentHash: string): UploadAuthResult {
  const sig = req.headers["x-upload-sig"] as string | undefined;
  const address = req.headers["x-uploader-address"] as string | undefined;
  const tsStr = req.headers["x-upload-ts"] as string | undefined;

  if (!sig || !address || !tsStr) {
    return { valid: false, error: "Missing upload auth headers" };
  }

  const ts = parseInt(tsStr, 10);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(now - ts) > config.uploadSigMaxAgeSec) {
    return { valid: false, error: `Timestamp rejected (skew > ${config.uploadSigMaxAgeSec}s)` };
  }

  const signingString = `materios-upload-v1|${contentHash}|${address}|${ts}`;
  try {
    const result = signatureVerify(stringToU8a(signingString), hexToU8a(sig), address);
    return result.isValid
      ? { valid: true, address }
      : { valid: false, error: "Invalid sr25519 signature" };
  } catch (err) {
    return { valid: false, error: `Sig verify error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
