import { afterEach, describe, expect, it, vi } from "vitest";
import { anchorSummary, deploySummary } from "../src/preflight.js";
import { syncWithCheckpoints } from "../src/sync.js";
import type { OperatorWallet, StateSave, SyncProgress } from "../src/wallet.js";
import type { PreparedAnchor } from "../src/operator.js";
import type { PreparedDeploy } from "../src/deployer.js";

afterEach(() => void vi.useRealTimers());

const MINUTE = 60_000;
const HOURS_3 = 3 * 60 * MINUTE;
const START = "2026-10-20T14:00:00Z";
const SAVED = { saved: true } as const;
const NOT_SAVED: StateSave = { saved: false, failures: [{ part: "shielded", error: "ParseError: Could not serialize local state: RuntimeError: unreachable" }] };

const part = (applied: bigint, highest: bigint, connected: boolean) => ({ applied, highest, connected });
const RESTORED: SyncProgress = { shielded: part(812n, 0n, false), unshielded: part(40n, 40n, false), dust: part(905n, 0n, false), synced: false };
const HALFWAY: SyncProgress = { shielded: part(5_000n, 9_000n, true), unshielded: part(41n, 41n, true), dust: part(4_800n, 9_100n, true), synced: false };
const SYNCED: SyncProgress = { shielded: part(9_000n, 9_000n, true), unshielded: part(41n, 41n, true), dust: part(9_100n, 9_100n, true), synced: true };

// A wallet whose sync the test steps: it reports `progress`, saves with the outcomes `saves` lists
// (then successfully), and its wait for the sync ends when the test says.
function syncingWallet(saves: StateSave[] = []) {
  let progress: SyncProgress | Error = RESTORED;
  let wait!: { resolve(): void; reject(error: Error): void };
  const waits: number[] = [];
  const saveState = vi.fn(async () => saves.shift() ?? SAVED);
  const wallet = {
    waitForSync: (timeoutMs: number) => {
      waits.push(timeoutMs);
      return new Promise<void>((resolve, reject) => {
        wait = { resolve, reject };
      });
    },
    progress: async () => {
      if (progress instanceof Error) throw progress;
      return progress;
    },
    saveState,
  } as unknown as OperatorWallet;
  return {
    wallet,
    waits,
    saveState,
    report: (next: SyncProgress | Error) => {
      progress = next;
    },
    synced: () => wait.resolve(),
    fail: (error: Error) => wait.reject(error),
  };
}

// Starts the wait at START under fake timers, every line it writes kept in `lines`.
function watch(w: ReturnType<typeof syncingWallet>) {
  vi.useFakeTimers({ now: new Date(START) });
  const lines: string[] = [];
  const done = syncWithCheckpoints(w.wallet, { timeoutMs: HOURS_3, progressMs: MINUTE, checkpointMs: 5 * MINUTE, write: (line) => lines.push(line) });
  done.catch(() => undefined);
  return { lines, done };
}

const RESTORED_LINE = "shielded applied 812 of 0, not connected; unshielded applied 40 of 40, not connected; dust applied 905 of 0, not connected; not synced";
const HALFWAY_LINE = "shielded applied 5000 of 9000, connected; unshielded applied 41 of 41, connected; dust applied 4800 of 9100, connected; not synced";
const SYNCED_LINE = "shielded applied 9000 of 9000, connected; unshielded applied 41 of 41, connected; dust applied 9100 of 9100, connected; synced";

describe("syncWithCheckpoints", () => {
  it("writes the wallet's progress as the wait starts and every minute, and saves its sync state every five minutes", async () => {
    const w = syncingWallet();
    const { lines } = watch(w);
    await vi.advanceTimersByTimeAsync(0);
    expect(lines).toEqual([`wallet sync at ${START}, 0 s in: ${RESTORED_LINE}`]);
    w.report(HALFWAY);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(w.saveState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(w.saveState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(w.saveState).toHaveBeenCalledTimes(2);
    expect(lines).toEqual([
      `wallet sync at ${START}, 0 s in: ${RESTORED_LINE}`,
      `wallet sync at 2026-10-20T14:01:00Z, 60 s in: ${HALFWAY_LINE}`,
      `wallet sync at 2026-10-20T14:02:00Z, 120 s in: ${HALFWAY_LINE}`,
      `wallet sync at 2026-10-20T14:03:00Z, 180 s in: ${HALFWAY_LINE}`,
      `wallet sync at 2026-10-20T14:04:00Z, 240 s in: ${HALFWAY_LINE}`,
      `wallet sync at 2026-10-20T14:05:00Z, 300 s in: ${HALFWAY_LINE}`,
      "wallet sync state saved at 2026-10-20T14:05:00Z; a rerun resumes from it",
      `wallet sync at 2026-10-20T14:06:00Z, 360 s in: ${HALFWAY_LINE}`,
      `wallet sync at 2026-10-20T14:07:00Z, 420 s in: ${HALFWAY_LINE}`,
      `wallet sync at 2026-10-20T14:08:00Z, 480 s in: ${HALFWAY_LINE}`,
      `wallet sync at 2026-10-20T14:09:00Z, 540 s in: ${HALFWAY_LINE}`,
      `wallet sync at 2026-10-20T14:10:00Z, 600 s in: ${HALFWAY_LINE}`,
      "wallet sync state saved at 2026-10-20T14:10:00Z; a rerun resumes from it",
    ]);
    expect(w.waits).toEqual([HOURS_3]);
  });

  // Reading a large DUST state back takes the event loop for tens of seconds.
  it("spaces its saves so that saving takes at most a tenth of the wait", async () => {
    const w = syncingWallet();
    w.saveState.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, MINUTE, SAVED)));
    const { lines } = watch(w);
    await vi.advanceTimersByTimeAsync(15 * MINUTE - 1);
    expect(w.saveState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.saveState).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(lines.filter((line) => line.startsWith("wallet sync state saved"))).toEqual([
      "wallet sync state saved at 2026-10-20T14:06:00Z; a rerun resumes from it",
      "wallet sync state saved at 2026-10-20T14:16:00Z; a rerun resumes from it",
    ]);
  });

  it("once synced, writes the synced progress and saves the synced state, then stops writing", async () => {
    const w = syncingWallet();
    const { lines, done } = watch(w);
    await vi.advanceTimersByTimeAsync(90_000);
    w.report(SYNCED);
    w.synced();
    await expect(done).resolves.toBeUndefined();
    expect(lines.slice(-2)).toEqual([`wallet sync at 2026-10-20T14:01:30Z, 90 s in: ${SYNCED_LINE}`, "wallet sync state saved at 2026-10-20T14:01:30Z; a rerun resumes from it"]);
    expect(w.saveState).toHaveBeenCalledTimes(1);
    const written = lines.length;
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect([lines.length, w.saveState.mock.calls.length]).toEqual([written, 1]);
  });

  it("goes on waiting when a checkpoint fails, which the save itself reports", async () => {
    const w = syncingWallet([NOT_SAVED]);
    const { lines, done } = watch(w);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(w.saveState).toHaveBeenCalledTimes(1);
    expect(lines.filter((line) => line.startsWith("wallet sync state saved"))).toEqual([]);
    w.report(SYNCED);
    w.synced();
    await expect(done).resolves.toBeUndefined();
    expect(w.saveState).toHaveBeenCalledTimes(2);
  });

  it("when the wait times out, saves once more and fails saying a rerun resumes from that save", async () => {
    const w = syncingWallet();
    const { lines, done } = watch(w);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    w.fail(new Error("the mainnet wallet did not sync within 10800 s"));
    await expect(done).rejects.toThrow(/^the mainnet wallet did not sync within 10800 s; its sync state is saved, and a rerun resumes from it$/);
    expect(w.saveState).toHaveBeenCalledTimes(1);
    expect(lines.at(-1)).toBe("wallet sync state saved at 2026-10-20T14:02:00Z; a rerun resumes from it");
  });

  it("when the wait fails and that save fails too, says a rerun resumes from the last good save", async () => {
    const w = syncingWallet([NOT_SAVED]);
    const { done } = watch(w);
    await vi.advanceTimersByTimeAsync(0);
    w.fail(new Error("the mainnet wallet did not sync within 10800 s"));
    await expect(done).rejects.toThrow(/^the mainnet wallet did not sync within 10800 s; its sync state was not saved, and a rerun resumes from the last good save$/);
    expect(w.saveState).toHaveBeenCalledTimes(1);
  });

  it("when the wallet's progress cannot be read, saves and fails with that", async () => {
    const w = syncingWallet();
    const { done } = watch(w);
    await vi.advanceTimersByTimeAsync(0);
    w.report(new Error("the facade stopped"));
    await vi.advanceTimersByTimeAsync(MINUTE);
    await expect(done).rejects.toThrow(/^the facade stopped; its sync state is saved, and a rerun resumes from it$/);
    expect(w.saveState).toHaveBeenCalledTimes(1);
  });

  // The wrappers deci runs the mainnet scripts through find each summary row as the last line
  // starting with its label, and the token in the prompt.
  it("writes no line that reads as a row of a deploy or anchor summary, or as a confirmation prompt", async () => {
    const lines: string[] = [];
    for (const [saves, end] of [
      [[], (w: ReturnType<typeof syncingWallet>) => (w.report(SYNCED), w.synced())],
      [[], (w: ReturnType<typeof syncingWallet>) => w.fail(new Error("the mainnet wallet did not sync within 10800 s"))],
      [[NOT_SAVED], (w: ReturnType<typeof syncingWallet>) => w.fail(new Error("the mainnet wallet did not sync within 10800 s"))],
    ] as const) {
      const w = syncingWallet([...saves]);
      const run = watch(w);
      w.report(HALFWAY);
      await vi.advanceTimersByTimeAsync(6 * MINUTE);
      end(w);
      await run.done.catch((error: Error) => run.lines.push(error.message));
      lines.push(...run.lines);
      vi.useRealTimers();
    }
    const prepared = { network: "mainnet", txHash: "ab".repeat(32), bytes: new Uint8Array(1), ttl: new Date(0), declaredFee: 1n, payer: "mn_addr1payer", journal: { state: "pending", broadcasts: 1, expired: false } };
    const deploy = { ...prepared, address: "cd".repeat(32), runtime: 1000300, authority: { committee: 0, threshold: 1, counter: "0" }, verifierKeys: { anchor: "ef".repeat(32), anchor_hiding: "01".repeat(32) } } as PreparedDeploy;
    const facts = { chain: { chain: "Midnight Mainnet", genesis: "00".repeat(32), specVersion: 1000300, ledgerVersion: "8.1.1" }, wallet: { dust: "mn_dust1wallet" }, dust: 1n };
    const entry = { rootHash: "11".repeat(32), manifestHash: "22".repeat(32), merkleRoot: "33".repeat(32) };
    const anchors = ([1, 2] as const).map((kind) => anchorSummary({ ...facts, label: "proof-run-1", entry, prepared: { ...prepared, kind, registry: "cd".repeat(32), author: "44".repeat(32), commitment: "55".repeat(32), attribute: "66".repeat(32) } as PreparedAnchor }));
    const labels = new Set([deploySummary({ ...facts, prepared: deploy }), ...anchors].flatMap((summary) => summary.split("\n").map((row) => row.split(/ {2,}/)[0]!)));
    expect(labels).toContain("deploy tx hash");
    expect(labels).toContain("anchor_hiding");
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      expect([...labels].filter((label) => line.startsWith(label))).toEqual([]);
      expect(line).not.toMatch(/Type exactly/);
    }
  });
});
