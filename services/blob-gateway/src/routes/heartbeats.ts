/**
 * Heartbeat routes — validators report liveness with sr25519-signed heartbeats.
 *
 * POST /heartbeats        — API-key-protected, validates signature + seq
 * GET  /heartbeats/status — Public, returns validator liveness summary
 */

import { Router, type Request, type Response } from "express";
import { signatureVerify } from "@polkadot/util-crypto";
import { stringToU8a } from "@polkadot/util";
import { resolveKey, lookupValidatorInfo } from "../quota.js";
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

heartbeatsRouter.post("/heartbeats", (req: Request, res: Response) => {
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

    // --- AUTH: API key OR signature-only with registered validator ---
    const apiKey = req.headers["x-api-key"] as string | undefined;
    let label: string;

    if (apiKey) {
      // Traditional path: validate API key + binding
      const keyInfo = resolveKey(apiKey);
      if (!keyInfo) {
        res.status(401).json({ error: "Invalid or disabled API key" });
        return;
      }
      if (keyInfo.validatorId && validator_id !== keyInfo.validatorId) {
        logReject(validator_id, "validator_id mismatch with API key binding", ip);
        res.status(403).json({ error: "validator_id does not match API key binding" });
        return;
      }
      label = keyInfo.name;
    } else {
      // Keyless path: validator must be in registry, sig is the real auth
      const info = lookupValidatorInfo(validator_id);
      if (!info) {
        logReject(validator_id, "unregistered validator (no API key, not in registry)", ip);
        res.status(403).json({ error: "Validator not registered" });
        return;
      }
      label = info.name;
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
      const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";
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

    // Verify sr25519 signature
    const signature = req.headers["x-heartbeat-sig"] as string | undefined;
    if (!signature) {
      const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";
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
      const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";
      logReject(validator_id, "invalid sr25519 signature", ip);
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    // All checks passed — upsert heartbeat
    upsertHeartbeat(
      validator_id,
      label,               // label from registry, NOT from body
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

    res.status(200).json({ status: "ok", seq, clock_skew_secs: clockSkew });
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

    const response: StatusResponse = {
      validators,
      summary: {
        total: rows.length,
        online,
        degraded,
        offline,
      },
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
