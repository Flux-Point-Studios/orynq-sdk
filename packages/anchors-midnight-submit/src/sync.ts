import type { OperatorWallet, SyncProgress } from "./wallet.js";

export interface SyncWatch {
  // How long the wallet may take to sync.
  timeoutMs: number;
  // How often a line of progress is written, and how often the sync state is saved meanwhile.
  progressMs: number;
  checkpointMs: number;
  write(line: string): void;
}

const toTheSecond = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// How far each sub-wallet has applied the indexer's events, of how many it knows of, whether it
// reaches the indexer, and whether the wallet is synced: indices and flags, nothing else.
function progressLine({ shielded, unshielded, dust, synced }: SyncProgress): string {
  const part = (name: string, p: SyncProgress["dust"]) => `${name} applied ${p.applied} of ${p.highest}, ${p.connected ? "connected" : "not connected"}`;
  return `${part("shielded", shielded)}; ${part("unshielded", unshielded)}; ${part("dust", dust)}; ${synced ? "synced" : "not synced"}`;
}

// Waits until `wallet` has synced. It writes the wallet's progress as the wait starts, every
// `progressMs` and once synced, and saves the sync state every `checkpointMs`, once synced, and
// once more when the wait times out or fails, so a rerun resumes from the newest save instead of
// replaying every event from genesis.
export async function syncWithCheckpoints(wallet: OperatorWallet, { timeoutMs, progressMs, checkpointMs, write }: SyncWatch): Promise<void> {
  const started = Date.now();
  const report = async () => write(`wallet sync at ${toTheSecond(Date.now())}, ${Math.round((Date.now() - started) / 1000)} s in: ${progressLine(await wallet.progress())}`);
  const checkpoint = async () => {
    const { saved } = await wallet.saveState();
    if (saved) write(`wallet sync state saved at ${toTheSecond(Date.now())}; a rerun resumes from it`);
    return saved;
  };
  // Settles once the wait ends: null once synced, or why it failed.
  const ended = wallet.waitForSync(timeoutMs).then(
    () => null,
    (failure: unknown) => ({ failure }),
  );
  let timer: NodeJS.Timeout | undefined;
  const tick = () => new Promise<"tick">((resolve) => (timer = setTimeout(resolve, progressMs, "tick")));
  let outcome: { failure: unknown } | null;
  try {
    await report();
    let checkpointed = Date.now();
    for (;;) {
      const next = await Promise.race([ended, tick()]);
      clearTimeout(timer);
      if (next !== "tick") {
        outcome = next;
        break;
      }
      await report();
      if (Date.now() - checkpointed >= checkpointMs) {
        await checkpoint();
        checkpointed = Date.now();
      }
    }
  } catch (failure) {
    outcome = { failure };
  } finally {
    clearTimeout(timer);
  }
  if (outcome === null) {
    await report();
    await checkpoint();
    return;
  }
  const { failure } = outcome;
  const resumes = (await checkpoint()) ? "its sync state is saved, and a rerun resumes from it" : "its sync state was not saved, and a rerun resumes from the last good save";
  throw new Error(`${failure instanceof Error ? failure.message : String(failure)}; ${resumes}`, { cause: failure });
}
