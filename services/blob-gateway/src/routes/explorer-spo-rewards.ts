/**
 * GET /preprod-explorer/api/spo-rewards (task #341).
 *
 * Dual-stream rewards view: Materios block-production rewards (tMATRA)
 * and Cardano SPO slot-leadership rewards (tADA, via Koios preprod).
 *
 * Why a separate route from /preprod-explorer/api/validators:
 *   Validators-route is about *health* (producing/finality gap, last-60-block
 *   author scan); this route is about *cumulative economic output* and pulls
 *   from a different Cardano-side data source (Koios pool_history). The two
 *   change at different cadences and have different failure semantics:
 *     - Materios down → empty matra_lifetime fields, still render roster
 *     - Koios down    → 503; this tab's headline data is the dual stream,
 *                       so rendering the substrate side alone is misleading.
 *
 * Cache TTL is 60s. Koios pool_history shifts only at Cardano epoch
 * boundaries (5 days on preprod); the Materios balance side is a single
 * local RPC roundtrip and could be re-read every request, but a unified
 * 60s window keeps the response shape coherent (one snapshot timestamp)
 * and stays well below Koios free-tier limits.
 *
 * Both data sources are dependency-injected (apiFactory + koiosFetch) so
 * the test harness drives them without standing up a real WS RPC or
 * hitting the public Koios endpoint.
 */

import { Router, type Request, type Response } from "express";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { encodeAddress } from "@polkadot/util-crypto";
import { config } from "../config.js";
import spoPoolsData from "../data/spo-pools.json" with { type: "json" };

const CACHE_TTL_MS = 60_000;
const KOIOS_PREPROD_URL = "https://preprod.koios.rest/api/v1/pool_history";
const KOIOS_TIMEOUT_MS = 15_000;
const SS58_PREFIX = 42;
// Materios MATRA decimals on v5 (Cardano cMATRA-compatible).
const MATRA_DECIMALS = 6;
// Cardano lovelace decimals are universally 6 (1 ADA = 1e6 lovelace).
const ADA_DECIMALS = 6;
const API_CONNECT_TIMEOUT_MS = 25_000;

interface OperatorRosterEntry {
  label: string;
  trust: "permissioned" | "spo";
  cardano_pool_id: string | null;
}

type OperatorRoster = Record<string, OperatorRosterEntry>;
const ROSTER: OperatorRoster = spoPoolsData as OperatorRoster;

export interface KoiosPoolHistoryRecord {
  epoch_no: number;
  active_stake: string | null;
  block_cnt: number | null;
  pool_fees: string | null;
  deleg_rewards: string | null;
}

export type KoiosFetcher = (
  poolBech32: string,
) => Promise<KoiosPoolHistoryRecord[]>;

export type ExplorerApiFactory = () => Promise<ApiPromise>;

interface RouterDeps {
  apiFactory?: ExplorerApiFactory;
  koiosFetch?: KoiosFetcher;
  disableCache?: boolean;
}

interface OperatorRewardsRow {
  label: string;
  trust: "permissioned" | "spo";
  materios_ss58: string;
  matra_lifetime_raw: string | null;
  matra_lifetime: string | null;
  cardano_pool_id: string | null;
  cardano_blocks_lifetime: number | null;
  cardano_pool_fees_lifetime_raw: string | null;
  cardano_pool_fees_lifetime: string | null;
  cardano_delegator_rewards_lifetime_raw: string | null;
  cardano_delegator_rewards_lifetime: string | null;
  cardano_active_stake_raw: string | null;
  cardano_active_stake: string | null;
  cardano_first_epoch: number | null;
  cardano_last_epoch_with_blocks: number | null;
}

interface RewardsSnapshot {
  asOf: string;
  head: number;
  operators: OperatorRewardsRow[];
}

let defaultApiSingleton: Promise<ApiPromise> | null = null;
let defaultApiLastAttempt = 0;
const DEFAULT_API_RECONNECT_COOLDOWN_MS = 30_000;

function defaultApiFactory(): Promise<ApiPromise> {
  if (defaultApiSingleton) return defaultApiSingleton;
  if (Date.now() - defaultApiLastAttempt < DEFAULT_API_RECONNECT_COOLDOWN_MS) {
    return Promise.reject(new Error("api recently failed, in cooldown"));
  }
  defaultApiLastAttempt = Date.now();

  const provider = new WsProvider(config.materiosRpcUrl, 5000);
  const racing = Promise.race<ApiPromise>([
    ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true }),
    new Promise<ApiPromise>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error("api connect timeout")),
        API_CONNECT_TIMEOUT_MS,
      ),
    ),
  ]);

  defaultApiSingleton = racing;
  racing
    .then((api) => {
      api.on("disconnected", () => {
        console.warn("[explorer-spo-rewards] RPC disconnected");
        defaultApiSingleton = null;
      });
      api.on("error", (err) => {
        console.warn(`[explorer-spo-rewards] RPC error: ${err}`);
        defaultApiSingleton = null;
      });
    })
    .catch(() => {
      defaultApiSingleton = null;
    });
  return racing;
}

async function defaultKoiosFetch(
  poolBech32: string,
): Promise<KoiosPoolHistoryRecord[]> {
  const url = `${KOIOS_PREPROD_URL}?_pool_bech32=${encodeURIComponent(poolBech32)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KOIOS_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) {
      // 4xx/5xx from Koios is treated as "data unavailable for this pool"
      // — we log + continue with an empty array rather than failing the
      // whole roster (one bad pool ID shouldn't take down the tab).
      console.warn(
        `[explorer-spo-rewards] Koios ${resp.status} for ${poolBech32}`,
      );
      return [];
    }
    const body = await resp.json();
    if (!Array.isArray(body)) return [];
    return body as KoiosPoolHistoryRecord[];
  } finally {
    clearTimeout(timer);
  }
}

function sumBigInt(values: Array<string | null | undefined>): bigint {
  let total = 0n;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    try {
      total += BigInt(v);
    } catch {
      // ignore non-numeric inputs
    }
  }
  return total;
}

function sumInt(values: Array<number | null | undefined>): number {
  let total = 0;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) total += v;
  }
  return total;
}

/**
 * Format a base-unit u128/u64 as a human decimal string with `decimals`
 * fractional digits, e.g. (1585870000n, 6) → "1585.870000". We don't use
 * Number for this — MATRA at 6 decimals fits in JS Number, but lovelace
 * lifetime sums can exceed Number.MAX_SAFE_INTEGER for whales; stringify
 * keeps the contract honest.
 */
function formatDecimal(rawBase: bigint, decimals: number, displayDigits = 3): string {
  const negative = rawBase < 0n;
  const abs = negative ? -rawBase : rawBase;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(decimals, "0");
  // For ADA-side numbers we truncate to `displayDigits` for table density;
  // for MATRA we use the natural decimals.
  const trimmed =
    displayDigits < decimals
      ? fracStr.slice(0, displayDigits)
      : fracStr;
  return `${negative ? "-" : ""}${whole.toString()}.${trimmed}`;
}

function formatMatra(rawBase: bigint): string {
  // Show all 6 fractional digits — MATRA economy is small enough that
  // trimming hides meaningful amounts on the dust end.
  return formatDecimal(rawBase, MATRA_DECIMALS, MATRA_DECIMALS);
}

function formatAda(rawBase: bigint, displayDigits: number): string {
  return formatDecimal(rawBase, ADA_DECIMALS, displayDigits);
}

function auraPubkeyToSs58(auraHex: string): string {
  // encodeAddress takes a hex string or Uint8Array; the prefix `42` is
  // the canonical "generic Substrate" prefix the chain uses.
  return encodeAddress(auraHex, SS58_PREFIX);
}

/**
 * Fetch tMATRA balance (free + reserved) for one aura SS58. Returns null
 * on RPC error — the caller decides how to surface it (we surface null
 * so the row still renders and the operator still appears).
 */
async function fetchMatraBalance(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  ss58: string,
): Promise<bigint | null> {
  try {
    const account = await api.query.system.account(ss58);
    // polkadot.js returns a FrameSystemAccountInfo with .data.{free,reserved}.
    // Tests pass plain stubs whose toString() returns the base-unit string
    // directly — we go through `.toString()` so both paths share a single
    // BigInt parse.
    const free = BigInt(String(account?.data?.free?.toString?.() ?? "0"));
    const reserved = BigInt(String(account?.data?.reserved?.toString?.() ?? "0"));
    return free + reserved;
  } catch (err) {
    console.warn(
      `[explorer-spo-rewards] balance fetch failed for ${ss58}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

async function fetchHead(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
): Promise<number> {
  try {
    const header = await api.rpc.chain.getHeader();
    const n = header?.number?.toNumber?.();
    if (typeof n === "number" && Number.isFinite(n)) return n;
  } catch {
    // swallow — caller still gets a snapshot with head=0
  }
  return 0;
}

interface CardanoAgg {
  blocks: number;
  fees: bigint;
  delegRewards: bigint;
  activeStake: bigint | null;
  firstEpoch: number | null;
  lastEpochWithBlocks: number | null;
}

function aggregatePoolHistory(records: KoiosPoolHistoryRecord[]): CardanoAgg {
  if (records.length === 0) {
    return {
      blocks: 0,
      fees: 0n,
      delegRewards: 0n,
      activeStake: null,
      firstEpoch: null,
      lastEpochWithBlocks: null,
    };
  }

  const blocks = sumInt(records.map((r) => r.block_cnt));
  const fees = sumBigInt(records.map((r) => r.pool_fees));
  const delegRewards = sumBigInt(records.map((r) => r.deleg_rewards));

  // Koios returns history sorted by epoch_no descending. Active stake is
  // the LATEST snapshot (largest epoch); first epoch is the smallest.
  // We don't trust the response ordering — recompute defensively.
  let maxEpoch = -Infinity;
  let minEpoch = Infinity;
  let latestActiveStake: bigint | null = null;
  let lastEpochWithBlocks: number | null = null;
  for (const r of records) {
    if (typeof r.epoch_no !== "number") continue;
    if (r.epoch_no > maxEpoch) {
      maxEpoch = r.epoch_no;
      if (r.active_stake !== null && r.active_stake !== undefined) {
        try {
          latestActiveStake = BigInt(r.active_stake);
        } catch {
          latestActiveStake = null;
        }
      } else {
        latestActiveStake = null;
      }
    }
    if (r.epoch_no < minEpoch) minEpoch = r.epoch_no;
    if (
      typeof r.block_cnt === "number" &&
      r.block_cnt > 0 &&
      (lastEpochWithBlocks === null || r.epoch_no > lastEpochWithBlocks)
    ) {
      lastEpochWithBlocks = r.epoch_no;
    }
  }

  return {
    blocks,
    fees,
    delegRewards,
    activeStake: latestActiveStake,
    firstEpoch: Number.isFinite(minEpoch) ? minEpoch : null,
    lastEpochWithBlocks,
  };
}

async function buildSnapshot(
  apiFactory: ExplorerApiFactory,
  koiosFetch: KoiosFetcher,
): Promise<RewardsSnapshot> {
  const entries = Object.entries(ROSTER);

  // Probe Materios — failure leaves balances null but does NOT abort the
  // whole snapshot (the Koios stream might still carry headline data).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any | null = null;
  let head = 0;
  try {
    api = await apiFactory();
    head = await fetchHead(api);
  } catch (err) {
    console.warn(
      `[explorer-spo-rewards] materios unreachable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Materios balances — parallel; null on per-account failure.
  const balanceByAura = new Map<string, bigint | null>();
  if (api !== null) {
    await Promise.all(
      entries.map(async ([auraHex]) => {
        const ss58 = auraPubkeyToSs58(auraHex);
        const bal = await fetchMatraBalance(api, ss58);
        balanceByAura.set(auraHex, bal);
      }),
    );
  } else {
    for (const [auraHex] of entries) balanceByAura.set(auraHex, null);
  }

  // Koios pool histories — parallel; one failure on ANY pool throws and
  // bubbles to the caller (which 503s). Per-pool 4xx/5xx inside
  // defaultKoiosFetch is already swallowed to []; only network-level
  // failures (DNS, TLS, timeout) get here.
  const poolHistByPool = new Map<string, KoiosPoolHistoryRecord[]>();
  const cardanoPools = entries
    .map(([, v]) => v.cardano_pool_id)
    .filter((p): p is string => p !== null);

  await Promise.all(
    cardanoPools.map(async (poolId) => {
      const hist = await koiosFetch(poolId);
      poolHistByPool.set(poolId, hist);
    }),
  );

  const operators: OperatorRewardsRow[] = entries.map(([auraHex, meta]) => {
    const ss58 = auraPubkeyToSs58(auraHex);
    const matraRaw = balanceByAura.get(auraHex) ?? null;
    const matraRawStr = matraRaw === null ? null : matraRaw.toString();
    const matraDisplay = matraRaw === null ? null : formatMatra(matraRaw);

    let row: OperatorRewardsRow = {
      label: meta.label,
      trust: meta.trust,
      materios_ss58: ss58,
      matra_lifetime_raw: matraRawStr,
      matra_lifetime: matraDisplay,
      cardano_pool_id: meta.cardano_pool_id,
      cardano_blocks_lifetime: null,
      cardano_pool_fees_lifetime_raw: null,
      cardano_pool_fees_lifetime: null,
      cardano_delegator_rewards_lifetime_raw: null,
      cardano_delegator_rewards_lifetime: null,
      cardano_active_stake_raw: null,
      cardano_active_stake: null,
      cardano_first_epoch: null,
      cardano_last_epoch_with_blocks: null,
    };

    if (meta.cardano_pool_id) {
      const hist = poolHistByPool.get(meta.cardano_pool_id) ?? [];
      const agg = aggregatePoolHistory(hist);
      row = {
        ...row,
        cardano_blocks_lifetime: agg.blocks,
        cardano_pool_fees_lifetime_raw: agg.fees.toString(),
        cardano_pool_fees_lifetime: formatAda(agg.fees, 6),
        cardano_delegator_rewards_lifetime_raw: agg.delegRewards.toString(),
        cardano_delegator_rewards_lifetime: formatAda(agg.delegRewards, 6),
        cardano_active_stake_raw:
          agg.activeStake === null ? null : agg.activeStake.toString(),
        cardano_active_stake:
          agg.activeStake === null ? null : formatAda(agg.activeStake, 3),
        cardano_first_epoch: agg.firstEpoch,
        cardano_last_epoch_with_blocks: agg.lastEpochWithBlocks,
      };
    }

    return row;
  });

  return {
    asOf: new Date().toISOString(),
    head,
    operators,
  };
}

export function createExplorerSpoRewardsRouter(deps: RouterDeps = {}): Router {
  const router = Router();
  const apiFactory = deps.apiFactory ?? defaultApiFactory;
  const koiosFetch = deps.koiosFetch ?? defaultKoiosFetch;

  let cached: RewardsSnapshot | null = null;
  let cachedAt = 0;

  router.get(
    "/preprod-explorer/api/spo-rewards",
    async (_req: Request, res: Response) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=60");

      const now = Date.now();
      if (!deps.disableCache && cached && now - cachedAt < CACHE_TTL_MS) {
        res.status(200).end(JSON.stringify(cached));
        return;
      }

      try {
        const snapshot = await buildSnapshot(apiFactory, koiosFetch);
        cached = snapshot;
        cachedAt = now;
        res.status(200).end(JSON.stringify(snapshot));
      } catch (err) {
        // Only reachable when koiosFetch THROWS — defaultKoiosFetch swallows
        // 4xx/5xx into []; a thrown error here means DNS, TLS, or abort
        // (Koios genuinely unreachable from the gateway). 503 matches the
        // route's contract: "either fresh dual-stream data or an honest
        // unavailability signal for the Cardano side".
        console.warn(
          `[explorer-spo-rewards] koios unreachable: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(503).end(JSON.stringify({ error: "koios_unreachable" }));
      }
    },
  );

  return router;
}

export const explorerSpoRewardsRouter = createExplorerSpoRewardsRouter();
