/**
 * Faucet endpoint — airdrops a small amount of MATRA to new operator accounts
 * so they can generate MOTRA for transaction fees (join_committee, attestations).
 *
 * Rate limited: 1 drip per address, ever.
 */

import { Router, type Request, type Response } from "express";
import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import { config } from "../config.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export const faucetRouter = Router();

const DRIP_AMOUNT = "100000000000000"; // 100 tMATRA (generates ~10M MOTRA/block, enough for TXs in 1 block)
const DRIP_LEDGER_PATH = join(config.storagePath, "faucet-ledger.json");
const FAUCET_SIGNER_URI = process.env.FAUCET_SIGNER_URI || "//Alice";

let api: ApiPromise | null = null;
let signer: ReturnType<Keyring["addFromUri"]> | null = null;

async function getApi(): Promise<ApiPromise> {
  if (api && api.isConnected) return api;
  const rpcUrl = config.materiosRpcUrl;
  if (!rpcUrl) throw new Error("No MATERIOS_RPC_URL configured");
  const wsUrl = rpcUrl.replace("http://", "ws://").replace("https://", "wss://");
  api = await ApiPromise.create({ provider: new WsProvider(wsUrl) });
  const keyring = new Keyring({ type: "sr25519" });
  signer = keyring.addFromUri(FAUCET_SIGNER_URI);
  console.log(`[faucet] Connected, signer: ${signer.address}`);
  return api;
}

function loadLedger(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(DRIP_LEDGER_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveLedger(ledger: Record<string, number>): void {
  mkdirSync(join(config.storagePath), { recursive: true });
  writeFileSync(DRIP_LEDGER_PATH, JSON.stringify(ledger));
}

/**
 * POST /faucet/drip
 * Body: { "address": "5Grw..." }
 * Sends DRIP_AMOUNT MATRA to the address. One-time per address.
 */
faucetRouter.post("/faucet/drip", async (req: Request, res: Response) => {
  const { address } = req.body || {};

  if (!address || typeof address !== "string" || address.length < 40) {
    res.status(400).json({ error: "Valid SS58 address required" });
    return;
  }

  // Check ledger — one drip per address
  const ledger = loadLedger();
  if (ledger[address]) {
    res.status(409).json({
      error: "Address already received a drip",
      dripped_at: ledger[address],
    });
    return;
  }

  try {
    const chainApi = await getApi();
    if (!signer) throw new Error("Faucet signer not initialized");

    // Check faucet balance
    const faucetBalance = (await chainApi.query.system.account(signer.address)) as any;
    const free = BigInt(faucetBalance.data?.free?.toString() || "0");
    const needed = BigInt(DRIP_AMOUNT);
    if (free < needed * 10n) {
      console.error(`[faucet] Low balance: ${free.toString()} < ${(needed * 10n).toString()}`);
      res.status(503).json({ error: "Faucet balance too low" });
      return;
    }

    // Send the transfer
    const tx = chainApi.tx.balances.transferKeepAlive(address, DRIP_AMOUNT);
    const hash = await tx.signAndSend(signer);

    // Record in ledger
    ledger[address] = Date.now();
    saveLedger(ledger);

    // Auto-register as operator so heartbeats are accepted
    // IMPORTANT: Must insert into BOTH operators AND registrations tables.
    // The heartbeat endpoint checks registrations (status='approved'), not operators.
    try {
      const Database = require("better-sqlite3");
      const { createHash } = require("crypto");
      const opsDb = new Database("/data/blobs/operators.db");
      opsDb.exec(
        "CREATE TABLE IF NOT EXISTS operators (ss58_address TEXT PRIMARY KEY, label TEXT, api_key TEXT, public_key TEXT, created_at TEXT)"
      );
      opsDb.prepare(
        "INSERT OR IGNORE INTO operators (ss58_address, label, created_at) VALUES (?, ?, datetime('now'))"
      ).run(address, "faucet-attestor");

      // Also insert into registrations table (checked by heartbeat endpoint)
      opsDb.exec(
        "CREATE TABLE IF NOT EXISTS registrations (ss58_address TEXT PRIMARY KEY, public_key TEXT, label TEXT, api_key_hash TEXT NOT NULL, invite_token_hash TEXT NOT NULL, registered_at TEXT NOT NULL, approved_at TEXT, status TEXT NOT NULL DEFAULT 'approved', session_keys TEXT, peer_id TEXT)"
      );
      const dummyHash = createHash("sha256").update(address).digest("hex");
      const now = new Date().toISOString();
      opsDb.prepare(
        "INSERT OR IGNORE INTO registrations (ss58_address, public_key, label, api_key_hash, invite_token_hash, registered_at, approved_at, status) VALUES (?, '', 'faucet-attestor', ?, ?, ?, ?, 'approved')"
      ).run(address, dummyHash, dummyHash, now, now);

      console.log(`[faucet] Auto-registered operator + registration for ${address}`);
    } catch (e) {
      console.warn(`[faucet] Operator registration failed (non-fatal): ${e}`);
    }

    console.log(`[faucet] Dripped ${DRIP_AMOUNT} to ${address}, tx: ${hash.toHex()}`);
    res.json({
      success: true,
      amount: DRIP_AMOUNT,
      tx_hash: hash.toHex(),
      message: "MATRA sent. It will generate MOTRA over the next few blocks, enabling fee payment.",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[faucet] Drip failed for ${address}: ${msg}`);
    res.status(500).json({ error: `Faucet error: ${msg}` });
  }
});

/**
 * GET /faucet/status
 * Returns faucet balance and drip count.
 */
faucetRouter.get("/faucet/status", async (_req: Request, res: Response) => {
  try {
    const chainApi = await getApi();
    if (!signer) throw new Error("Faucet signer not initialized");
    const acct = (await chainApi.query.system.account(signer.address)) as any;
    const ledger = loadLedger();
    res.json({
      signer: signer.address,
      balance: acct.data?.free?.toString() || "0",
      total_drips: Object.keys(ledger).length,
      drip_amount: DRIP_AMOUNT,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});
