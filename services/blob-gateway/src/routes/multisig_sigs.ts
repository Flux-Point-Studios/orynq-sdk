/**
 * `POST /v2/multisig_sigs/{kind}/{key}` — cert-daemon publishes its
 * (pubkey, sig) over the canonical STCA / EXPP digest for a claim or
 * intent. Gateway verifies sr25519 + stores. Idempotent on (kind, key,
 * digest, pubkey).
 *
 * `GET  /v2/multisig_sigs/{kind}/{key}` — peer cert-daemons (or anyone)
 * fetch the union of sigs published so far. Optional `?digest=` filter.
 *
 * Closes the M-of-N coordination gap (task #286). See design memo
 * at /home/deci/work/settle-sig-aggregation-design.md.
 *
 * Trust model:
 *   - Each row is self-authenticating (gateway runs sr25519Verify(pubkey,
 *     sig, digest) before storing). Forged rows can't pass.
 *   - Pubkey is NOT checked against the on-chain committee here —
 *     that's `ensure_threshold_signatures`'s job at submit-time. Keeping
 *     it gateway-stateless means the endpoint stays up if the RPC is
 *     degraded.
 *   - No bearer-auth on POST: a daemon's sig over the digest is itself
 *     the credential. Spam is bounded by the periodic 24h TTL cleanup.
 *
 * Failure-mode mapping:
 *   400 — body shape / hex length / unknown kind / unknown key format
 *   401 — signature invalid (sr25519 verify failed)
 *   500 — storage error
 */

import type { Application, Request, Response } from "express";
import { sr25519Verify } from "@polkadot/util-crypto";
import { hexToU8a } from "@polkadot/util";
import {
  listMultisigSigs,
  parseAndValidatePayload,
  parsePathSegments,
  upsertMultisigSig,
} from "../multisig_sigs_store.js";

export function registerMultisigSigsRoutes(app: Application): void {
  app.post(
    "/v2/multisig_sigs/:kind/:key",
    (req: Request, res: Response): void => {
      const path = parsePathSegments(req.params.kind, req.params.key);
      if ("error" in path) {
        res.status(400).json({ error: path.error });
        return;
      }
      const payload = parseAndValidatePayload(req.body);
      if ("error" in payload) {
        res.status(400).json({ error: payload.error });
        return;
      }
      // sr25519 verify — the bytes signed are EXACTLY the 32-byte digest.
      // No envelope/preimage wrapping at this layer: the daemon already
      // hashed (STCA or EXPP preimage) → 32-byte digest.
      let valid = false;
      try {
        valid = sr25519Verify(
          hexToU8a("0x" + payload.digest_hex),
          hexToU8a("0x" + payload.sig_hex),
          hexToU8a("0x" + payload.pubkey_hex),
        );
      } catch {
        valid = false;
      }
      if (!valid) {
        res.status(401).json({ error: "invalid_sig" });
        return;
      }
      try {
        const result = upsertMultisigSig({
          kind: path.kind,
          key_hex: path.key_hex,
          digest_hex: payload.digest_hex,
          pubkey_hex: payload.pubkey_hex,
          sig_hex: payload.sig_hex,
        });
        const expires_at_unix = result.created_at + 86400;
        res.status(200).json({
          ok: true,
          stored: result.stored,
          expires_at_unix,
        });
      } catch (err) {
        console.warn(`[multisig_sigs POST] storage error: ${err}`);
        res.status(500).json({ error: "storage_error" });
      }
    },
  );

  app.get(
    "/v2/multisig_sigs/:kind/:key",
    (req: Request, res: Response): void => {
      const path = parsePathSegments(req.params.kind, req.params.key);
      if ("error" in path) {
        res.status(400).json({ error: path.error });
        return;
      }
      const digestQ = req.query.digest;
      let digestFilter: string | undefined;
      if (typeof digestQ === "string" && digestQ.length > 0) {
        const raw = digestQ.startsWith("0x") ? digestQ.slice(2) : digestQ;
        if (raw.length !== 64 || !/^[0-9a-fA-F]+$/.test(raw)) {
          res.status(400).json({ error: "digest_query_must_be_32_byte_hex" });
          return;
        }
        digestFilter = raw.toLowerCase();
      }
      try {
        const rows = listMultisigSigs(path.kind, path.key_hex, digestFilter);
        res.status(200).json({
          kind: path.kind,
          key: path.key_hex,
          sigs: rows.map((r) => ({
            pubkey: r.pubkey_hex,
            sig: r.sig_hex,
            digest: r.digest_hex,
            created_at: r.created_at,
          })),
          count: rows.length,
        });
      } catch (err) {
        console.warn(`[multisig_sigs GET] storage error: ${err}`);
        res.status(500).json({ error: "storage_error" });
      }
    },
  );
}
