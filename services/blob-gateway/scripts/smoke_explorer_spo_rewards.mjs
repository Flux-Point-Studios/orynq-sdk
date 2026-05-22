#!/usr/bin/env node
/**
 * Live smoke test for /preprod-explorer/api/spo-rewards (task #341).
 *
 * Spins up the route alone against the local Materios WS (ws://127.0.0.1:9945)
 * and the real Koios preprod endpoint, fetches the snapshot, and prints
 * the response shape + a couple of asserted invariants. Used for the
 * "real runtime evidence" gate before the PR ships.
 */
import express from "express";
import { createExplorerSpoRewardsRouter } from "../dist/routes/explorer-spo-rewards.js";

const PORT = 13413;
const app = express();
app.use(createExplorerSpoRewardsRouter({ disableCache: true }));

const server = app.listen(PORT, async () => {
  try {
    const url = `http://127.0.0.1:${PORT}/preprod-explorer/api/spo-rewards`;
    console.log(`[smoke] fetching ${url}`);
    const t0 = Date.now();
    const res = await fetch(url);
    const elapsed = Date.now() - t0;
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    console.log(`[smoke] HTTP ${res.status} in ${elapsed}ms`);
    if (typeof body === "object" && body !== null && Array.isArray(body.operators)) {
      console.log(`[smoke] head=${body.head} asOf=${body.asOf}`);
      console.log(`[smoke] operators=${body.operators.length}`);
      for (const op of body.operators) {
        console.log(
          `  - ${op.label.padEnd(11)} trust=${op.trust.padEnd(13)} ` +
          `matra=${op.matra_lifetime ?? "null"} ` +
          `cardano_blocks=${op.cardano_blocks_lifetime ?? "—"} ` +
          `pool_id=${op.cardano_pool_id ? op.cardano_pool_id.slice(0,12)+"…" : "—"}`,
        );
      }
    } else {
      console.error("[smoke] unexpected body shape", body);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("[smoke] fetch failed:", err.message);
    process.exitCode = 2;
  } finally {
    server.close();
    setTimeout(() => process.exit(), 1500);
  }
});
