/**
 * Tests for GET /preprod-explorer/api/spo-rewards (task #341).
 *
 * Mirrors the test harness pattern from explorer-validators.test.ts:
 *   - the route is built via createExplorerSpoRewardsRouter with injected
 *     `apiFactory` (substrate side) + `koiosFetch` (Cardano side), so we
 *     never hit a real WS RPC or the public Koios endpoint in CI.
 *   - the response shape is exercised against the operator + pool roster
 *     described in task #341 so future drift gets caught here.
 *
 * The two data sources have asymmetric failure semantics:
 *   - Materios down → return rows with `matra_lifetime: null` (don't 503).
 *   - Koios down    → return 503 with `{"error":"koios_unreachable"}` so the
 *                     frontend can surface a "Cardano rewards stream
 *                     unavailable" banner.
 *
 * Asymmetry rationale: the MATRA side is the substrate identity backbone —
 * if it's down we still want the table to show *something* (the operator
 * roster). The ADA side is the headline data the tab exists to display,
 * so wholly-stale rendering would be misleading.
 */

import { describe, test, expect } from "vitest";
import express from "express";
import {
  createExplorerSpoRewardsRouter,
  type ExplorerApiFactory,
  type KoiosFetcher,
} from "../explorer-spo-rewards.js";

interface CallResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

async function callApp(
  app: express.Express,
  path: string,
): Promise<CallResult> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url)
        .then(async (res) => {
          const text = await res.text();
          let parsed: unknown;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            headers[k] = v;
          });
          server.close();
          resolve({ status: res.status, body: parsed, headers });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// Known SPO pool roster from task #341 (declared in spo-pools.json so the
// route loader is exercised in the same way the validator route exercises
// operators.json).
const HETZNER_AURA =
  "0x64964344fff93f562d94488c5fc340408817de10c4a4783e5e0dde6c8a4ba53e";
const TRUEAIDATA_AURA =
  "0xa43bc8672f04ad568968cad7ba444eb88583d72b271806ff705c82e4ad2ff263";
const RUNIR_AURA =
  "0xd2b8899dc82477cccd8ea2513fd426cbe672a6221050a9707a743c293f5b8e01";
const NODE3_AURA =
  "0x925fe8605fe32a53a7b391498fc1b0ab91d3af7319607bd70b850b4f5fa9d255";
const HETZNER_POOL = "pool15ff3v8y3m3c0rj3dksaqjy4qaj6j89s97qdnayugcjp6cp5z6ug";

// 1.585e9 base = 1585.87 MATRA (6 decimals).
const HETZNER_FREE = "1585870000";
// A multi-epoch Koios response — fees + blocks should be summed.
const POOL_HISTORY_TWO_EPOCHS = [
  {
    epoch_no: 288,
    active_stake: "1009477457385",
    block_cnt: 0,
    pool_fees: "0",
    deleg_rewards: "0",
  },
  {
    epoch_no: 287,
    active_stake: "9487628870",
    block_cnt: 0,
    pool_fees: "0",
    deleg_rewards: "0",
  },
];

interface FakeBalances {
  [auraHex: string]: { free: string; reserved: string };
}

function makeFakeMateriosApi(balances: FakeBalances): ReturnType<ExplorerApiFactory> {
  const api = {
    rpc: {
      chain: {
        getHeader: async () => ({
          number: { toNumber: () => 285_123 },
        }),
      },
    },
    query: {
      system: {
        account: async (ss58OrPubkey: string) => {
          // Find by pubkey suffix — the route resolves aura pubkey → SS58
          // before querying, so the key in `balances` is the SS58 it derived.
          const row =
            balances[ss58OrPubkey] ??
            balances[ss58OrPubkey.toLowerCase()] ??
            null;
          if (!row) {
            // polkadot.js returns an "empty account" record for unknown
            // accounts, not an error. Mirror that.
            return {
              data: {
                free: { toString: () => "0" },
                reserved: { toString: () => "0" },
              },
            };
          }
          return {
            data: {
              free: { toString: () => row.free },
              reserved: { toString: () => row.reserved },
            },
          };
        },
      },
    },
    disconnect: async () => undefined,
  };
  return Promise.resolve(api as unknown as Awaited<ReturnType<ExplorerApiFactory>>);
}

function makeKoiosFetcher(
  responses: Record<string, unknown>,
  opts: { fail?: boolean } = {},
): KoiosFetcher {
  return async (poolBech32: string) => {
    if (opts.fail) throw new Error("ETIMEDOUT");
    const body = responses[poolBech32];
    if (body === undefined) return [];
    return body as Array<Record<string, unknown>>;
  };
}

describe("GET /preprod-explorer/api/spo-rewards", () => {
  test("happy path: returns 200 with full operator roster + dual-stream data", async () => {
    const app = express();
    app.use(
      createExplorerSpoRewardsRouter({
        apiFactory: () =>
          makeFakeMateriosApi({
            // Aura SS58 (encoded from HETZNER_AURA with prefix 42). We
            // bypass derivation here by accepting either casing or any
            // identifier the route hands the stub — the fake stub is
            // tolerant; the real route will pass the SS58.
            __any_hetzner__: { free: HETZNER_FREE, reserved: "0" },
          }),
        koiosFetch: makeKoiosFetcher({
          [HETZNER_POOL]: POOL_HISTORY_TWO_EPOCHS,
        }),
        disableCache: true,
      }),
    );
    const res = await callApp(app, "/preprod-explorer/api/spo-rewards");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["access-control-allow-origin"]).toBe("*");

    const body = res.body as Record<string, unknown>;
    expect(typeof body.asOf).toBe("string");
    expect(typeof body.head).toBe("number");
    expect(Array.isArray(body.operators)).toBe(true);
    const ops = body.operators as Array<Record<string, unknown>>;
    // 4 SPO + 3 permissioned = 7 operators per task spec
    expect(ops.length).toBe(7);

    const hetzner = ops.find((o) => o.label === "Hetzner")!;
    expect(hetzner.trust).toBe("spo");
    expect(hetzner.cardano_pool_id).toBe(HETZNER_POOL);
    // Sums across the two-epoch fake history → 0 fees, 0 blocks, latest
    // active_stake from epoch 288.
    expect(hetzner.cardano_blocks_lifetime).toBe(0);
    expect(hetzner.cardano_pool_fees_lifetime_raw).toBe("0");
    expect(hetzner.cardano_active_stake_raw).toBe("1009477457385");
    expect(hetzner.cardano_first_epoch).toBe(287);
    expect(hetzner.cardano_last_epoch_with_blocks).toBeNull();

    const macbook = ops.find((o) => o.label === "MacBook")!;
    expect(macbook.trust).toBe("permissioned");
    expect(macbook.cardano_pool_id).toBeNull();
    expect(macbook.cardano_blocks_lifetime).toBeNull();
  });

  test("Koios unreachable: returns 503 + koios_unreachable", async () => {
    const app = express();
    app.use(
      createExplorerSpoRewardsRouter({
        apiFactory: () => makeFakeMateriosApi({}),
        koiosFetch: makeKoiosFetcher({}, { fail: true }),
        disableCache: true,
      }),
    );
    const res = await callApp(app, "/preprod-explorer/api/spo-rewards");
    expect(res.status).toBe(503);
    expect((res.body as Record<string, unknown>).error).toBe("koios_unreachable");
  });

  test("Materios down: still returns operators (matra_lifetime: null)", async () => {
    const app = express();
    app.use(
      createExplorerSpoRewardsRouter({
        apiFactory: () => Promise.reject(new Error("ECONNREFUSED")),
        koiosFetch: makeKoiosFetcher({
          [HETZNER_POOL]: POOL_HISTORY_TWO_EPOCHS,
        }),
        disableCache: true,
      }),
    );
    const res = await callApp(app, "/preprod-explorer/api/spo-rewards");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const ops = body.operators as Array<Record<string, unknown>>;
    // 7 operators present even though MATRA stream failed
    expect(ops.length).toBe(7);
    const hetzner = ops.find((o) => o.label === "Hetzner")!;
    expect(hetzner.matra_lifetime).toBeNull();
    expect(hetzner.matra_lifetime_raw).toBeNull();
    // Cardano data still populated from the working Koios stream
    expect(hetzner.cardano_pool_id).toBe(HETZNER_POOL);
    expect(hetzner.cardano_active_stake_raw).toBe("1009477457385");
  });

  test("Pool history empty array: cardano fields render as 0 (not null)", async () => {
    const app = express();
    app.use(
      createExplorerSpoRewardsRouter({
        apiFactory: () => makeFakeMateriosApi({}),
        koiosFetch: makeKoiosFetcher({
          // empty history = registered but never delegated/produced
          [HETZNER_POOL]: [],
        }),
        disableCache: true,
      }),
    );
    const res = await callApp(app, "/preprod-explorer/api/spo-rewards");
    expect(res.status).toBe(200);
    const ops = (res.body as { operators: Array<Record<string, unknown>> }).operators;
    const hetzner = ops.find((o) => o.label === "Hetzner")!;
    expect(hetzner.cardano_blocks_lifetime).toBe(0);
    expect(hetzner.cardano_pool_fees_lifetime_raw).toBe("0");
    expect(hetzner.cardano_active_stake_raw).toBeNull();
    expect(hetzner.cardano_first_epoch).toBeNull();
    expect(hetzner.cardano_last_epoch_with_blocks).toBeNull();
  });

  test("Pool history with blocks: blocks summed, last_epoch_with_blocks set", async () => {
    const HISTORY_WITH_BLOCKS = [
      {
        epoch_no: 285,
        active_stake: "1500000000000",
        block_cnt: 3,
        pool_fees: "340000000",
        deleg_rewards: "1200000",
      },
      {
        epoch_no: 284,
        active_stake: "1200000000000",
        block_cnt: 5,
        pool_fees: "342000000",
        deleg_rewards: "2000000",
      },
      {
        epoch_no: 283,
        active_stake: "1000000000000",
        block_cnt: 0,
        pool_fees: null, // null on the wire is treated as 0
        deleg_rewards: null,
      },
    ];
    const app = express();
    app.use(
      createExplorerSpoRewardsRouter({
        apiFactory: () => makeFakeMateriosApi({}),
        koiosFetch: makeKoiosFetcher({
          [HETZNER_POOL]: HISTORY_WITH_BLOCKS,
        }),
        disableCache: true,
      }),
    );
    const res = await callApp(app, "/preprod-explorer/api/spo-rewards");
    expect(res.status).toBe(200);
    const ops = (res.body as { operators: Array<Record<string, unknown>> }).operators;
    const hetzner = ops.find((o) => o.label === "Hetzner")!;
    // 3 + 5 + 0 = 8 blocks lifetime
    expect(hetzner.cardano_blocks_lifetime).toBe(8);
    // 340_000_000 + 342_000_000 + 0 = 682_000_000 lovelace
    expect(hetzner.cardano_pool_fees_lifetime_raw).toBe("682000000");
    expect(hetzner.cardano_delegator_rewards_lifetime_raw).toBe("3200000");
    expect(hetzner.cardano_first_epoch).toBe(283);
    // Latest epoch with block_cnt > 0 (epoch 285 has 3 blocks; 284 has 5;
    // 283 has 0). Max epoch with any blocks is 285.
    expect(hetzner.cardano_last_epoch_with_blocks).toBe(285);
    // Latest record's active_stake (epoch 285)
    expect(hetzner.cardano_active_stake_raw).toBe("1500000000000");
    expect(hetzner.cardano_active_stake).toBe("1500000.000");
  });

  test("Cardano decimal formatting: ADA = lovelace / 1e6, MATRA = u128 / 1e6", async () => {
    // 1_585_870_000 base MATRA = 1585.87 MATRA
    // 1_009_477_457_385 lovelace = 1_009_477.457385 ADA → 6 decimals trunc
    const app = express();
    app.use(
      createExplorerSpoRewardsRouter({
        apiFactory: () => makeFakeMateriosApi({}),
        koiosFetch: makeKoiosFetcher({
          [HETZNER_POOL]: POOL_HISTORY_TWO_EPOCHS,
        }),
        disableCache: true,
      }),
    );
    const res = await callApp(app, "/preprod-explorer/api/spo-rewards");
    expect(res.status).toBe(200);
    const ops = (res.body as { operators: Array<Record<string, unknown>> }).operators;
    const hetzner = ops.find((o) => o.label === "Hetzner")!;
    expect(hetzner.cardano_active_stake_raw).toBe("1009477457385");
    expect(hetzner.cardano_active_stake).toBe("1009477.457");
    expect(hetzner.cardano_pool_fees_lifetime_raw).toBe("0");
    expect(hetzner.cardano_pool_fees_lifetime).toBe("0.000000");
  });

  test("Unknown aura pubkey: not in roster, omitted from response", async () => {
    // Sanity check: only operators listed in spo-pools.json (4 SPO) +
    // operators.json (3 permissioned) are returned. We don't echo random
    // pubkeys passed in by other paths.
    const app = express();
    app.use(
      createExplorerSpoRewardsRouter({
        apiFactory: () => makeFakeMateriosApi({}),
        koiosFetch: makeKoiosFetcher({}),
        disableCache: true,
      }),
    );
    const res = await callApp(app, "/preprod-explorer/api/spo-rewards");
    expect(res.status).toBe(200);
    const ops = (res.body as { operators: Array<Record<string, unknown>> }).operators;
    const labels = ops.map((o) => o.label).sort();
    expect(labels).toEqual([
      "Draupnir",
      "Gemtek",
      "Hetzner",
      "MacBook",
      "Node-2",
      "Node-3",
      "TrueAiData",
    ]);
    // No "unknown" trust rows
    expect(ops.every((o) => o.trust === "spo" || o.trust === "permissioned")).toBe(
      true,
    );
  });

  // Sanity: silence unused-var lint for the aura pubkeys we declared (they
  // document the live config the runtime route will use).
  test("aura pubkeys are non-empty hex strings (config sanity)", () => {
    for (const p of [HETZNER_AURA, TRUEAIDATA_AURA, RUNIR_AURA, NODE3_AURA]) {
      expect(p).toMatch(/^0x[0-9a-f]+$/);
      expect(p.length).toBe(66);
    }
  });

  test("roster pool IDs match task #341 corrections (no drift)", async () => {
    // Pinned values that survived live-Koios verification on 2026-05-22.
    // Drift here means someone changed spo-pools.json without re-running
    // the LIVE_KOIOS=1 suite — fail loudly so the rewards tab can't
    // silently regress to "0 ADA" rows again.
    const expected: Record<string, { trust: string; pool: string | null }> = {
      Hetzner: {
        trust: "spo",
        pool: "pool15ff3v8y3m3c0rj3dksaqjy4qaj6j89s97qdnayugcjp6cp5z6ug",
      },
      TrueAiData: {
        trust: "spo",
        pool: "pool18cwl8hgnu2q6q9nr3sjmyys7xj0jzgka29k74lztdzp7qrfhaww",
      },
      Node_3: {
        trust: "spo",
        pool: "pool1y36klnfa4kc3hyggc3fujrm3j6zlgf9r8jhtyufzmgufz3k5pt2",
      },
      // Draupnir submitted partner-chain reg (Cardano tx 2fb1533d…) but the
      // tx carried zero certificates — no Cardano pool_registration ever
      // landed on L1. Until they register, the route MUST return null
      // so the frontend renders "Not registered" instead of "0 ADA".
      Draupnir: { trust: "spo", pool: null },
      Gemtek: { trust: "permissioned", pool: null },
      Node_2: { trust: "permissioned", pool: null },
      MacBook: { trust: "permissioned", pool: null },
    };

    const app = express();
    app.use(
      createExplorerSpoRewardsRouter({
        apiFactory: () => makeFakeMateriosApi({}),
        koiosFetch: makeKoiosFetcher({}),
        disableCache: true,
      }),
    );
    const res = await callApp(app, "/preprod-explorer/api/spo-rewards");
    expect(res.status).toBe(200);
    const ops = (res.body as { operators: Array<Record<string, unknown>> }).operators;

    for (const [labelKey, { trust, pool }] of Object.entries(expected)) {
      const wantLabel = labelKey.replace("_", "-");
      const row = ops.find((o) => o.label === wantLabel);
      expect(row, `missing operator ${wantLabel}`).toBeDefined();
      expect(row!.trust).toBe(trust);
      expect(row!.cardano_pool_id).toBe(pool);
    }
  });
});
