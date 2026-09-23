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

export interface ChainedSubmission<U> {
  txHash: string;
  /** The wallet once this tx applies: its outputs to the wallet plus every UTxO it left unspent. */
  walletUtxos: U[];
}

/**
 * Builds, signs and submits one tx. Given UTxOs, it must select inputs only
 * from them; given undefined, it reads the wallet from its provider.
 */
export type ChainedBuild<U> = (walletUtxos: U[] | undefined) => Promise<ChainedSubmission<U>>;

export interface ChainedSubmitQueueOptions {
  /** Txs built on one provider read before the queue waits for the tip to land and reads again. */
  maxChainLength: number;
  /** Chained UTxOs unused for this long are dropped in favour of a provider read. */
  cacheTtlMs: number;
  /** Distinct keys admitted but not yet settled; a new key beyond this is rejected with SubmitQueueFullError. */
  maxPending: number;
  /** How long a landed key keeps returning its txHash instead of submitting again. */
  dedupeTtlMs: number;
  dedupeMaxEntries: number;
  /**
   * Called before a provider read that follows a submission not yet seen on
   * chain. Resolve once txHash is on chain or once waiting longer is
   * pointless; a rejection fails the submission that was waiting, and that tip
   * is not waited on again.
   */
  awaitConfirmation: (txHash: string) => Promise<void>;
  now?: () => number;
}

export interface ChainedSubmitResult {
  txHash: string;
  /** 1 for a tx built on a provider read, n for the nth tx of a chain. */
  chainPosition: number;
  /** True when the key was already in flight or landed within dedupeTtlMs. */
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

interface Landed {
  txHash: string;
  chainPosition: number;
}

export function createChainedSubmitQueue<U>(
  options: ChainedSubmitQueueOptions
): ChainedSubmitQueue<U> {
  const now = options.now ?? Date.now;
  const inFlight = new Map<string, Promise<Landed>>();
  const landed = new Map<string, Landed & { at: number }>();
  let tail: Promise<unknown> = Promise.resolve();
  let chained: { utxos: U[]; at: number } | null = null;
  let chainLength = 0;
  let unconfirmedTip: string | null = null;

  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    // The caller of `run` receives its rejection; the tail only orders the next task.
    tail = run.catch(() => undefined);
    return run;
  }

  async function submitNext(build: ChainedBuild<U>): Promise<Landed> {
    const reusable =
      chained !== null &&
      now() - chained.at < options.cacheTtlMs &&
      chainLength < options.maxChainLength
        ? chained.utxos
        : undefined;

    if (reusable === undefined) {
      chained = null;
      chainLength = 0;
      if (unconfirmedTip !== null) {
        const tip = unconfirmedTip;
        unconfirmedTip = null;
        await options.awaitConfirmation(tip);
      }
    }

    let submission: ChainedSubmission<U>;
    try {
      submission = await build(reusable);
    } catch (error) {
      if (isSpentInputError(error)) {
        chained = null;
        chainLength = 0;
      }
      throw error;
    }

    chainLength += 1;
    chained = { utxos: submission.walletUtxos, at: now() };
    unconfirmedTip = submission.txHash;
    return { txHash: submission.txHash, chainPosition: chainLength };
  }

  function remember(key: string, result: Landed): void {
    landed.delete(key);
    landed.set(key, { ...result, at: now() });
    for (const oldest of landed.keys()) {
      if (landed.size <= options.dedupeMaxEntries) break;
      landed.delete(oldest);
    }
  }

  return {
    submit(key, build) {
      const recent = landed.get(key);
      if (recent !== undefined) {
        if (now() - recent.at < options.dedupeTtlMs) {
          return Promise.resolve({
            txHash: recent.txHash,
            chainPosition: recent.chainPosition,
            deduplicated: true,
          });
        }
        landed.delete(key);
      }

      const pending = inFlight.get(key);
      if (pending !== undefined) {
        return pending.then((result) => ({ ...result, deduplicated: true }));
      }

      if (inFlight.size >= options.maxPending) {
        return Promise.reject(new SubmitQueueFullError(inFlight.size));
      }

      const run = exclusive(() => submitNext(build)).then(
        (result) => {
          inFlight.delete(key);
          remember(key, result);
          return result;
        },
        (error: unknown) => {
          inFlight.delete(key);
          throw error;
        }
      );
      inFlight.set(key, run);
      return run.then((result) => ({ ...result, deduplicated: false }));
    },
  };
}
