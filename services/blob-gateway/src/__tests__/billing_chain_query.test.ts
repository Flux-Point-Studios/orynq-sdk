/**
 * Unit tests for `billing/chain_query.ts::queryCompositeTrustScores` (task #142).
 *
 * Pins the contract that `chain_query.ts` exposes to the route handler:
 *
 *   - When chain returns a u8 (0..=4), surface that integer.
 *   - When the storage adapter returns `{ value: N }` or a Codec with
 *     `.toNumber()`, decode correctly. The substrate metadata can render
 *     `pub struct CompositeTrustScore(pub u8);` either way depending on
 *     the @polkadot/api version.
 *   - When the storage adapter returns out-of-band values (>4 / negative /
 *     non-numeric), return null. We never fabricate a score.
 *   - When the api connection isn't available, return null per record.
 *   - When the pallet isn't present (pre-spec-213 runtime), return null.
 *   - When `result.isEmpty === true` (forward-compat for OptionQuery),
 *     return 0.
 *
 * Tests inject a stub via the `apiOverride` parameter so we don't need a
 * live WS — the same shape as `queryReceiptStatuses` exposes for tests.
 */

import { describe, test, expect } from "vitest";
import {
  queryCompositeTrustScores,
  receiptIdFromContentHash,
} from "../billing/chain_query.js";

/** Build a fake api stub that returns `value` for any compositeTrustScores call. */
function fakeApi(value: unknown): unknown {
  return {
    query: {
      teeAttestation: {
        compositeTrustScores: async () => value,
      },
    },
  };
}

describe("queryCompositeTrustScores — decoding paths", () => {
  test("returns empty array on empty input", async () => {
    const out = await queryCompositeTrustScores([], fakeApi(0));
    expect(out).toEqual([]);
  });

  test("decodes a bare number as the score (0..4 range)", async () => {
    const ch = "ab".repeat(32);
    // toJSON on a `pub struct(pub u8)` pallet type often renders as a bare number.
    const stub = {
      query: {
        teeAttestation: {
          compositeTrustScores: async () => ({ toJSON: () => 2 }),
        },
      },
    };
    const out = await queryCompositeTrustScores([ch], stub);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      content_hash: ch,
      receipt_id: receiptIdFromContentHash(ch),
      composite_trust_score: 2,
    });
  });

  test("decodes a { value: N } shape", async () => {
    const ch = "cd".repeat(32);
    const stub = {
      query: {
        teeAttestation: {
          compositeTrustScores: async () => ({ toJSON: () => ({ value: 3 }) }),
        },
      },
    };
    const out = await queryCompositeTrustScores([ch], stub);
    expect(out[0].composite_trust_score).toBe(3);
  });

  test("decodes via .toNumber() when toJSON yields a Codec", async () => {
    const ch = "01".repeat(32);
    // Some @polkadot/api versions return a Codec at toJSON; .toNumber() lives on the value.
    const stub = {
      query: {
        teeAttestation: {
          compositeTrustScores: async () => ({
            toJSON: () => ({ toNumber: () => 4 }),
          }),
        },
      },
    };
    const out = await queryCompositeTrustScores([ch], stub);
    expect(out[0].composite_trust_score).toBe(4);
  });

  test("returns 0 for the chain default (committee-attested baseline)", async () => {
    // ValueQuery means missing keys return 0. Pallet default. This is the
    // path EVERY production record will hit until task #143 ships.
    const ch = "ee".repeat(32);
    const stub = {
      query: {
        teeAttestation: {
          compositeTrustScores: async () => ({ toJSON: () => 0 }),
        },
      },
    };
    const out = await queryCompositeTrustScores([ch], stub);
    expect(out[0].composite_trust_score).toBe(0);
  });

  test("returns 0 when result.isEmpty === true (OptionQuery forward-compat)", async () => {
    const ch = "12".repeat(32);
    const stub = {
      query: {
        teeAttestation: {
          compositeTrustScores: async () => ({ isEmpty: true }),
        },
      },
    };
    const out = await queryCompositeTrustScores([ch], stub);
    expect(out[0].composite_trust_score).toBe(0);
  });

  test("returns null for out-of-band score (>4 or <0)", async () => {
    const ch1 = "22".repeat(32);
    const ch2 = "33".repeat(32);
    const stub = {
      query: {
        teeAttestation: {
          compositeTrustScores: async (rid: string) => {
            // Different bogus values per receipt id — proves we don't
            // collapse / fabricate a score.
            const isFirst = rid === receiptIdFromContentHash(ch1);
            return { toJSON: () => (isFirst ? 99 : -3) };
          },
        },
      },
    };
    const out = await queryCompositeTrustScores([ch1, ch2], stub);
    const byHash = new Map(out.map((r) => [r.content_hash, r]));
    expect(byHash.get(ch1)?.composite_trust_score).toBeNull();
    expect(byHash.get(ch2)?.composite_trust_score).toBeNull();
  });

  test("returns null when the pallet is missing on pre-upgrade chain", async () => {
    const ch = "44".repeat(32);
    // Old runtime: api.query.teeAttestation doesn't exist at all.
    const stub = { query: {} };
    const out = await queryCompositeTrustScores([ch], stub);
    expect(out[0].composite_trust_score).toBeNull();
  });

  test("returns null when the storage query throws", async () => {
    const ch = "55".repeat(32);
    const stub = {
      query: {
        teeAttestation: {
          compositeTrustScores: async () => {
            throw new Error("metadata mismatch");
          },
        },
      },
    };
    const out = await queryCompositeTrustScores([ch], stub);
    expect(out[0].composite_trust_score).toBeNull();
  });

  test("dedupes input content_hashes (one query per unique value)", async () => {
    // Same content_hash twice in input should produce one entry.
    const ch = "66".repeat(32);
    let calls = 0;
    const stub = {
      query: {
        teeAttestation: {
          compositeTrustScores: async () => {
            calls += 1;
            return { toJSON: () => 1 };
          },
        },
      },
    };
    const out = await queryCompositeTrustScores([ch, ch, ch], stub);
    expect(out).toHaveLength(1);
    expect(out[0].composite_trust_score).toBe(1);
    expect(calls).toBe(1);
  });
});
