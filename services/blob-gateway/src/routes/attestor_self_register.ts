/**
 * Public route for self-service attestor registration via Android Key
 * Attestation cert chain.
 *
 *   POST /v2/attestor_self_register
 *
 * Body shape:
 *   {
 *     "chain_b64": ["<base64-DER cert>", "<base64-DER cert>", ...],
 *     "pubkey_hex": "0x02...",          // 33-byte compressed P-256
 *     "attest_key_hash_hex": "...",     // sha256(leaf SPKI)
 *     "label": "optional witness label"
 *   }
 *
 * Response shapes:
 *   200 + { status: "created", attestor: {…} }              first time, valid chain
 *   200 + { status: "already-registered", attestor: {…} }   idempotent rerun
 *   400 + { ok: false, code: "...", message: "..." }        verification failure
 *   400 + { ok: false, code: "BODY_INVALID", … }            malformed body
 *
 * Verification logic lives in `../attestor_self_register.ts`. See that
 * module for the threat model and what's deferred to v2 (Google root
 * pinning, full ASN.1 KeyDescription decode).
 *
 * No auth — anyone with a Google-signed KeyMint cert chain can
 * register. Gateway-level rate limiting can be layered in front if
 * abuse appears.
 */

import type { Express, Request, Response } from "express";
import { selfRegisterAttestor } from "../attestor_self_register.js";

export function registerAttestorSelfRegisterRoutes(app: Express): void {
  app.post("/v2/attestor_self_register", (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        chain_b64?: unknown;
        pubkey_hex?: unknown;
        attest_key_hash_hex?: unknown;
        label?: unknown;
      };

      if (!Array.isArray(body.chain_b64)) {
        res.status(400).json({
          ok: false,
          code: "BODY_INVALID",
          message: "chain_b64 must be an array of base64-DER cert strings",
        });
        return;
      }
      if (typeof body.pubkey_hex !== "string") {
        res.status(400).json({
          ok: false,
          code: "BODY_INVALID",
          message: "pubkey_hex must be a string (33-byte compressed P-256 hex, optional 0x prefix)",
        });
        return;
      }
      if (typeof body.attest_key_hash_hex !== "string") {
        res.status(400).json({
          ok: false,
          code: "BODY_INVALID",
          message: "attest_key_hash_hex must be a string (32-byte hex of leaf SPKI sha256)",
        });
        return;
      }

      // Reject obviously absurd inputs early so the verifier doesn't have
      // to allocate massive Buffers.
      if (body.chain_b64.length > 20) {
        res.status(400).json({
          ok: false,
          code: "BODY_INVALID",
          message: "chain_b64 too long (max 20 certs)",
        });
        return;
      }
      for (let i = 0; i < body.chain_b64.length; i++) {
        const c = body.chain_b64[i];
        if (typeof c !== "string" || c.length > 16384) {
          res.status(400).json({
            ok: false,
            code: "BODY_INVALID",
            message: `chain_b64[${i}] must be a string under 16 KiB`,
          });
          return;
        }
      }

      const label =
        typeof body.label === "string" && body.label.trim()
          ? body.label.trim().slice(0, 100)
          : null;

      const outcome = selfRegisterAttestor(
        {
          chain_b64: body.chain_b64 as string[],
          pubkey_hex: body.pubkey_hex,
          attest_key_hash_hex: body.attest_key_hash_hex,
        },
        { label },
      );

      if (outcome.status === "verify-failed") {
        // Return the verifier's specific error code so the phone can
        // surface a useful message ("not a KeyMint cert" vs "pubkey
        // doesn't match SPKI" etc.).
        const r = outcome.result as Exclude<typeof outcome.result, { ok: true }>;
        res.status(400).json(r);
        return;
      }

      console.log(
        `[blob-gateway] attestor self-register status=${outcome.status} ` +
          `pubkey_prefix=${outcome.attestor!.pubkey_hex.slice(0, 16)} ` +
          `chain_len=${(outcome.result as { ok: true; chainLength: number }).chainLength}`,
      );

      res.status(200).json({
        status: outcome.status,
        attestor: {
          id: outcome.attestor!.id,
          pubkey_hex: outcome.attestor!.pubkey_hex,
          label: outcome.attestor!.label,
          sig_algo: outcome.attestor!.sig_algo,
          registered_at: outcome.attestor!.registered_at,
          revoked_at: outcome.attestor!.revoked_at,
        },
        chain_length: (outcome.result as { ok: true; chainLength: number }).chainLength,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[blob-gateway] self-register threw: ${msg}`);
      res.status(500).json({ ok: false, error: msg });
    }
  });
}
