#!/usr/bin/env node
/**
 * Mint a new Bearer auth token for a Materios operator.
 *
 * Usage (inside the blob-gateway container):
 *   node /app/bin/issue-token.mjs --account 5... --label "penny-macbook"
 *
 * The raw token is printed to stdout EXACTLY ONCE. The DB stores only
 * sha256(token). If lost, mint a new one and revoke the old hash.
 */

import BetterSqlite3 from "better-sqlite3";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  initApiTokensDb,
  issueToken,
} from "../dist/api-tokens.js";

function usage(err) {
  if (err) console.error(`error: ${err}`);
  console.error(
    "usage: issue-token.mjs --account <SS58> [--label <text>] [--db /path/operators.db]",
  );
  process.exit(err ? 2 : 0);
}

const { values } = parseArgs({
  options: {
    account: { type: "string", short: "a" },
    label: { type: "string", short: "l" },
    db: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

if (values.help) usage(null);
const account = (values.account || "").trim();
const label = (values.label || "").trim();
if (!account) usage("--account is required");
if (!/^[15][a-zA-Z0-9]{45,47}$/.test(account)) {
  usage(`invalid SS58 address: ${account}`);
}

const dbPath =
  (typeof values.db === "string" && values.db) ||
  join(process.env.STORAGE_PATH || "/data/blobs", "operators.db");

const handle = new BetterSqlite3(dbPath);
handle.pragma("busy_timeout = 5000");
initApiTokensDb(handle);

const issued = issueToken(handle, {
  accountSs58: account,
  label: label || undefined,
});

process.stdout.write(
  JSON.stringify(
    {
      status: "created",
      token: issued.token, // SHOWN ONCE
      tokenHash: issued.tokenHash,
      account: issued.accountSs58,
      label: issued.label,
      createdAt: issued.createdAt,
      message:
        "Store this token now. Only its sha256 is persisted. Lost token => mint a new one.",
    },
    null,
    2,
  ) + "\n",
);
