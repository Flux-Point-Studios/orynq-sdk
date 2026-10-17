import { afterEach, expect, it, vi } from "vitest";
import { confirmedSends, landedRow, type FeeWallet, type PreparedBytes } from "../src/submission.js";
import type { AnchorKey, ChainView, Journal, JournalRow } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";

afterEach(() => vi.useRealTimers());

it("resumes retries after initially unknown chain time becomes known", async () => {
  vi.useFakeTimers();
  const key = { network: "mainnet" } as AnchorKey;
  let row = { state: "pending", txHash: "ab".repeat(32), broadcasts: 1, ttl: new Date(Date.now() + 600_000) } as JournalRow;
  const chain = { indexedThrough: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ time: new Date(), hash: "cd".repeat(32) }) } as unknown as ChainView;
  const retry = vi.fn(async () => {
    expect(await chain.indexedThrough()).not.toBeNull();
    row = { ...row, state: "landed", height: 100, blockHash: "cd".repeat(32) };
  });
  const journal = { reconcile: async () => [row], live: () => row, history: () => [row], rebroadcast: retry } as unknown as Journal;
  const prepared = { ...row, journal: { state: "pending", broadcasts: 1, expired: false } } as unknown as PreparedBytes;
  const pending = confirmedSends({ journal, chain, wallet: {} as FeeWallet, network: "mainnet", pollMillis: 3000, rebroadcastMillis: 60_000 }, key, "anchor", "anchor").submit(prepared);
  await vi.advanceTimersByTimeAsync(63_000);
  expect(retry).toHaveBeenCalledTimes(1);
  await expect(pending).resolves.toMatchObject({ state: "landed" });
});

it("retries at 60 seconds and stops when reconciliation proves inclusion", async () => {
  vi.useFakeTimers();
  const key = { network: "mainnet" } as AnchorKey;
  let row = { state: "pending", txHash: "ab".repeat(32) } as JournalRow;
  const retry = vi.fn(async () => undefined);
  const journal = { reconcile: async () => [row], history: () => [row], rebroadcast: retry } as unknown as Journal;
  const pending = landedRow({ journal, chain: {} as ChainView, wallet: {} as FeeWallet, network: "mainnet", pollMillis: 3000, rebroadcastMillis: 60_000 }, key, row);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(retry).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(retry).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(retry).toHaveBeenCalledTimes(2);
  row = { ...row, state: "landed", height: 100, blockHash: "cd".repeat(32) };
  await vi.advanceTimersByTimeAsync(3000);
  await expect(pending).resolves.toMatchObject({ state: "landed" });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(retry).toHaveBeenCalledTimes(2);
});
