/**
 * Operator registration routes — invite-only flow.
 *
 * POST /operators/register
 *   - Redeems an invite token
 *   - Binds operator SS58 address to a new API key
 *   - Returns the plaintext API key (shown once, never stored)
 *
 * GET /operators/status/:ss58
 *   - Public: check registration status for an address
 *
 * PATCH /operators/:ss58/session-keys
 *   - Reports session keys (Aura + Grandpa) and peer ID after node sync
 *   - Called by install.sh after author_rotateKeys completes
 */

import { Router, type Request, type Response } from "express";
import { randomBytes, createHash } from "crypto";
import Database from "better-sqlite3";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { config } from "../config.js";

export const operatorsRouter = Router();

// ── Invite store (SQLite, same PVC as quota.db) ────────────────────────────

let db: Database.Database;

/**
 * Expose the operators-db handle so other modules (api-tokens) can share
 * the same SQLite connection instead of opening a second handle on the
 * same file.
 */
export function getOperatorsDb(): Database.Database {
  if (!db) {
    throw new Error("operators db not initialised — call initOperatorsDb() first");
  }
  return db;
}

interface InviteRow {
  token_hash: string;
  label: string;
  created_at: string;
  redeemed_at: string | null;
  redeemed_by: string | null;
  max_receipts_per_day: number;
  max_bytes_per_day: number;
  max_concurrent_uploads: number;
}

export function initOperatorsDb(): void {
  const dbPath = join(config.storagePath, "operators.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      token_hash TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      redeemed_at TEXT,
      redeemed_by TEXT,
      max_receipts_per_day INTEGER NOT NULL DEFAULT 500,
      max_bytes_per_day INTEGER NOT NULL DEFAULT 5368709120,
      max_concurrent_uploads INTEGER NOT NULL DEFAULT 5
    );

    CREATE TABLE IF NOT EXISTS registrations (
      ss58_address TEXT PRIMARY KEY,
      public_key TEXT,
      label TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      invite_token_hash TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      approved_at TEXT,
      status TEXT NOT NULL DEFAULT 'registered',
      session_keys TEXT,
      peer_id TEXT
    );
  `);

  // Migrate existing databases that lack the new columns
  const cols = db.prepare("PRAGMA table_info(registrations)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("session_keys")) {
    db.exec("ALTER TABLE registrations ADD COLUMN session_keys TEXT");
  }
  if (!colNames.has("peer_id")) {
    db.exec("ALTER TABLE registrations ADD COLUMN peer_id TEXT");
  }
}

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Create an invite token (called by admin scripts, not HTTP).
 * Returns the plaintext token (shown once).
 */
export function createInvite(label: string, quotas?: {
  maxReceiptsPerDay?: number;
  maxBytesPerDay?: number;
  maxConcurrentUploads?: number;
}): string {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);

  db.prepare(`
    INSERT INTO invites (token_hash, label, created_at, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    tokenHash,
    label,
    new Date().toISOString(),
    quotas?.maxReceiptsPerDay ?? 500,
    quotas?.maxBytesPerDay ?? 5_368_709_120,
    quotas?.maxConcurrentUploads ?? 5,
  );

  return token;
}

// ── Routes ──────────────────────────────────────────────────────────────────

operatorsRouter.post("/operators/register", (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "Invalid body: expected JSON object" });
      return;
    }

    const { invite_token, ss58_address, public_key, label } = body as {
      invite_token?: string;
      ss58_address?: string;
      public_key?: string;
      label?: string;
    };

    // Validate required fields
    if (!invite_token || typeof invite_token !== "string") {
      res.status(400).json({ error: "Missing or invalid invite_token" });
      return;
    }
    if (!ss58_address || typeof ss58_address !== "string") {
      res.status(400).json({ error: "Missing or invalid ss58_address" });
      return;
    }
    // Basic SS58 format check (starts with 5 or 1, 46-48 chars)
    if (!/^[15][a-zA-Z0-9]{45,47}$/.test(ss58_address)) {
      res.status(400).json({ error: "Invalid SS58 address format" });
      return;
    }

    const operatorLabel = (typeof label === "string" && label.trim()) ? label.trim().slice(0, 64) : "operator";

    // Check invite token
    const tokenHash = hashToken(invite_token);
    const invite = db.prepare(
      "SELECT * FROM invites WHERE token_hash = ?",
    ).get(tokenHash) as InviteRow | undefined;

    if (!invite) {
      res.status(403).json({ error: "Invalid invite token" });
      return;
    }
    if (invite.redeemed_at) {
      res.status(409).json({ error: "Invite token already redeemed", redeemed_by: invite.redeemed_by });
      return;
    }

    // Check if SS58 already registered
    const existing = db.prepare(
      "SELECT ss58_address, status FROM registrations WHERE ss58_address = ?",
    ).get(ss58_address) as { ss58_address: string; status: string } | undefined;

    if (existing) {
      res.status(409).json({ error: "Address already registered", status: existing.status });
      return;
    }

    // Generate API key
    const apiKeyPlaintext = randomBytes(32).toString("hex");
    const apiKeyHash = hashToken(apiKeyPlaintext);

    // Transaction: mark invite redeemed + create registration + add to keys.json
    const register = db.transaction(() => {
      // Mark invite as redeemed
      db.prepare(
        "UPDATE invites SET redeemed_at = ?, redeemed_by = ? WHERE token_hash = ?",
      ).run(new Date().toISOString(), ss58_address, tokenHash);

      // Create registration record
      db.prepare(`
        INSERT INTO registrations (ss58_address, public_key, label, api_key_hash, invite_token_hash, registered_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'registered')
      `).run(
        ss58_address,
        public_key || null,
        operatorLabel,
        apiKeyHash,
        tokenHash,
        new Date().toISOString(),
      );
    });
    register();

    // Append to keys.json on disk (gateway reloads on restart, but also update SQLite quota db)
    appendToKeysFile(apiKeyHash, operatorLabel, ss58_address, invite);

    // Upsert into the in-memory quota DB so the key works immediately
    upsertApiKey(apiKeyHash, operatorLabel, ss58_address, invite);

    console.log(`[blob-gateway] Operator registered: ${operatorLabel} (${ss58_address})`);

    // Send Discord notification (fire-and-forget)
    notifyDiscord(operatorLabel, ss58_address).catch(() => {});

    res.status(200).json({
      status: "registered",
      ss58_address,
      label: operatorLabel,
      api_key: apiKeyPlaintext,
      message: "Registration successful. The Materios team will activate your committee seat shortly.",
    });
  } catch (error) {
    console.error("[blob-gateway] Operator registration error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

operatorsRouter.get("/operators/status/:ss58", (req: Request, res: Response) => {
  try {
    const { ss58 } = req.params;
    const reg = db.prepare(
      "SELECT ss58_address, label, registered_at, approved_at, status, session_keys, peer_id FROM registrations WHERE ss58_address = ?",
    ).get(ss58) as { ss58_address: string; label: string; registered_at: string; approved_at: string | null; status: string; session_keys: string | null; peer_id: string | null } | undefined;

    if (!reg) {
      res.status(404).json({ error: "Address not registered" });
      return;
    }

    res.status(200).json({
      ss58_address: reg.ss58_address,
      label: reg.label,
      registered_at: reg.registered_at,
      approved_at: reg.approved_at,
      status: reg.status,
      has_session_keys: !!reg.session_keys,
      peer_id: reg.peer_id,
    });
  } catch (error) {
    console.error("[blob-gateway] Operator status error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── Session keys: reported by install.sh after node sync + rotateKeys ───────

operatorsRouter.patch("/operators/:ss58/session-keys", (req: Request, res: Response) => {
  try {
    const { ss58 } = req.params;
    const { session_keys, peer_id, api_key } = req.body as {
      session_keys?: string;
      peer_id?: string;
      api_key?: string;
    };

    // Auth: operator must present their API key
    if (!api_key || typeof api_key !== "string") {
      res.status(401).json({ error: "Missing api_key in body" });
      return;
    }
    const apiKeyHash = hashToken(api_key);
    const reg = db.prepare(
      "SELECT ss58_address, api_key_hash FROM registrations WHERE ss58_address = ?",
    ).get(ss58) as { ss58_address: string; api_key_hash: string } | undefined;

    if (!reg) {
      res.status(404).json({ error: "Address not registered" });
      return;
    }
    if (reg.api_key_hash !== apiKeyHash) {
      res.status(403).json({ error: "Invalid API key for this address" });
      return;
    }

    // Validate session_keys: should be 128 hex chars (0x prefix + 64 bytes = Aura 32 + Grandpa 32)
    if (!session_keys || typeof session_keys !== "string" || !/^0x[0-9a-fA-F]{128}$/.test(session_keys)) {
      res.status(400).json({ error: "Invalid session_keys: expected 0x + 128 hex chars (Aura 32 bytes + Grandpa 32 bytes)" });
      return;
    }

    const peerIdStr = (typeof peer_id === "string" && peer_id.trim()) ? peer_id.trim() : null;

    db.prepare(
      "UPDATE registrations SET session_keys = ?, peer_id = ? WHERE ss58_address = ?",
    ).run(session_keys, peerIdStr, ss58);

    console.log(`[blob-gateway] Session keys updated for ${ss58}: ${session_keys.slice(0, 18)}...`);

    res.status(200).json({
      status: "updated",
      ss58_address: ss58,
      session_keys_received: true,
      peer_id: peerIdStr,
      message: "Session keys stored. The Materios team will add your node to the authority set.",
    });
  } catch (error) {
    console.error("[blob-gateway] Session keys update error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── Admin: get session keys for approval script ─────────────────────────────

operatorsRouter.get("/operators/:ss58/session-keys", (req: Request, res: Response) => {
  try {
    // Admin-only: requires admin token
    const adminToken = req.headers["x-admin-token"] as string | undefined;
    if (!config.daemonNotifyToken || adminToken !== config.daemonNotifyToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { ss58 } = req.params;
    const reg = db.prepare(
      "SELECT ss58_address, label, session_keys, peer_id, status FROM registrations WHERE ss58_address = ?",
    ).get(ss58) as { ss58_address: string; label: string; session_keys: string | null; peer_id: string | null; status: string } | undefined;

    if (!reg) {
      res.status(404).json({ error: "Address not registered" });
      return;
    }

    res.status(200).json({
      ss58_address: reg.ss58_address,
      label: reg.label,
      session_keys: reg.session_keys,
      peer_id: reg.peer_id,
      status: reg.status,
    });
  } catch (error) {
    console.error("[blob-gateway] Get session keys error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── Admin: create invite via internal endpoint ──────────────────────────────

operatorsRouter.post("/operators/create-invite", (req: Request, res: Response) => {
  try {
    // Protected by admin token (same as daemon notify token)
    const adminToken = req.headers["x-admin-token"] as string | undefined;
    if (!config.daemonNotifyToken || adminToken !== config.daemonNotifyToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { label, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads } = req.body as {
      label?: string;
      max_receipts_per_day?: number;
      max_bytes_per_day?: number;
      max_concurrent_uploads?: number;
    };

    const inviteLabel = (typeof label === "string" && label.trim()) ? label.trim() : "operator";

    const token = createInvite(inviteLabel, {
      maxReceiptsPerDay: max_receipts_per_day,
      maxBytesPerDay: max_bytes_per_day,
      maxConcurrentUploads: max_concurrent_uploads,
    });

    res.status(200).json({
      status: "created",
      invite_token: token,
      label: inviteLabel,
      message: "Give this token to the operator. It is single-use.",
    });
  } catch (error) {
    console.error("[blob-gateway] Create invite error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function appendToKeysFile(
  apiKeyHash: string,
  label: string,
  validatorId: string,
  invite: InviteRow,
): void {
  const keysPath = config.keysFilePath;
  let keys: Array<Record<string, unknown>> = [];

  if (existsSync(keysPath)) {
    try {
      keys = JSON.parse(readFileSync(keysPath, "utf-8"));
    } catch {
      console.error("[blob-gateway] Failed to read keys.json, starting fresh array");
      keys = [];
    }
  }

  keys.push({
    keyHash: apiKeyHash,
    name: label,
    validatorId,
    enabled: true,
    maxReceiptsPerDay: invite.max_receipts_per_day,
    maxBytesPerDay: invite.max_bytes_per_day,
    maxConcurrentUploads: invite.max_concurrent_uploads,
  });

  writeFileSync(keysPath, JSON.stringify(keys, null, 2) + "\n", "utf-8");
  console.log(`[blob-gateway] Appended ${label} to keys.json (${keys.length} total keys)`);
}

function upsertApiKey(
  apiKeyHash: string,
  label: string,
  validatorId: string,
  invite: InviteRow,
): void {
  // Import the quota DB connection — we need to reach into the same SQLite DB
  // that initQuotaDb() created. Since they share the same file, we open it directly.
  const quotaDbPath = join(config.storagePath, "quota.db");
  if (!existsSync(quotaDbPath)) return;

  const quotaDb = new Database(quotaDbPath);
  quotaDb.pragma("busy_timeout = 5000");
  try {
    quotaDb.prepare(`
      INSERT INTO api_keys (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id)
      VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(key_hash) DO UPDATE SET
        name = excluded.name,
        enabled = excluded.enabled,
        max_receipts_per_day = excluded.max_receipts_per_day,
        max_bytes_per_day = excluded.max_bytes_per_day,
        max_concurrent_uploads = excluded.max_concurrent_uploads,
        validator_id = excluded.validator_id
    `).run(
      apiKeyHash,
      label,
      invite.max_receipts_per_day,
      invite.max_bytes_per_day,
      invite.max_concurrent_uploads,
      validatorId,
    );
    console.log(`[blob-gateway] API key upserted into quota.db for ${label}`);
  } finally {
    quotaDb.close();
  }
}

async function notifyDiscord(label: string, ss58: string): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const payload = {
    embeds: [{
      title: "New Materios Operator Registered",
      color: 3447003, // blue
      fields: [
        { name: "Label", value: label, inline: true },
        { name: "SS58", value: `\`${ss58}\``, inline: false },
        { name: "Action Needed", value: "Wait for operator's node to sync and report session keys, then run `approve-operator.mjs`", inline: false },
      ],
      timestamp: new Date().toISOString(),
    }],
  };

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
