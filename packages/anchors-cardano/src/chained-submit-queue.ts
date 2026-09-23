/**
 * Serialized Cardano submission that chains each tx on the wallet UTxOs the
 * previous one left, instead of re-reading the wallet from an indexer.
 *
 * Indexers (Blockfrost, Kupo) report only block-confirmed UTxOs, including
 * ones a mempool tx has already spent. Concurrent builders therefore all pick
 * the same inputs and the node rejects every tx but the first ("All inputs are
 * spent"). The queue runs one build at a time, hands each build the UTxOs the
 * previous submission produced, and reads from the provider again only after
 * its last submission is on chain.
 *
 * Library-agnostic: `U` is whatever UTxO shape the caller's tx builder uses.
 */

/** A signed tx the queue has not submitted yet. */
export interface ChainedTx<U> {
  txHash: string;
  /** The wallet once this tx applies: its outputs to the wallet plus every UTxO it left unspent. */
  walletUtxos: U[];
  submit(): Promise<unknown>;
}

/**
 * Builds and signs one tx without submitting it. Given UTxOs, it must select
 * inputs only from them; given undefined, it reads the wallet from its provider.
 */
export type ChainedBuild<U> = (walletUtxos: U[] | undefined) => Promise<ChainedTx<U>>;

export interface ChainedSubmitQueueOptions {
  /** Txs built on one provider read before the queue waits for the tip to land and reads again. */
  maxChainLength: number;
  /** Chained UTxOs unused for this long are dropped in favour of a provider read. */
  cacheTtlMs: number;
  /** Distinct keys admitted but not yet settled; a new key beyond this is rejected with SubmitQueueFullError. */
  maxPending: number;
  /** How long a key seen on chain keeps returning its txHash instead of submitting again. */
  dedupeTtlMs: number;
  dedupeMaxEntries: number;
  /**
   * Resolves true once txHash is on chain, false once waiting longer is
   * pointless. Called before a provider read that follows unconfirmed
   * submissions, and after a submit that failed without saying whether the
   * node got the tx. A chain whose tip resolves false, or rejects, is
   * forgotten: its keys submit again instead of returning a tx that may never
   * land. A rejection also fails the submission that was waiting.
   */
  awaitConfirmation: (txHash: string) => Promise<boolean>;
  now?: () => number;
}

export interface ChainedSubmitResult {
  txHash: string;
  /** 1 for a tx built on a provider read, n for the nth tx of a chain. */
  chainPosition: number;
  /** True when the key was in flight, in the current chain, or seen on chain within dedupeTtlMs. */
  deduplicated: boolean;
}

export interface ChainedSubmitQueue<U> {
  submit(key: string, build: ChainedBuild<U>): Promise<ChainedSubmitResult>;
}

export class SubmitQueueFullError extends Error {
  constructor(readonly pending: number) {
    super(`submit queue is full: ${pending} submissions pending`);
    this.name = "SubmitQueueFullError";
  }
}

const SPENT_INPUT_PATTERNS = [
  /All inputs are spent/, // cardano-node Conway mempool rule, as relayed by Blockfrost
  /BadInputsUTxO/, // cardano-node ledger UTXO rule
  /unknownOutputReferences/, // Ogmios 3117
  /does not exist or was already spent/, // lucid-evolution Emulator
];

/** True when a submission failed because an input is already spent or unknown to the node. */
export function isSpentInputError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    if (SPENT_INPUT_PATTERNS.some((pattern) => pattern.test(message))) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

interface Anchored {
  txHash: string;
  chainPosition: number;
}

export function createChainedSubmitQueue<U>(
  options: ChainedSubmitQueueOptions
): ChainedSubmitQueue<U> {
  const now = options.now ?? Date.now;
  const inFlight = new Map<string, Promise<ChainedSubmitResult>>();
  const landed = new Map<string, Anchored & { at: number }>();
  let tail: Promise<unknown> = Promise.resolve();
  let chained: { utxos: U[]; at: number } | null = null;
  let chainLength = 0;
  /** Submitted since the last provider read; the tip spends every earlier tx's change. */
  let unconfirmed: { tip: string; keys: Map<string, Anchored> } | null = null;

  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    // The caller of `run` receives its rejection; the tail only orders the next task.
    tail = run.catch(() => undefined);
    return run;
  }

  function remember(keys: Map<string, Anchored>): void {
    for (const [key, anchored] of keys) {
      landed.delete(key);
      landed.set(key, { ...anchored, at: now() });
    }
    for (const oldest of landed.keys()) {
      if (landed.size <= options.dedupeMaxEntries) break;
      landed.delete(oldest);
    }
  }

  function recentlyLanded(key: string): Anchored | undefined {
    const recent = landed.get(key);
    if (recent === undefined) return undefined;
    if (now() - recent.at < options.dedupeTtlMs) return recent;
    landed.delete(key);
    return undefined;
  }

  const answer = ({ txHash, chainPosition }: Anchored, deduplicated: boolean) => ({
    txHash,
    chainPosition,
    deduplicated,
  });

  /** Ends the chain: waits for its tip and keeps its keys only if the tip landed. */
  async function settle(): Promise<void> {
    chained = null;
    chainLength = 0;
    const chain = unconfirmed;
    if (chain === null) return;
    unconfirmed = null;
    if (await options.awaitConfirmation(chain.tip)) remember(chain.keys);
  }

  async function submitNext(key: string, build: ChainedBuild<U>): Promise<ChainedSubmitResult> {
    const reusable =
      chained !== null &&
      now() - chained.at < options.cacheTtlMs &&
      chainLength < options.maxChainLength
        ? chained.utxos
        : undefined;
    if (reusable === undefined) await settle();

    const known = recentlyLanded(key) ?? unconfirmed?.keys.get(key);
    if (known !== undefined) return answer(known, true);

    const tx = await build(reusable);
    const anchored = { txHash: tx.txHash, chainPosition: chainLength + 1 };
    try {
      await tx.submit();
    } catch (error) {
      if (isSpentInputError(error)) {
        chained = null;
        chainLength = 0;
        throw error;
      }
      return confirmUnknownOutcome(key, anchored, error);
    }

    chainLength = anchored.chainPosition;
    chained = { utxos: tx.walletUtxos, at: now() };
    unconfirmed = {
      tip: tx.txHash,
      keys: (unconfirmed?.keys ?? new Map<string, Anchored>()).set(key, anchored),
    };
    return answer(anchored, false);
  }

  /**
   * A timeout, 5xx or unreadable reply can arrive after the node accepted the
   * tx. Building on the old UTxOs would then conflict with it, and forgetting
   * it would pay for a second anchor on the next re-post.
   */
  async function confirmUnknownOutcome(
    key: string,
    anchored: Anchored,
    error: unknown
  ): Promise<ChainedSubmitResult> {
    const before = unconfirmed;
    unconfirmed = null;
    chained = null;
    chainLength = 0;
    let confirmed = false;
    try {
      confirmed = await options.awaitConfirmation(anchored.txHash);
    } finally {
      if (!confirmed) unconfirmed = before;
    }
    if (!confirmed) throw error;
    // It spends the change of the chain before it, so that chain landed too.
    remember((before?.keys ?? new Map<string, Anchored>()).set(key, anchored));
    return answer(anchored, false);
  }

  return {
    submit(key, build) {
      const recent = recentlyLanded(key);
      if (recent !== undefined) return Promise.resolve(answer(recent, true));

      const pending = inFlight.get(key);
      if (pending !== undefined) {
        return pending.then((result) => ({ ...result, deduplicated: true }));
      }

      if (inFlight.size >= options.maxPending) {
        return Promise.reject(new SubmitQueueFullError(inFlight.size));
      }

      const run = exclusive(() => submitNext(key, build)).finally(() => inFlight.delete(key));
      inFlight.set(key, run);
      return run;
    },
  };
}
