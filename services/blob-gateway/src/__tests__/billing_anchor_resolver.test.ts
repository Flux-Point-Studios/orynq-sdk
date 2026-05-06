/**
 * Unit tests for `billing/anchor_resolver.ts`. NO chain, NO live cert-daemon.
 *
 * Builds synthetic checkpoint-history.json + anchor-worker.log files in a
 * tmpdir, then exercises:
 *   - happy path: cert_hash → root → tx_hash
 *   - missing log: cert_hash → root → null tx_hash
 *   - missing history file: every cert_hash → null
 *   - malformed history: every cert_hash → null
 *   - parser handles multiple anchor lines, latest wins per root20
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  resolveAnchorTxs,
  resetAnchorResolverForTests,
  parseAnchorWorkerLog,
} from "../billing/anchor_resolver.js";

interface CtxFx {
  dir: string;
  history: string;
  log: string;
}

function setup(): CtxFx {
  const dir = mkdtempSync(join(tmpdir(), "anchor-resolver-test-"));
  return {
    dir,
    history: join(dir, "checkpoint-history.json"),
    log: join(dir, "anchor-worker.log"),
  };
}

function teardown(ctx: CtxFx): void {
  rmSync(ctx.dir, { recursive: true, force: true });
}

describe("parseAnchorWorkerLog", () => {
  test("extracts root20 → tx_hash from canonical line", () => {
    const text = `[anchor-worker] anchored root=64cdf1c4495bb797ba5a... as tx 37c6510e622e58fd12c61a2c806a6949399d6a74a27c1308a6caf3e76177e671 [burst-head, cache=0]
[anchor-worker] anchored root=839844b7e248930d4e13... as tx a426cdcb6e8d11ca8ac39ddce7a6e24044dc988dad406d8f3c60a9aa7bd7c146 [burst-head, cache=1]`;
    const map = parseAnchorWorkerLog(text);
    expect(map.size).toBe(2);
    expect(map.get("64cdf1c4495bb797ba5a")).toBe(
      "37c6510e622e58fd12c61a2c806a6949399d6a74a27c1308a6caf3e76177e671",
    );
    expect(map.get("839844b7e248930d4e13")).toBe(
      "a426cdcb6e8d11ca8ac39ddce7a6e24044dc988dad406d8f3c60a9aa7bd7c146",
    );
  });

  test("ignores non-matching lines", () => {
    const text = `random log noise
[anchor-worker] anchor failed
[anchor-worker] anchored root=839844b7e248930d4e13... as tx a426cdcb6e8d11ca8ac39ddce7a6e24044dc988dad406d8f3c60a9aa7bd7c146`;
    const map = parseAnchorWorkerLog(text);
    expect(map.size).toBe(1);
  });

  test("later line for same root wins", () => {
    const text = `[anchor-worker] anchored root=839844b7e248930d4e13... as tx aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
[anchor-worker] anchored root=839844b7e248930d4e13... as tx bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;
    const map = parseAnchorWorkerLog(text);
    expect(map.get("839844b7e248930d4e13")).toBe("b".repeat(64));
  });
});

describe("resolveAnchorTxs", () => {
  let ctx: CtxFx;
  beforeEach(() => {
    ctx = setup();
    resetAnchorResolverForTests();
  });
  afterEach(() => {
    teardown(ctx);
    resetAnchorResolverForTests();
  });

  test("history + log present → resolves cert_hash to tx", async () => {
    const certHashFull =
      "5d5471680874bead8b75a6d8eef32047a1806d767520510f01082950d2151825";
    const rootFull =
      "c3f526ab59203761bf974fa177b934623ee24b0ac15627a37f803baa6440403a";
    const root20 = rootFull.slice(0, 20);
    const txFull =
      "deadbeef".repeat(8); // 64 hex
    const history = [
      {
        timestamp: 1,
        root_hash: rootFull,
        manifest_hash: "ff".repeat(32),
        manifest: {},
        leaves: [
          {
            receipt_id: "0x" + "00".repeat(32),
            cert_hash: certHashFull,
            block_num: 1,
            leaf_hash: "ee".repeat(32),
          },
        ],
      },
    ];
    writeFileSync(ctx.history, JSON.stringify(history));
    writeFileSync(
      ctx.log,
      `[anchor-worker] anchored root=${root20}... as tx ${txFull} [burst-head, cache=0]\n`,
    );

    const out = await resolveAnchorTxs([certHashFull], {
      cert_history_path: ctx.history,
      anchor_worker_log_path: ctx.log,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(txFull);
  });

  test("history present, log missing → null tx", async () => {
    const certHashFull =
      "5d5471680874bead8b75a6d8eef32047a1806d767520510f01082950d2151825";
    const history = [
      {
        timestamp: 1,
        root_hash:
          "c3f526ab59203761bf974fa177b934623ee24b0ac15627a37f803baa6440403a",
        manifest_hash: "ff".repeat(32),
        manifest: {},
        leaves: [{ cert_hash: certHashFull }],
      },
    ];
    writeFileSync(ctx.history, JSON.stringify(history));
    // do NOT write log

    const out = await resolveAnchorTxs([certHashFull], {
      cert_history_path: ctx.history,
      anchor_worker_log_path: ctx.log,
    });
    expect(out[0]).toBeNull();
  });

  test("history file missing → every cert_hash maps to null (no throw)", async () => {
    const out = await resolveAnchorTxs(["0x" + "ab".repeat(32)], {
      cert_history_path: join(ctx.dir, "no-such-history.json"),
      anchor_worker_log_path: join(ctx.dir, "no-such-log"),
    });
    expect(out[0]).toBeNull();
  });

  test("malformed history JSON → every cert_hash maps to null (no throw)", async () => {
    writeFileSync(ctx.history, "{not_valid_json");
    const out = await resolveAnchorTxs(["0x" + "ab".repeat(32)], {
      cert_history_path: ctx.history,
      anchor_worker_log_path: ctx.log,
    });
    expect(out[0]).toBeNull();
  });

  test("malformed history root: not an array → every cert_hash maps to null", async () => {
    writeFileSync(ctx.history, JSON.stringify({ checkpoints: [] }));
    const out = await resolveAnchorTxs(["0x" + "ab".repeat(32)], {
      cert_history_path: ctx.history,
      anchor_worker_log_path: ctx.log,
    });
    expect(out[0]).toBeNull();
  });

  test("nullish cert_hash in input → returns null at that position", async () => {
    writeFileSync(ctx.history, JSON.stringify([]));
    const out = await resolveAnchorTxs([null, "0x" + "ab".repeat(32), null], {
      cert_history_path: ctx.history,
      anchor_worker_log_path: ctx.log,
    });
    expect(out).toEqual([null, null, null]);
  });

  test("with-prefix and lowercase normalisation", async () => {
    const certHashFull =
      "5d5471680874bead8b75a6d8eef32047a1806d767520510f01082950d2151825";
    const rootFull =
      "c3f526ab59203761bf974fa177b934623ee24b0ac15627a37f803baa6440403a";
    const txFull = "ab".repeat(32);
    const history = [
      {
        timestamp: 1,
        root_hash: rootFull.toUpperCase(),
        manifest_hash: "ff".repeat(32),
        manifest: {},
        leaves: [{ cert_hash: certHashFull.toUpperCase() }],
      },
    ];
    writeFileSync(ctx.history, JSON.stringify(history));
    writeFileSync(
      ctx.log,
      `[anchor-worker] anchored root=${rootFull.slice(0, 20)}... as tx ${txFull} [burst-head]\n`,
    );

    // input with 0x prefix + uppercase
    const out = await resolveAnchorTxs(["0x" + certHashFull.toUpperCase()], {
      cert_history_path: ctx.history,
      anchor_worker_log_path: ctx.log,
    });
    expect(out[0]).toBe(txFull);
  });

  test("empty input → empty output", async () => {
    const out = await resolveAnchorTxs([]);
    expect(out).toEqual([]);
  });
});
