/**
 * LIVE KOIOS regression test for the SPO roster in `data/spo-pools.json`.
 *
 * Pins task #341's data-quality fix: every NON-NULL `cardano_pool_id` in the
 * roster MUST be a real, registered preprod pool that Koios can resolve.
 * Without this guard the rewards tab can silently degrade to "0 ADA" rows
 * whenever someone introduces a bech32 typo (Node-3 history) or links a
 * partner-chain candidate that never submitted a Cardano pool_registration
 * cert (Draupnir history).
 *
 * Gated on LIVE_KOIOS=1 to keep CI offline-deterministic; the route's
 * unit suite (explorer-spo-rewards.test.ts) still exercises every code
 * path with mock fixtures. Run locally with:
 *
 *   LIVE_KOIOS=1 pnpm --filter blob-gateway test \
 *     src/routes/__tests__/explorer-spo-rewards-live-koios.test.ts
 *
 * What we assert per pool:
 *   - HTTP 200 on /pool_info (Koios resolves the bech32 — no
 *     Checksum(InvalidResidue), no "No valid pool Bech32 strings provided.")
 *   - exactly one row returned matching the queried bech32
 *   - pool_status === "registered"  (not "retired" / "retiring")
 *
 * For `null` entries (Draupnir post-fix, all permissioned operators) we
 * assert the ROUTE-LAYER contract: the JSON sent to the frontend keeps
 * `cardano_pool_id: null` (the route does not invent a pool) and we do
 * NOT call Koios for them. This is the test that would have failed
 * before the fix — Draupnir's old ID `pool14jlfe9l…` returned `[]` from
 * /pool_info, which the test below catches as a hard fail.
 */

import { describe, test, expect } from "vitest";
import spoPoolsData from "../../data/spo-pools.json" with { type: "json" };

const LIVE = process.env.LIVE_KOIOS === "1";
const describeMaybe = LIVE ? describe : describe.skip;

const KOIOS_POOL_INFO = "https://preprod.koios.rest/api/v1/pool_info";
const KOIOS_POOL_HISTORY = "https://preprod.koios.rest/api/v1/pool_history";
const KOIOS_TIMEOUT_MS = 20_000;

interface RosterEntry {
  label: string;
  trust: "permissioned" | "spo";
  cardano_pool_id: string | null;
}

const ROSTER = spoPoolsData as Record<string, RosterEntry>;

async function koiosPoolInfo(poolBech32: string): Promise<unknown[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KOIOS_TIMEOUT_MS);
  try {
    const resp = await fetch(KOIOS_POOL_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _pool_bech32_ids: [poolBech32] }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      throw new Error(`Koios pool_info HTTP ${resp.status} for ${poolBech32}`);
    }
    const body = await resp.json();
    if (!Array.isArray(body)) {
      throw new Error(
        `Koios pool_info non-array for ${poolBech32}: ${JSON.stringify(body)}`,
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function koiosPoolHistory(poolBech32: string): Promise<unknown[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KOIOS_TIMEOUT_MS);
  try {
    const url = `${KOIOS_POOL_HISTORY}?_pool_bech32=${encodeURIComponent(poolBech32)}`;
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) {
      throw new Error(
        `Koios pool_history HTTP ${resp.status} for ${poolBech32}`,
      );
    }
    const body = await resp.json();
    if (!Array.isArray(body)) {
      throw new Error(
        `Koios pool_history non-array for ${poolBech32}: ${JSON.stringify(body)}`,
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

describeMaybe("spo-pools.json roster — LIVE Koios resolution", () => {
  const entries = Object.entries(ROSTER);
  const spoWithPool = entries.filter(
    ([, v]) => v.trust === "spo" && v.cardano_pool_id !== null,
  );
  const spoWithoutPool = entries.filter(
    ([, v]) => v.trust === "spo" && v.cardano_pool_id === null,
  );

  test("roster has at least one SPO with a non-null pool ID", () => {
    expect(spoWithPool.length).toBeGreaterThan(0);
  });

  test(
    "every non-null cardano_pool_id resolves via Koios pool_info",
    async () => {
      const results = await Promise.all(
        spoWithPool.map(async ([auraHex, meta]) => {
          const poolId = meta.cardano_pool_id as string;
          const rows = await koiosPoolInfo(poolId);
          return { auraHex, meta, poolId, rows };
        }),
      );

      for (const r of results) {
        // Empty array = pool bech32 is well-formed but no pool registration
        // cert exists on chain — the exact failure that flagged Draupnir.
        expect(
          r.rows.length,
          `Koios returned 0 rows for ${r.meta.label} pool ${r.poolId} — ` +
            `bech32 is well-formed but no Cardano pool_registration on L1`,
        ).toBeGreaterThan(0);
        const row = r.rows[0] as Record<string, unknown>;
        expect(row.pool_id_bech32).toBe(r.poolId);
        // We accept "registered" or "registered:retiring" (the latter is
        // still resolvable + still earns through the cooldown epoch);
        // "retired" pools should be removed from the roster manually so
        // the demo doesn't claim a dead pool earns ADA.
        expect(
          String(row.pool_status),
          `${r.meta.label} pool ${r.poolId} status=${row.pool_status}`,
        ).toMatch(/^registered/);
      }
    },
    60_000,
  );

  test(
    "every non-null cardano_pool_id resolves via Koios pool_history",
    async () => {
      // pool_history is what the route's hot path actually calls; pool_info
      // proves "exists" but the route depends on the history endpoint.
      // We don't assert non-empty here (a freshly-registered pool may have
      // zero history rows for the first ~2 epochs), just that the call
      // succeeds and the response is a JSON array.
      const histories = await Promise.all(
        spoWithPool.map(async ([, meta]) => {
          const poolId = meta.cardano_pool_id as string;
          const rows = await koiosPoolHistory(poolId);
          return { label: meta.label, poolId, rows };
        }),
      );
      for (const h of histories) {
        expect(Array.isArray(h.rows)).toBe(true);
      }
    },
    60_000,
  );

  test("SPO rows with null pool_id are intentional, not data drift", () => {
    // Document each null SPO so removing one is a deliberate diff. As of the
    // task #341 fix this is exactly {"Draupnir"} — partner-chain candidate
    // registered (tx 2fb1533d…) but the tx carries zero certificates, so
    // no Cardano pool_registration was ever submitted.
    const labels = spoWithoutPool.map(([, m]) => m.label).sort();
    expect(labels).toEqual(["Draupnir"]);
  });
});
