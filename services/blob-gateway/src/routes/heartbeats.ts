/**
 * Heartbeat routes — validators report liveness with sr25519-signed heartbeats.
 *
 * POST /heartbeats        — Accepts Bearer / x-api-key / sr25519 sig; validates signature + seq
 * GET  /heartbeats/status — Public, returns validator liveness summary
 *
 * Auth (PR #129): unified via `resolveAuth` for the account-bound tiers
 * (Bearer token → legacy x-api-key), then falls through to the heartbeat-
 * specific sr25519 `x-heartbeat-sig` path for keyless validators. The
 * heartbeat-sig scheme signs a different payload than upload-sig
 * (`materios-heartbeat-v1|...` vs `materios-upload-v1|...`) and uses a
 * different header, so we cannot collapse it into resolveAuth without
 * breaking the cert-daemon wire format.
 */

import { Router, type Request, type Response } from "express";
import { signatureVerify } from "@polkadot/util-crypto";
import { stringToU8a } from "@polkadot/util";
import { lookupValidatorInfo, listAllAuraBindings } from "../quota.js";
import { resolveAuth } from "../auth.js";
import {
  upsertHeartbeat,
  getLastSeq,
  getAllLatest,
  logReject,
  appendHeartbeatLog,
  type HeartbeatRow,
} from "../heartbeat-store.js";

export const heartbeatsRouter = Router();

/* ---------- In-memory rate limiter ---------- */

/** Map<validatorId, lastPostEpochMs> */
const lastPostTime = new Map<string, number>();
const MIN_POST_INTERVAL_MS = 10_000; // 10 seconds

/* ---------- GET cache ---------- */

interface StatusResponse {
  validators: Record<string, ValidatorStatus>;
  summary: { total: number; online: number; degraded: number; offline: number };
  /**
   * Task #94 — aura → cert-daemon-signer bindings. The explorer's Validators
   * tab uses these to render heartbeat status for operators running cert-
   * daemon and validator on SEPARATE keys.
   *
   * Each entry maps a validator's authoring (aura) SS58 to the SS58 of the
   * cert-daemon signer whose heartbeat status should be displayed for that
   * validator. The cert-daemon SS58 is the api_keys.validator_id of the
   * row whose bound_validator_aura matches the aura.
   *
   * Empty object when no bindings have been registered. Forward-compatible:
   * old explorer instances ignore the field, new ones JOIN by aura SS58.
   */
  bindings: Record<string, { certDaemonSs58: string; label: string }>;
}

interface ValidatorStatus {
  label: string;
  status: "online" | "degraded" | "offline";
  verified: true;
  verified_mode: "sig_only";
  age_secs: number;
  seq: number;
  best_block: number;
  finalized_block: number;
  finality_gap: number;
  pending_receipts: number;
  certs_submitted: number;
  substrate_connected: boolean;
  version: string;
  uptime_seconds: number;
  clock_skew_secs: number;
}

let cachedStatusResponse: StatusResponse | null = null;
let cachedStatusTime = 0;
const STATUS_CACHE_TTL_MS = 10_000; // 10 seconds

/* ---------- POST /heartbeats ---------- */

heartbeatsRouter.post("/heartbeats", async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "Invalid body: expected JSON object" });
      return;
    }

    const {
      validator_id,
      seq,
      timestamp,
      best_block,
      finalized_block,
      finality_gap,
      pending_receipts,
      certs_submitted,
      substrate_connected,
      version,
      uptime_seconds,
    } = body;

    // Validate required fields
    if (typeof validator_id !== "string" || !validator_id) {
      res.status(400).json({ error: "Missing or invalid validator_id" });
      return;
    }
    if (typeof seq !== "number" || !Number.isInteger(seq)) {
      res.status(400).json({ error: "Missing or invalid seq (must be integer)" });
      return;
    }
    if (typeof timestamp !== "number") {
      res.status(400).json({ error: "Missing or invalid timestamp" });
      return;
    }
    if (typeof best_block !== "number" || !Number.isInteger(best_block)) {
      res.status(400).json({ error: "Missing or invalid best_block" });
      return;
    }

    const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";

    // --- AUTH: Bearer token → legacy x-api-key → sr25519 x-heartbeat-sig ---
    //
    // resolveAuth() handles Bearer (priority 0) and x-api-key (priority 1).
    // We call it without a contentHash so its upload-sig branch is skipped —
    // heartbeats use `x-heartbeat-sig` with a completely different signing
    // payload, which we handle as a parallel fallback below.
    //
    // If neither a Bearer nor an x-api-key header is present, resolveAuth
    // returns `authenticated: false` with error "No authentication
    // provided" — that's our signal to fall through to the sig path.
    // An INVALID api-key or Bearer short-circuits with 401 here so the
    // cert-daemon's `401 Invalid or disabled API key` contract survives.
    const hasAccountAuthHeader =
      typeof req.headers.authorization === "string" ||
      typeof req.headers["x-api-key"] === "string";

    let label: string | undefined;
    let authTier: "bearer" | "api-key" | "api-key-legacy-ss58" | "sig-only" | undefined;

    if (hasAccountAuthHeader) {
      const auth = await resolveAuth(req);
      if (!auth.authenticated) {
        // Wire-format preserved: "Invalid or disabled API key" for legacy
        // x-api-key clients; bearer errors surface their own verbose reason.
        res.status(401).json({ error: auth.error ?? "Invalid or disabled API key" });
        return;
      }

      // Bearer / api-key / api-key-legacy-ss58 tiers carry an identity.
      // Enforce the validator_id binding: if the auth maps to a specific
      // SS58 (either via keyInfo.validatorId or the bearer's accountSs58),
      // the body's validator_id must match. Same 403 as the old code.
      const boundSs58 =
        auth.keyInfo?.validatorId ?? (auth.tier === "bearer" ? auth.identity : undefined);
      if (boundSs58 && validator_id !== boundSs58) {
        logReject(validator_id, "validator_id mismatch with auth binding", ip);
        res.status(403).json({ error: "validator_id does not match API key binding" });
        return;
      }

      // Label preference: KeyInfo.name (named operator row) > registered
      // validator name > the raw identity SS58. Matches the prior behaviour
      // where `keyInfo.name` was used for api-key flows; for Bearer tokens
      // with no api_keys row, we fall back to the validator registry.
      if (auth.keyInfo) {
        label = auth.keyInfo.name;
      } else {
        const info = lookupValidatorInfo(validator_id);
        label = info ? info.name : (auth.identity ?? validator_id);
      }
      authTier = auth.tier as typeof authTier;
    } else {
      // Keyless path: validator must be in registry, sig is the real auth.
      const info = lookupValidatorInfo(validator_id);
      if (!info) {
        logReject(validator_id, "unregistered validator (no API key, not in registry)", ip);
        res.status(403).json({ error: "Validator not registered" });
        return;
      }
      label = info.name;
      authTier = "sig-only";
    }

    // Rate limit: reject if < 10s since last POST for this validator
    const now = Date.now();
    const lastTime = lastPostTime.get(validator_id);
    if (lastTime && (now - lastTime) < MIN_POST_INTERVAL_MS) {
      res.status(429).json({
        error: "Rate limited: minimum 10s between heartbeats",
        retry_after_secs: Math.ceil((MIN_POST_INTERVAL_MS - (now - lastTime)) / 1000),
      });
      return;
    }

    // Clock skew check: |timestamp - now| <= 120s
    const nowSecs = Math.floor(now / 1000);
    const clockSkew = timestamp - nowSecs;
    if (Math.abs(clockSkew) > 120) {
      logReject(validator_id, `clock skew too large: ${clockSkew}s`, ip);
      res.status(400).json({ error: "Clock skew exceeds 120 seconds", clock_skew_secs: clockSkew });
      return;
    }

    // Sequence check: seq must be > last_seq
    const lastSeq = getLastSeq(validator_id);
    if (lastSeq !== undefined && seq <= lastSeq) {
      res.status(409).json({
        error: "Sequence number replay or stale",
        last_seq: lastSeq,
        received_seq: seq,
      });
      return;
    }

    // Verify sr25519 signature. This is REQUIRED for every heartbeat — even
    // Bearer/api-key flows must supply `x-heartbeat-sig`, because the sig is
    // what binds the heartbeat payload to the validator's key. The bearer
    // token only authenticates the account; the sig proves the
    // payload-integrity + non-replay of this specific beat.
    const signature = req.headers["x-heartbeat-sig"] as string | undefined;
    if (!signature) {
      logReject(validator_id, "missing x-heartbeat-sig header", ip);
      res.status(400).json({ error: "Missing x-heartbeat-sig header" });
      return;
    }

    // Build canonical signing string
    // substrate_connected: daemon sends boolean, signing string uses 1/0 integer
    const scInt = substrate_connected ? 1 : 0;
    const signingString = [
      "materios-heartbeat-v1",
      validator_id,
      String(seq),
      String(timestamp),
      String(best_block),
      String(finalized_block ?? 0),
      String(finality_gap ?? 0),
      String(pending_receipts ?? 0),
      String(certs_submitted ?? 0),
      String(scInt),
      String(version ?? ""),
      String(uptime_seconds ?? 0),
    ].join("|");

    const sigBytes = stringToU8a(signingString);
    const result = signatureVerify(sigBytes, signature, validator_id);

    if (!result.isValid) {
      logReject(validator_id, "invalid sr25519 signature", ip);
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    // All checks passed — upsert heartbeat
    upsertHeartbeat(
      validator_id,
      label ?? validator_id, // label from registry/key, NOT from body
      seq,
      JSON.stringify(body), // store full payload
      signature,
      best_block,
      finalized_block ?? 0,
      finality_gap ?? 0,
      pending_receipts ?? 0,
      certs_submitted ?? 0,
      scInt,
      version ?? "",
      uptime_seconds ?? 0,
      clockSkew,
    );

    appendHeartbeatLog(validator_id, best_block);
    lastPostTime.set(validator_id, now);

    // Invalidate status cache on new heartbeat
    cachedStatusResponse = null;

    // auth_tier is informational only — clients have historically ignored
    // unknown response fields, and surfacing it helps operators debug which
    // header was accepted during migration.
    res.status(200).json({ status: "ok", seq, clock_skew_secs: clockSkew, auth_tier: authTier });
  } catch (error) {
    console.error("[blob-gateway] Heartbeat POST error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

/* ---------- GET /heartbeats/seq/:validatorId ---------- */

heartbeatsRouter.get("/heartbeats/seq/:validatorId", (req: Request, res: Response) => {
  try {
    const { validatorId } = req.params;
    const lastSeq = getLastSeq(validatorId);
    res.json({ validator_id: validatorId, last_seq: lastSeq ?? 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

/* ---------- GET /heartbeats/status ---------- */

heartbeatsRouter.get("/heartbeats/status", (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (cachedStatusResponse && (now - cachedStatusTime) < STATUS_CACHE_TTL_MS) {
      res.json(cachedStatusResponse);
      return;
    }

    const rows = getAllLatest();
    const validators: Record<string, ValidatorStatus> = {};
    let online = 0;
    let degraded = 0;
    let offline = 0;

    for (const row of rows) {
      const ageSecs = computeAgeSecs(row);
      const status = classifyStatus(ageSecs);

      if (status === "online") online++;
      else if (status === "degraded") degraded++;
      else offline++;

      validators[row.validator_id] = {
        label: row.label,
        status,
        verified: true,
        verified_mode: "sig_only",
        age_secs: ageSecs,
        seq: row.seq,
        best_block: row.best_block,
        finalized_block: row.finalized_block,
        finality_gap: row.finality_gap,
        pending_receipts: row.pending_receipts,
        certs_submitted: row.certs_submitted,
        substrate_connected: !!row.substrate_connected,
        version: row.version,
        uptime_seconds: row.uptime_seconds,
        clock_skew_secs: row.clock_skew_secs,
      };
    }

    // Task #94: pull bindings inline so the explorer doesn't need a second
    // round-trip per validator row. Empty object when nothing is registered.
    let bindings: Record<string, { certDaemonSs58: string; label: string }> = {};
    try {
      bindings = listAllAuraBindings();
    } catch (err) {
      // Defensive: a "no such column" on bound_validator_aura would mean
      // migrateBindingColumn() didn't run — log and continue with an empty
      // map so the rest of the response is still served.
      console.warn("[blob-gateway] listAllAuraBindings failed:", err);
    }

    const response: StatusResponse = {
      validators,
      summary: {
        total: rows.length,
        online,
        degraded,
        offline,
      },
      bindings,
    };

    cachedStatusResponse = response;
    cachedStatusTime = now;
    res.json(response);
  } catch (error) {
    console.error("[blob-gateway] Heartbeat status error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

/* ---------- Helpers ---------- */

function computeAgeSecs(row: HeartbeatRow): number {
  const receivedMs = new Date(row.received_at).getTime();
  return Math.round((Date.now() - receivedMs) / 1000);
}

function classifyStatus(ageSecs: number): "online" | "degraded" | "offline" {
  // Heartbeats fire every 30s. Allow generous windows to avoid
  // flapping from single missed beats or network blips.
  if (ageSecs < 90) return "online";     // 3 heartbeat cycles
  if (ageSecs <= 300) return "degraded";  // 10 cycles (5 min)
  return "offline";                       // truly gone
}
