/**
 * Tests for GET /preprod-explorer/api/validators (task #337).
 *
 * The route is injected with a fake `apiFactory` so we never have to stand
 * up a real WS RPC. Each test wires the shapes returned by the storage
 * queries explicitly — that way regressions in the response shape get
 * caught here, and a real RPC outage in CI doesn't flake the suite.
 */

import { describe, test, expect, beforeAll } from "vitest";
import express from "express";
import {
  createExplorerValidatorsRouter,
  type ExplorerApiFactory,
} from "../explorer-validators.js";

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

// Known operator pubkeys from src/data/operators.json — we use the real
// values so the loader is also exercised. Slot-encoding helper below
// produces a digest log that decodes to a specific slot via @polkadot/api.
const GEMTEK = "0x03477fc2a5b7b287ed89ec47556e0002aa0d7cf88b1fbd6fbe1722eb1ef7873599";
const NODE2 = "0x034f293c281c59b8200ea316d1c8d7154c1b06a9ed2603251049b9fda63f2ed6ce";
const NODE3 = "0x03f2c1c50d62f023c637afe79996843157c6914e929605cde3c53de47a6896fc0e";
const UNKNOWN_PUBKEY =
  "0x" + "ab".repeat(33); // 33-byte secp256k1 compressed-pubkey shape, not in operators.json

const AURA_GEMTEK = "0x" + "11".repeat(32);
const AURA_NODE2 = "0x" + "22".repeat(32);
const AURA_NODE3 = "0x" + "33".repeat(32);

const GRANDPA_GEMTEK = "0x" + "aa".repeat(32);
const GRANDPA_NODE2 = "0x" + "bb".repeat(32);
const GRANDPA_NODE3 = "0x" + "cc".repeat(32);

// AURA pre-runtime log identifier is the 4-byte little-endian "aura" tag
// in the polkadot.js engine name. The api factory mock returns a digest
// log directly via the logs accessor, so the route just reads `.asPreRuntime[1]`.
function makeDigest(slot: bigint): unknown[] {
  // u64 LE-encoded slot — exactly what @polkadot/api gives back when you
  // call AuraPreDigest::decode on a real header.
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(slot);
  return [
    {
      isPreRuntime: true,
      asPreRuntime: [{ toString: () => "aura" }, { toU8a: () => new Uint8Array(buf) }],
    },
  ];
}

interface FakeChainConfig {
  headNumber: number;
  /**
   * For each block height 0..headNumber, the slot to encode in the digest.
   * If missing, no aura preruntime is emitted (treated as "no author").
   */
  slotByHeight?: Map<number, bigint>;
  currentCommittee: Array<[string, { aura: string; grandpa: string }]>;
  nextCommittee:
    | { epoch: number; committee: Array<[string, { aura: string; grandpa: string }]> }
    | null;
  // Override the head timestamp for stable golden checks
  asOfIso: string;
  scEpoch: number;
}

function makeFakeApi(cfg: FakeChainConfig): ReturnType<ExplorerApiFactory> {
  const headHash = "0xHEAD";
  const headerFor = (n: number) => ({
    number: { toNumber: () => n },
    hash: { toHex: () => `0x${n.toString(16).padStart(64, "0")}` },
    digest: {
      logs: cfg.slotByHeight?.has(n)
        ? makeDigest(cfg.slotByHeight.get(n)!)
        : [],
    },
  });

  const api = {
    rpc: {
      chain: {
        getHeader: async (hash?: unknown) => {
          if (hash === undefined) return headerFor(cfg.headNumber);
          const hex = String((hash as { toHex?: () => string }).toHex?.() ?? hash);
          const n = parseInt(hex.replace(/^0x/, ""), 16);
          return headerFor(n);
        },
        getBlockHash: async (n: number) => ({
          toHex: () => `0x${n.toString(16).padStart(64, "0")}`,
        }),
      },
    },
    query: {
      sessionCommitteeManagement: {
        currentCommittee: async () => ({
          toJSON: () => ({ committee: cfg.currentCommittee }),
        }),
        nextCommittee: async () => ({
          isNone: cfg.nextCommittee === null,
          unwrapOr: (def: unknown) =>
            cfg.nextCommittee === null
              ? def
              : { toJSON: () => cfg.nextCommittee },
          toJSON: () => cfg.nextCommittee,
        }),
      },
      session: {
        currentIndex: async () => ({ toNumber: () => cfg.scEpoch }),
      },
    },
    consts: {
      // No-op; the route reads minAttestationThreshold via runtime call if
      // available, falls back to a constant.
    },
    disconnect: async () => undefined,
  };

  return Promise.resolve(api as unknown as Awaited<ReturnType<ExplorerApiFactory>>);
}

beforeAll(() => {
  // no-op — every test builds its own app + factory
});

describe("GET /preprod-explorer/api/validators", () => {
  test("happy path: returns 200 with parseable JSON and non-empty currentCommittee", async () => {
    // 3-member committee, head=10, slots assigned so author = index 0,1,2 spread
    const slotByHeight = new Map<number, bigint>();
    for (let n = 1; n <= 10; n++) slotByHeight.set(n, BigInt(n));
    const cfg: FakeChainConfig = {
      headNumber: 10,
      slotByHeight,
      currentCommittee: [
        [GEMTEK, { aura: AURA_GEMTEK, grandpa: GRANDPA_GEMTEK }],
        [NODE2, { aura: AURA_NODE2, grandpa: GRANDPA_NODE2 }],
        [NODE3, { aura: AURA_NODE3, grandpa: GRANDPA_NODE3 }],
      ],
      nextCommittee: null,
      asOfIso: "2026-05-21T14:30:00Z",
      scEpoch: 494271,
    };
    const app = express();
    app.use(createExplorerValidatorsRouter({ apiFactory: () => makeFakeApi(cfg) }));

    const res = await callApp(app, "/preprod-explorer/api/validators");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["access-control-allow-origin"]).toBe("*");

    const body = res.body as Record<string, unknown>;
    expect(body.head).toBe(10);
    expect(typeof body.asOf).toBe("string");
    expect(body.scEpoch).toBe(494271);
    expect(Array.isArray(body.currentCommittee)).toBe(true);
    expect((body.currentCommittee as unknown[]).length).toBe(3);
    expect(body.nextCommittee).toEqual([]);
    expect(typeof body.minAttestationThreshold).toBe("number");

    const cc = body.currentCommittee as Array<Record<string, unknown>>;
    const gem = cc.find((c) => c.sidechain === GEMTEK)!;
    expect(gem.label).toBe("Gemtek");
    expect(gem.trust).toBe("permissioned");
    expect(gem.aura).toBe(AURA_GEMTEK);
    expect(gem.grandpa).toBe(GRANDPA_GEMTEK);
    expect(typeof gem.producing).toBe("boolean");
    expect(typeof gem.blocksInLast60).toBe("number");
    // With slots 1..10 across 3 members, every member should have authored
    // at least one block (round-robin slot % 3).
    expect(gem.producing).toBe(true);
    expect(gem.blocksInLast60).toBeGreaterThan(0);
  });

  test("unknown sidechain pubkey: returns label:null, trust:'unknown' (no 500)", async () => {
    const cfg: FakeChainConfig = {
      headNumber: 5,
      slotByHeight: new Map([
        [1, 0n],
        [2, 1n],
        [3, 0n],
        [4, 1n],
        [5, 0n],
      ]),
      currentCommittee: [
        [GEMTEK, { aura: AURA_GEMTEK, grandpa: GRANDPA_GEMTEK }],
        [UNKNOWN_PUBKEY, { aura: "0x" + "44".repeat(32), grandpa: "0x" + "55".repeat(32) }],
      ],
      nextCommittee: {
        epoch: 494272,
        committee: [
          [UNKNOWN_PUBKEY, { aura: "0x" + "44".repeat(32), grandpa: "0x" + "55".repeat(32) }],
        ],
      },
      asOfIso: "2026-05-21T14:30:00Z",
      scEpoch: 494271,
    };
    const app = express();
    app.use(createExplorerValidatorsRouter({ apiFactory: () => makeFakeApi(cfg) }));

    const res = await callApp(app, "/preprod-explorer/api/validators");
    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    const cc = body.currentCommittee as Array<Record<string, unknown>>;
    const unk = cc.find((c) => c.sidechain === UNKNOWN_PUBKEY)!;
    expect(unk.label).toBeNull();
    expect(unk.trust).toBe("unknown");

    const nc = body.nextCommittee as Array<Record<string, unknown>>;
    expect(nc.length).toBe(1);
    expect(nc[0].label).toBeNull();
    expect(nc[0].trust).toBe("unknown");
  });

  test("WS unreachable: returns 503 + error code (does NOT 500)", async () => {
    const app = express();
    app.use(
      createExplorerValidatorsRouter({
        apiFactory: () => Promise.reject(new Error("connect ECONNREFUSED")),
      }),
    );

    const res = await callApp(app, "/preprod-explorer/api/validators");
    expect(res.status).toBe(503);
    expect((res.body as Record<string, unknown>).error).toBe("chain_unreachable");
  });

  test("nextCommittee == null is serialized as []", async () => {
    const cfg: FakeChainConfig = {
      headNumber: 3,
      slotByHeight: new Map([[1, 0n], [2, 1n], [3, 0n]]),
      currentCommittee: [
        [GEMTEK, { aura: AURA_GEMTEK, grandpa: GRANDPA_GEMTEK }],
        [NODE2, { aura: AURA_NODE2, grandpa: GRANDPA_NODE2 }],
      ],
      nextCommittee: null,
      asOfIso: "2026-05-21T14:30:00Z",
      scEpoch: 494271,
    };
    const app = express();
    app.use(createExplorerValidatorsRouter({ apiFactory: () => makeFakeApi(cfg) }));
    const res = await callApp(app, "/preprod-explorer/api/validators");
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).nextCommittee).toEqual([]);
  });

  test("producing:false when committee member authored zero of the last 60 blocks", async () => {
    // Committee has 3 members, but only slot%3 == 0 ever appears — only member[0]
    // is producing; member[1] and member[2] should report producing:false.
    const slotByHeight = new Map<number, bigint>();
    for (let n = 1; n <= 12; n++) slotByHeight.set(n, BigInt((n - 1) * 3)); // 0,3,6,9...
    const cfg: FakeChainConfig = {
      headNumber: 12,
      slotByHeight,
      currentCommittee: [
        [GEMTEK, { aura: AURA_GEMTEK, grandpa: GRANDPA_GEMTEK }],
        [NODE2, { aura: AURA_NODE2, grandpa: GRANDPA_NODE2 }],
        [NODE3, { aura: AURA_NODE3, grandpa: GRANDPA_NODE3 }],
      ],
      nextCommittee: null,
      asOfIso: "2026-05-21T14:30:00Z",
      scEpoch: 494271,
    };
    const app = express();
    app.use(createExplorerValidatorsRouter({ apiFactory: () => makeFakeApi(cfg) }));

    const res = await callApp(app, "/preprod-explorer/api/validators");
    expect(res.status).toBe(200);
    const cc = (res.body as { currentCommittee: Array<Record<string, unknown>> })
      .currentCommittee;
    const gem = cc.find((c) => c.sidechain === GEMTEK)!;
    const node2 = cc.find((c) => c.sidechain === NODE2)!;
    const node3 = cc.find((c) => c.sidechain === NODE3)!;
    expect(gem.producing).toBe(true);
    expect(gem.blocksInLast60).toBeGreaterThan(0);
    expect(node2.producing).toBe(false);
    expect(node2.blocksInLast60).toBe(0);
    expect(node3.producing).toBe(false);
    expect(node3.blocksInLast60).toBe(0);
  });
});
