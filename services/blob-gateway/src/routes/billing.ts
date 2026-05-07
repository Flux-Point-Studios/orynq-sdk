/**
 * `GET /billing/usage` — verifiable compute-metering billing query.
 *
 * Customer query path. Computes the bill from cryptographically-attested
 * usage records that landed at the gateway via `POST /metering/submit`,
 * cross-checking each record's chain status (Materios `submit_receipt_v2`
 * → optional cert-daemon attestation) and Cardano L1 anchor tx (cert-daemon
 * checkpoint-history.json + anchor-worker log).
 *
 * Query parameters
 * ----------------
 *   tenant_id        REQUIRED   `[a-z0-9-]{4,64}` — same shape as the
 *                                schema's `tenant_id` field.
 *   start_ms         REQUIRED   integer; window start, INCLUSIVE.
 *   end_ms           REQUIRED   integer; window end, EXCLUSIVE.
 *                               Window: 0 < end_ms - start_ms <= 90 days.
 *   include_records  optional   "true" | "false" (default false). When
 *                                false, only the `aggregate` block is
 *                                returned — no per-record fan-out.
 *   page_size        optional   1 ≤ N ≤ 500, default 100.
 *   cursor           optional   opaque pagination cursor returned as
 *                                `next_cursor` from a previous response.
 *
 * Time-window semantics
 * ---------------------
 *   Records are filtered by `period_start_ms` (worker-claimed window
 *   start), NOT `submitted_at_ms` (gateway ingest time). A record with
 *   `period_start_ms === start_ms` IS included; one with
 *   `period_start_ms === end_ms` is NOT. This matches what customers
 *   expect: "show me usage for April" should include records that say
 *   "I worked April 1 → April 1+1h" but not "I worked April 30 → May 1".
 *
 * Empty-result contract
 * ---------------------
 *   "No records in the window" returns 200 with a zero-aggregate, NOT
 *   404. We can't distinguish "tenant doesn't exist" from "tenant exists
 *   but has zero usage", and reserving 404 for a state we can't detect
 *   would break the contract. Always 200, always a usable shape.
 *
 * Auth
 * ----
 *   Authorization: Bearer matra_<token>. We inline-verify the token here
 *   (instead of using the shared `bearerAuth` middleware) so we can pull
 *   the optional `tenantId` binding off the verify result and enforce
 *   cross-tenant isolation per task #119. x-api-key auth is intentionally
 *   NOT supported on this route — tenant binding lives on api_tokens, and
 *   the legacy x-api-key path uses a different table without a tenant_id
 *   column.
 *
 *   Task #119 — cross-tenant isolation:
 *     - Token has NO tenant_id (legacy/admin) → allow any tenant_id query.
 *     - Token tenant_id === query.tenant_id → 200.
 *     - Token tenant_id !== query.tenant_id → 403 TOKEN_TENANT_MISMATCH.
 *
 * Errors (uniform JSON `{ ok: false, error, ... }`):
 *   400 `MISSING_PARAM` — tenant_id / start_ms / end_ms missing or wrong type
 *   400 `BAD_PARAM`     — value out of range / fails validation
 *   400 `BAD_WINDOW`    — end_ms <= start_ms or window > 90 days
 *   401 `UNAUTHENTICATED` — no Bearer / malformed Bearer / token revoked
 *   403 `TOKEN_TENANT_MISMATCH` — token bound to a different tenant (#119)
 *   500 `INTERNAL`      — uncaught error path
 */

import { Router, type Request, type Response } from "express";
import { verifyToken, getApiTokensDb, TOKEN_PREFIX } from "../api-tokens.js";
import {
  getMeteringSubmissions,
  type MeteringSubmissionRow,
} from "../worker_bounds.js";
import {
  aggregateRecords,
  buildNextCursor,
  decodeCursor,
  type AggregatableRecord,
  type AttestationStatus,
} from "../billing/aggregate.js";
import {
  queryReceiptStatuses,
  queryCompositeTrustScores,
  receiptIdFromContentHash,
  type ChainStatus,
  type ChainTrustScore,
} from "../billing/chain_query.js";
import { resolveAnchorTxs } from "../billing/anchor_resolver.js";
import { SCHEMA_HASH_HEX } from "../schemas/compute_metering_v1.js";

export const billingRouter = Router();

/** Same regex as the schema validator's `tenant_id` check. */
const ID_REGEX = /^[a-z0-9-]{4,64}$/;
/** 90 days in milliseconds — window-size cap. */
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

/**
 * Parse a string into a positive integer or return null if it can't be
 * coerced cleanly. We reject NaN, floats, and negative values so the
 * client sees a 400 instead of an off-by-1e6 silent bug.
 */
function parseIntStrict(s: unknown): number | null {
  if (typeof s !== "string") return null;
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n)) return null;
  return n;
}

/**
 * Return a typed `{ ok: false, error, field?, message }` body. The status
 * code is the caller's responsibility — keeps the helper composable.
 */
function badRequest(
  res: Response,
  error: string,
  field: string,
  message: string,
): void {
  res.status(400).json({
    ok: false,
    error,
    field,
    message,
  });
}

/**
 * Convert a stored row + chain status + anchor tx + composite-trust score
 * into the per-record response shape. Pure — no IO. Exported for tests.
 *
 * `compositeTrustScore` is `number | null`. `null` means the chain query
 * failed; `0` means the chain confirms no TEE evidence yet (committee-
 * attested baseline). The two are semantically distinct — see
 * `chain_query.ts::ChainTrustScore` for the full level table.
 */
export function rowToRecordResponse(
  row: MeteringSubmissionRow,
  chain: ChainStatus,
  anchorTx: string | null,
  compositeTrustScore: number | null,
): {
  worker_id: string;
  period_start_ms: number;
  period_end_ms: number;
  content_hash: string;
  receipt_id: string | null;
  schema_hash: string;
  attestation_cert_hash: string | null;
  attestation_status: AttestationStatus;
  cardano_anchor_tx: string | null;
  composite_trust_score: number | null;
  metrics: {
    cpu_seconds: number;
    ram_gb_hours: number;
    disk_gb_hours: number;
    net_bytes_in: number;
    net_bytes_out: number;
    gpu_seconds: number;
  };
} {
  return {
    worker_id: row.worker_id,
    period_start_ms: row.period_start_ms,
    period_end_ms: row.period_end_ms,
    content_hash: row.content_hash,
    // receipt_id is deterministic from content_hash, so we surface it even
    // when the chain leg hasn't landed (status="unknown") — handy for
    // customers who want to look up the receipt later via SDK without
    // re-deriving the id themselves. When status is "unknown" we still
    // return the LOCALLY-derived id (truthful: this is what it WILL be).
    receipt_id: chain.receipt_id,
    schema_hash: SCHEMA_HASH_HEX,
    attestation_cert_hash: chain.cert_hash,
    attestation_status: chain.status,
    // Anchor tx hash is null unless EVERY leg succeeded:
    //   1. record certified on Materios (chain.status === "certified")
    //   2. cert_hash present (chain.cert_hash !== null)
    //   3. resolver matched a Cardano tx
    // Items (1) and (2) imply each other — keep the explicit AND so the
    // intent reads cleanly.
    cardano_anchor_tx:
      chain.status === "certified" && chain.cert_hash !== null && anchorTx
        ? anchorTx.startsWith("0x")
          ? anchorTx
          : "0x" + anchorTx
        : null,
    composite_trust_score: compositeTrustScore,
    metrics: {
      cpu_seconds: row.cpu_seconds,
      ram_gb_hours: row.ram_gb_hours,
      disk_gb_hours: row.disk_gb_hours,
      net_bytes_in: row.net_bytes_in,
      net_bytes_out: row.net_bytes_out,
      gpu_seconds: row.gpu_seconds,
    },
  };
}

/**
 * Wire-up note: bearerAuth is applied per-route (not at router level) so
 * other downstream handlers under `/billing` can have different auth in
 * the future without an `unless()`-style escape hatch.
 */
billingRouter.get(
  "/billing/usage",
  async (req: Request, res: Response) => {
    try {
      const t0 = Date.now();

      // ---------- inline bearer auth (#119: tenant binding is checked
      // post-auth, pre-aggregation; the shared `bearerAuth` middleware
      // doesn't surface verify.tenantId, so we verify here directly).
      const authHeader = (req.headers.authorization ||
        (req.headers as Record<string, unknown>)["Authorization"]) as
        | string
        | undefined;
      if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
        res
          .status(401)
          .json({ error: "authentication required (Bearer token)" });
        return;
      }
      const token = authHeader.slice("Bearer ".length).trim();
      if (!token.startsWith(TOKEN_PREFIX)) {
        res.status(401).json({ error: "invalid bearer token: malformed" });
        return;
      }
      const verify = verifyToken(getApiTokensDb(), token);
      if (!verify.valid) {
        res
          .status(401)
          .json({ error: `invalid bearer token: ${verify.reason}` });
        return;
      }

      // ---------- query param parsing ----------
      const tenant_id_raw = req.query.tenant_id;
      const start_raw = req.query.start_ms;
      const end_raw = req.query.end_ms;

      if (typeof tenant_id_raw !== "string" || tenant_id_raw === "") {
        badRequest(
          res,
          "MISSING_PARAM",
          "tenant_id",
          "tenant_id is required",
        );
        return;
      }
      if (!ID_REGEX.test(tenant_id_raw)) {
        badRequest(
          res,
          "BAD_PARAM",
          "tenant_id",
          `tenant_id must match [a-z0-9-]{4,64}, got "${tenant_id_raw}"`,
        );
        return;
      }

      // ---------- task #119: cross-tenant isolation ----------
      // Token has NO tenant_id (legacy/admin) → allow any tenant_id query.
      // Token tenant_id === query.tenant_id → fall through to aggregation.
      // Token tenant_id !== query.tenant_id → 403.
      const boundTenant = verify.tenantId ?? null;
      if (boundTenant !== null && boundTenant !== tenant_id_raw) {
        console.warn(
          `[blob-gateway] billing-tenant-mismatch tokenHash=${verify.tokenHash.slice(0, 16)}... boundTenant=${boundTenant} requestedTenant=${tenant_id_raw}`,
        );
        res.status(403).json({
          error: "TOKEN_TENANT_MISMATCH",
          message:
            "Bearer token is bound to a different tenant than the requested tenant_id",
        });
        return;
      }

      if (typeof start_raw !== "string") {
        badRequest(res, "MISSING_PARAM", "start_ms", "start_ms is required");
        return;
      }
      if (typeof end_raw !== "string") {
        badRequest(res, "MISSING_PARAM", "end_ms", "end_ms is required");
        return;
      }
      const start_ms = parseIntStrict(start_raw);
      if (start_ms === null || start_ms < 0) {
        badRequest(
          res,
          "BAD_PARAM",
          "start_ms",
          "start_ms must be a non-negative integer",
        );
        return;
      }
      const end_ms = parseIntStrict(end_raw);
      if (end_ms === null || end_ms < 0) {
        badRequest(
          res,
          "BAD_PARAM",
          "end_ms",
          "end_ms must be a non-negative integer",
        );
        return;
      }
      if (end_ms <= start_ms) {
        res.status(400).json({
          ok: false,
          error: "BAD_WINDOW",
          field: "end_ms",
          message: "end_ms must be > start_ms",
        });
        return;
      }
      if (end_ms - start_ms > MAX_WINDOW_MS) {
        res.status(400).json({
          ok: false,
          error: "BAD_WINDOW",
          field: "end_ms",
          message: `window must be <= ${MAX_WINDOW_MS} ms (90 days)`,
        });
        return;
      }

      const include_records_raw = req.query.include_records;
      const include_records =
        include_records_raw === "true" || include_records_raw === "1";

      let page_size = DEFAULT_PAGE_SIZE;
      if (typeof req.query.page_size === "string") {
        const n = parseIntStrict(req.query.page_size);
        if (n === null || n < 1 || n > MAX_PAGE_SIZE) {
          badRequest(
            res,
            "BAD_PARAM",
            "page_size",
            `page_size must be an integer in [1, ${MAX_PAGE_SIZE}]`,
          );
          return;
        }
        page_size = n;
      }

      let after: { period_start_ms: number; content_hash: string } | undefined;
      if (typeof req.query.cursor === "string" && req.query.cursor !== "") {
        const decoded = decodeCursor(req.query.cursor);
        if (decoded === null) {
          badRequest(
            res,
            "BAD_PARAM",
            "cursor",
            "cursor is malformed or stale",
          );
          return;
        }
        after = decoded;
      }

      // ---------- gateway-db read ----------
      const dbStart = Date.now();
      const rows = getMeteringSubmissions({
        tenant_id: tenant_id_raw,
        start_ms,
        end_ms,
        // page_size+1 is a common pagination idiom but we keep it simple:
        // ask for exactly page_size; if the result equals page_size we
        // assume "could be more" and emit a cursor. False positives (a
        // page exactly at the boundary returns an extra round-trip with
        // 0 rows) are acceptable; better than mis-counting.
        limit: page_size,
        after,
      });
      const gateway_db_query_ms = Date.now() - dbStart;

      // ---------- chain queries (status + composite trust score) ----------
      // The two queries hit independent storage maps
      // (`orinqReceipts.receipts` and `teeAttestation.compositeTrustScores`)
      // and don't share data dependencies, so we issue them concurrently
      // — total latency is max(status, trust) instead of sum. Substrate's
      // WS connection multiplexes the requests fine.
      const chainStart = Date.now();
      const contentHashes = rows.map((r) => r.content_hash);
      const [chainStatuses, trustScores] = await Promise.all([
        queryReceiptStatuses(contentHashes),
        queryCompositeTrustScores(contentHashes),
      ]);
      const chain_query_ms = Date.now() - chainStart;
      // Build a content_hash → status map for O(1) merge below.
      const chainByContent = new Map<string, ChainStatus>();
      for (const cs of chainStatuses) chainByContent.set(cs.content_hash, cs);
      // Same shape for the trust scores. Use the dedicated `trustByContent`
      // so we don't conflate the two map types in the merge below.
      const trustByContent = new Map<string, ChainTrustScore>();
      for (const ts of trustScores) trustByContent.set(ts.content_hash, ts);

      // ---------- anchor resolution ----------
      const anchorStart = Date.now();
      const certHashes = chainStatuses.map((s) => s.cert_hash);
      const anchorTxs = await resolveAnchorTxs(certHashes);
      const anchor_resolution_ms = Date.now() - anchorStart;
      const anchorByCert = new Map<string, string | null>();
      for (let i = 0; i < chainStatuses.length; i++) {
        const cs = chainStatuses[i];
        if (cs.cert_hash) {
          anchorByCert.set(cs.cert_hash, anchorTxs[i] ?? null);
        }
      }

      // ---------- merge into AggregatableRecord[] ----------
      const aggRecords: AggregatableRecord[] = rows.map((r) => {
        const chain =
          chainByContent.get(r.content_hash) ??
          ({
            content_hash: r.content_hash,
            receipt_id: receiptIdFromContentHash(r.content_hash),
            status: "unknown" as AttestationStatus,
            cert_hash: null,
          } satisfies ChainStatus);
        const anchor =
          chain.status === "certified" && chain.cert_hash
            ? anchorByCert.get(chain.cert_hash) ?? null
            : null;
        // Trust score: explicit `?? null` so a missing map entry (which
        // shouldn't happen — every input content_hash gets a row in the
        // dedup'd query result) collapses to "unknown" rather than
        // throwing. Default-zero would be WRONG: it would lie that the
        // chain confirmed no evidence when in fact we never asked.
        const trustScore =
          trustByContent.get(r.content_hash)?.composite_trust_score ?? null;
        return {
          worker_id: r.worker_id,
          tenant_id: r.tenant_id,
          period_start_ms: r.period_start_ms,
          period_end_ms: r.period_end_ms,
          cpu_seconds: r.cpu_seconds,
          ram_gb_hours: r.ram_gb_hours,
          disk_gb_hours: r.disk_gb_hours,
          net_bytes_in: r.net_bytes_in,
          net_bytes_out: r.net_bytes_out,
          gpu_seconds: r.gpu_seconds,
          attestation_status: chain.status,
          cardano_anchor_tx: anchor,
          composite_trust_score: trustScore,
        };
      });

      const aggregate = aggregateRecords(aggRecords);

      const responseRecords = include_records
        ? rows.map((r) => {
            const chain =
              chainByContent.get(r.content_hash) ??
              ({
                content_hash: r.content_hash,
                receipt_id: receiptIdFromContentHash(r.content_hash),
                status: "unknown" as AttestationStatus,
                cert_hash: null,
              } satisfies ChainStatus);
            const anchor =
              chain.status === "certified" && chain.cert_hash
                ? anchorByCert.get(chain.cert_hash) ?? null
                : null;
            const trustScore =
              trustByContent.get(r.content_hash)?.composite_trust_score ??
              null;
            return rowToRecordResponse(r, chain, anchor, trustScore);
          })
        : undefined;

      const next_cursor = buildNextCursor(
        rows.map((r) => ({
          period_start_ms: r.period_start_ms,
          content_hash: r.content_hash,
        })),
        page_size,
      );

      // Audit-trail tail — keeps the timing breakdown visible to clients
      // verifying the response. SCHEMA_HASH_HEX is constant but echoed so
      // client tooling doesn't need to import it from the schema package.
      const responseBody: Record<string, unknown> = {
        tenant_id: tenant_id_raw,
        period: {
          start_ms,
          end_ms,
          now_ms: t0,
        },
        aggregate,
        next_cursor,
        audit_trail: {
          schema_hash: SCHEMA_HASH_HEX,
          gateway_db_query_ms,
          chain_query_ms,
          anchor_resolution_ms,
        },
      };
      if (responseRecords) {
        responseBody.records = responseRecords;
      }
      res.status(200).json(responseBody);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[blob-gateway] /billing/usage unexpected error: ${msg}`);
      res.status(500).json({
        ok: false,
        error: "INTERNAL",
        message: "internal error",
      });
    }
  },
);
