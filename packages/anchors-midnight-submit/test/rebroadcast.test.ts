import { afterEach, expect, it, vi } from "vitest";
import { landedRow, type FeeWallet } from "../src/submission.js";
import type { AnchorKey, ChainView, Journal, JournalRow } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";

afterEach(() => vi.useRealTimers());

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
