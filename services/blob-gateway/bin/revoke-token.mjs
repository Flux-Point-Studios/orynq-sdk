#!/usr/bin/env node
/**
 * Revoke a Materios Bearer auth token by its sha256 hash.
 *
 * Usage (inside the blob-gateway container):
 *   node /app/bin/revoke-token.mjs --hash <sha256-hex> [--reason "lost laptop"]
 */

import BetterSqlite3 from "better-sqlite3";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { initApiTokensDb, revokeToken } from "../dist/api-tokens.js";

function usage(err) {
  if (err) console.error(`error: ${err}`);
  console.error(
    "usage: revoke-token.mjs --hash <sha256-hex> [--reason <text>] [--db /path/operators.db]",
  );
  process.exit(err ? 2 : 0);
}

const { values } = parseArgs({
  options: {
    hash: { type: "string" },
    reason: { type: "string" },
    db: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

if (values.help) usage(null);
const hash = (values.hash || "").trim().toLowerCase();
if (!hash) usage("--hash is required");
if (!/^[0-9a-f]{64}$/.test(hash)) usage(`invalid token hash (expected 64 hex): ${hash}`);

const dbPath =
  (typeof values.db === "string" && values.db) ||
  join(process.env.STORAGE_PATH || "/data/blobs", "operators.db");

const handle = new BetterSqlite3(dbPath);
handle.pragma("busy_timeout = 5000");
initApiTokensDb(handle);

const result = revokeToken(handle, {
  tokenHash: hash,
  reason: values.reason || "cli-revoke",
});

if (!result.revoked) {
  console.error(
    JSON.stringify(
      { status: "noop", tokenHash: hash, reason: "not found or already revoked" },
      null,
      2,
    ),
  );
  process.exit(1);
}

process.stdout.write(
  JSON.stringify(
    { status: "revoked", tokenHash: hash, reason: values.reason || "cli-revoke" },
    null,
    2,
  ) + "\n",
);
