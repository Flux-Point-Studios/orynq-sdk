/**
 * Tests for the receipt-indexer key-enumeration paginator.
 *
 * Bug recap (Penny ops report, task #145): the prior implementation called
 *   state_getKeysPaged(prefix, 100, null)
 * on every tick with a hard-coded `null` start_key, so it only ever saw the
 * first 100 storage keys in blake2_128(receipt_id) order. Receipts whose hash
 * landed past that page were silently never indexed, which left them stuck
 * at availability_cert_hash = 0x00... and the cert-daemon would log
 *   "No locator found for 0x..."
 * indefinitely. These tests pin down the paginator behaviour so the bug can't
 * regress.
 *
 * Mocking strategy: we mock global `fetch` at the module boundary via
 * `vi.stubGlobal("fetch", ...)`. A small handler dispatches on the
 * JSON-RPC method so each test can script its own storage responses.
 *
 * Timers: the indexer schedules a recurring `setInterval` callback. We use
 * `vi.useFakeTimers()` so that (a) no real timer ever fires in test context
 * and (b) the "walks full map on each tick" test can drive a second tick
 * deterministically with `vi.advanceTimersByTimeAsync`.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// OrinqReceipts.Receipts storage prefix = twox128("OrinqReceipts") ++ twox128("Receipts").
// Must match the runtime-computed RECEIPTS_STORAGE_PREFIX constant inside
// receipt-indexer.ts. Kept as a literal here (not recomputed) so a regression
// to a stale hand-transcribed hex literal in the production code fails loudly.
const RECEIPTS_PREFIX =
  "0xf2f45ef88f71bc25f444a160450145be5087a88ab53079a394ab62a465d46183";

// The indexer extracts receipt_id from the last 32 bytes (64 hex chars) of
// each storage key: prefix(32) + blake2_128(16) + receipt_id(32). To keep
// tests readable we build keys from a receipt_id seed and a "page number"
// byte so the keys are unique, plausibly-shaped, and easy to inspect.
function makeKey(page: number, index: number): string {
  // 16-byte hash prefix (32 hex) + 32-byte receipt id (64 hex). Receipt id
  // carries the (page, index) for easy assertions.
  const hash = "aa".repeat(16);
  const receiptId =
    page.toString(16).padStart(2, "0").repeat(16) +
    index.toString(16).padStart(2, "0").repeat(16);
  return RECEIPTS_PREFIX + hash + receiptId;
}

// Build a well-formed ReceiptRecord hex value: schema_hash(32) +
// content_hash(32) + trailing bytes. The indexer only reads the
// content_hash slice (bytes 32..64); everything else can be zeroed.
function makeReceiptValue(contentHashHex: string): string {
  const schema = "00".repeat(32);
  const content = contentHashHex.padStart(64, "0").slice(-64);
  const tail = "00".repeat(16); // extra payload so length > 128 hex chars
  return "0x" + schema + content + tail;
}

interface KeyPageScript {
  // Ordered list of page responses. Each page is the array of keys returned
  // to the NEXT state_getKeysPaged call. When exhausted we return [].
  pages: string[][];
}

interface FetchHarness {
  calls: Array<{ method: string; params: unknown[] }>;
  // Mutable so tests can extend pages between ticks.
  script: KeyPageScript;
  bestBlockHex: string;
  receiptCount: number;
  // Map of storage key -> receipt value (hex). Any unknown key returns null.
  values: Map<string, string>;
}

function makeHandler(harness: FetchHarness) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method: string;
      params: unknown[];
    };
    harness.calls.push({ method: body.method, params: body.params });

    const respond = (result: unknown): Response => {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    switch (body.method) {
      case "chain_getHeader":
        return respond({ number: harness.bestBlockHex });
      case "chain_getBlockHash":
        return respond("0x" + "bb".repeat(32));
      case "orinq_getReceiptCount":
        return respond(harness.receiptCount);
      case "state_getKeysPaged": {
        const page = harness.script.pages.shift() ?? [];
        return respond(page);
      }
      case "state_getStorage": {
        const key = body.params[0] as string;
        return respond(harness.values.get(key) ?? null);
      }
      default:
        return respond(null);
    }
  });
}

describe("receipt-indexer pagination (task #145 regression)", () => {
  let tmp: string;
  let indexRoot: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "blob-gateway-indexer-test-"));
    indexRoot = join(tmp, "index", "receipt-to-content");
    // Pre-create the index dir so fast-path reads don't hit a "no such
    // directory" noise-branch (the indexer also mkdir -p's on first write,
    // so this is strictly belt-and-suspenders).
    await mkdir(indexRoot, { recursive: true });
    // Fresh env for each test. STORAGE_PATH is read by config.ts at module
    // load so we must set it BEFORE dynamic-importing the indexer.
    process.env.STORAGE_PATH = tmp;
    process.env.MATERIOS_RPC_URL = "http://127.0.0.1:19999";
    // vi.resetModules() forces a fresh config.ts evaluation per test.
    vi.resetModules();
    // Fake timers so setInterval never schedules a real tick; each test
    // controls its own advancement via vi.advanceTimersByTimeAsync.
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.STORAGE_PATH;
    delete process.env.MATERIOS_RPC_URL;
    await rm(tmp, { recursive: true, force: true });
  });

  test("test_paginates_through_multiple_batches", async () => {
    // Four-call script: two full PAGE_SIZE pages, one short page, one
    // empty sentinel. Shape in the task brief was "[100, 100, 50, 0]"
    // at the conceptual level; we instantiate it at PAGE_SIZE=1000 so
    // the real short-circuit `batch.length < PAGE_SIZE` does not fire
    // prematurely. The net behaviour asserted — "walk until empty" —
    // is identical: if pagination stays at a single call, this fails;
    // if it stops early on any short batch below PAGE_SIZE, this also
    // fails on the 3rd page (500 keys, < 1000).
    const PAGE_SIZE = 1000;
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => makeKey(1, i));
    const page2 = Array.from({ length: PAGE_SIZE }, (_, i) => makeKey(2, i));
    const page3 = Array.from({ length: 500 }, (_, i) => makeKey(3, i));
    const allExpected = [...page1, ...page2, ...page3];

    const values = new Map<string, string>();
    for (let i = 0; i < allExpected.length; i++) {
      // Distinct content_hash per key so we can assert the map 1:1.
      values.set(
        allExpected[i],
        makeReceiptValue(i.toString(16).padStart(64, "0")),
      );
    }

    const harness: FetchHarness = {
      calls: [],
      script: { pages: [page1, page2, page3, []] },
      bestBlockHex: "0x64", // 100 decimal
      receiptCount: allExpected.length,
      values,
    };
    vi.stubGlobal("fetch", makeHandler(harness));

    const { startReceiptIndexer } = await import("../receipt-indexer.js");
    await startReceiptIndexer();

    // Every state_getKeysPaged call we made. Expected: 3 calls when the
    // implementation short-circuits on `batch.length < PAGE_SIZE` (page3
    // has 500 keys which < 1000 so no 4th call is needed). The critical
    // regression guard is that it's > 1 (prior bug: 1 hard-coded call).
    const pagedCalls = harness.calls.filter(
      (c) => c.method === "state_getKeysPaged",
    );
    expect(pagedCalls.length).toBeGreaterThanOrEqual(3);
    expect(pagedCalls[0].params).toEqual([RECEIPTS_PREFIX, PAGE_SIZE, null]);
    // start_key MUST advance to the last key of the prior page.
    expect(pagedCalls[1].params).toEqual([
      RECEIPTS_PREFIX,
      PAGE_SIZE,
      page1[page1.length - 1],
    ]);
    expect(pagedCalls[2].params).toEqual([
      RECEIPTS_PREFIX,
      PAGE_SIZE,
      page2[page2.length - 1],
    ]);

    // All 2500 receipts must have been indexed to disk.
    const files = await readdir(indexRoot);
    expect(files).toHaveLength(allExpected.length);
  });

  test("test_walks_full_map_on_each_tick", async () => {
    // This test pins the re-walk-each-tick behaviour: the indexer must
    // NOT carry a cursor across poll invocations. New receipts land at
    // random blake2_128 hash positions; a receipt submitted between
    // tick T and tick T+1 may hash to page 3 even though at tick T the
    // last-seen page was page 2. If we cached a cursor we'd skip it.
    //
    // Stage: full-size pages so the real PAGE_SIZE=1000 short-circuit
    // doesn't hide a cursor-retention bug. `lateKey` is appended onto
    // tick 2's page 2, past the pagination boundary that tick 1 saw.
    const PAGE_SIZE = 1000;
    const tick1Page1 = Array.from({ length: PAGE_SIZE }, (_, i) =>
      makeKey(1, i),
    );
    const tick1Page2 = Array.from({ length: PAGE_SIZE }, (_, i) =>
      makeKey(2, i),
    );
    // Late-arriving key — deliberately placed past tick 1's walked range.
    const lateKey = makeKey(3, 999);

    const values = new Map<string, string>();
    for (const k of [...tick1Page1, ...tick1Page2, lateKey]) {
      values.set(k, makeReceiptValue(k.slice(-64)));
    }

    // Script: tick 1 = 3 calls (page1, page2, empty).
    //         tick 2 = 3 calls (page1, page2, page-containing-lateKey).
    //                  Final page is short (< PAGE_SIZE), so no empty
    //                  sentinel is needed — paginator short-circuits.
    const harness: FetchHarness = {
      calls: [],
      script: {
        pages: [
          // Tick 1
          tick1Page1,
          tick1Page2,
          [],
          // Tick 2
          tick1Page1,
          tick1Page2,
          [lateKey],
        ],
      },
      bestBlockHex: "0x64",
      receiptCount: tick1Page1.length + tick1Page2.length,
      values,
    };
    vi.stubGlobal("fetch", makeHandler(harness));

    const { startReceiptIndexer } = await import("../receipt-indexer.js");
    await startReceiptIndexer();

    // After tick 1: all 2000 page-1+page-2 keys indexed. Late key NOT yet.
    const afterTick1 = await readdir(indexRoot);
    expect(afterTick1).toHaveLength(
      tick1Page1.length + tick1Page2.length,
    );
    const lateReceiptId = lateKey.slice(lateKey.length - 64);
    expect(afterTick1).not.toContain(`${lateReceiptId}.txt`);

    // Drive tick 2. The indexer installs a setInterval(poll, 6000), but
    // under fake timers we invoke it explicitly instead. Calling
    // startReceiptIndexer() a second time re-reads indexer-state.json
    // from disk and proceeds from there — equivalent to the interval
    // firing, but deterministic. Advance the chain first so the poll
    // doesn't short-circuit on `bestBlock <= lastProcessedBlock`.
    harness.bestBlockHex = "0x65";
    harness.receiptCount += 1;
    await startReceiptIndexer();

    const afterTick2 = await readdir(indexRoot);
    expect(afterTick2).toHaveLength(
      tick1Page1.length + tick1Page2.length + 1,
    );
    expect(afterTick2).toContain(`${lateReceiptId}.txt`);

    // Sanity: tick 2's first paginator call had start_key=null. If a
    // regression persisted start_key across ticks we'd see a non-null here.
    const pagedCalls = harness.calls.filter(
      (c) => c.method === "state_getKeysPaged",
    );
    // Tick 1 issued 3 paged calls, so tick 2's first paged call is index 3.
    expect(pagedCalls[3].params).toEqual([RECEIPTS_PREFIX, PAGE_SIZE, null]);
  });

  test("test_stops_on_empty_response", async () => {
    // First (and only) response is []. Indexer must make exactly one
    // state_getKeysPaged call and no state_getStorage calls. If the loop
    // condition is wrong, we either infinite-loop (test times out) or
    // fire a spurious second call.
    const harness: FetchHarness = {
      calls: [],
      script: { pages: [[]] },
      bestBlockHex: "0x64",
      // receiptCount > 0 so the indexer enters the paginator branch at all.
      receiptCount: 7,
      values: new Map(),
    };
    vi.stubGlobal("fetch", makeHandler(harness));

    const { startReceiptIndexer } = await import("../receipt-indexer.js");
    await startReceiptIndexer();

    const pagedCalls = harness.calls.filter(
      (c) => c.method === "state_getKeysPaged",
    );
    expect(pagedCalls).toHaveLength(1);
    expect(
      harness.calls.filter((c) => c.method === "state_getStorage"),
    ).toHaveLength(0);
    const files = await readdir(indexRoot);
    expect(files).toHaveLength(0);
  });

  test("test_already_indexed_keys_are_skipped", async () => {
    // Three keys returned from pagination. The first two already have
    // index files on disk. The indexer must NOT issue state_getStorage for
    // those two, and MUST issue exactly one state_getStorage for the third.
    const keys = [makeKey(1, 0), makeKey(1, 1), makeKey(1, 2)];
    const receiptIds = keys.map((k) => k.slice(k.length - 64));

    // Pre-seed the first two as already-indexed.
    await writeFile(join(indexRoot, `${receiptIds[0]}.txt`), "deadbeef");
    await writeFile(join(indexRoot, `${receiptIds[1]}.txt`), "cafebabe");

    const values = new Map<string, string>();
    values.set(keys[2], makeReceiptValue("ff".repeat(32)));

    // Single page of 3 keys (< PAGE_SIZE) short-circuits the paginator
    // after one call, so no trailing empty-sentinel page is needed.
    const harness: FetchHarness = {
      calls: [],
      script: { pages: [keys] },
      bestBlockHex: "0x64",
      receiptCount: 3,
      values,
    };
    vi.stubGlobal("fetch", makeHandler(harness));

    const { startReceiptIndexer } = await import("../receipt-indexer.js");
    await startReceiptIndexer();

    const storageCalls = harness.calls.filter(
      (c) => c.method === "state_getStorage",
    );
    // Only the unindexed third key should have been read from storage.
    expect(storageCalls).toHaveLength(1);
    expect(storageCalls[0].params).toEqual([keys[2]]);

    const files = await readdir(indexRoot);
    expect(files).toHaveLength(3);
    expect(files).toContain(`${receiptIds[2]}.txt`);
    // And the pre-seeded entries were not clobbered.
    const { readFile } = await import("node:fs/promises");
    expect(
      await readFile(join(indexRoot, `${receiptIds[0]}.txt`), "utf-8"),
    ).toBe("deadbeef");
  });

  test("top_level_exports_preserved", async () => {
    // Guardrail from the task brief: we've hit nested-def bugs in this
    // repo twice (PR #2, PR #43). Assert the module's public surface is
    // exactly what callers import.
    const mod = await import("../receipt-indexer.js");
    expect(typeof mod.startReceiptIndexer).toBe("function");
    // `startReceiptIndexer` must be a top-level named export, not a
    // method hidden inside a nested namespace.
    expect(Object.prototype.hasOwnProperty.call(mod, "startReceiptIndexer"))
      .toBe(true);
  });
});
