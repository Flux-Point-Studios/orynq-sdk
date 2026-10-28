/**
 * One submission of a receipt or anchor extrinsic: sign, check storage, (dry-run,) broadcast and
 * watch, and when the watch is lost, reconcile from storage until the deadline.
 */

import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { MateriosProvider } from "./provider.js";
import type { TimeoutOptions } from "./types.js";
import { MateriosConnectionError, MateriosSubmissionError, type ExpectedRecord, type SubmittedExtrinsic } from "./errors.js";
import { timeoutBudget, withinDeadline } from "./deadline.js";
import { describeDispatch, watchSubmission, type DispatchFailure } from "./subscription.js";
import { POLL_MS, boundedRead, conflictError, inclusionUnknownMessage, pollHeads, readHead, readRecord } from "./inclusion.js";

type Signed = SubmittableExtrinsic<"promise">;

/** Where the submission's record was seen; `txHash` is present when this call broadcast it. */
export interface Observation {
  blockHash: string;
  blockNumber: number;
  txHash?: string;
  reconciled: boolean;
}

export interface Submission<T> {
  id: string;
  expected: ExpectedRecord;
  build(api: ApiPromise): Signed;
  result(observation: Observation): T;
}

const ALREADY_EXISTS = { receipt: "orinqReceipts.ReceiptAlreadyExists", anchor: "orinqReceipts.AnchorAlreadyExists" };

const asError = (value: unknown) => value instanceof Error ? value : new Error(String(value));

/** Last block number that can include an extrinsic with `era`, given a block number in its validity window. */
export function mortalityEnd(era: Signed["era"], reference: number): number | null {
  return era.isMortalEra ? era.asMortalEra.death(reference) - 1 : null;
}

/**
 * The dispatch failure a dry-run predicts. Validity is left to the pool: the dry-run applies on the
 * best block's own state, so when the runtime fills that block with mandatory weight it reports
 * `exhaustsResources` for a transaction the next block accepts.
 */
async function dryRunFailure(api: ApiPromise, signed: Signed): Promise<DispatchFailure | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let outcome: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outcome = await (api.rpc as any).system.dryRun(signed.toHex());
  } catch (error) {
    console.warn(`[materios-sdk] system.dryRun unavailable, skipping pre-flight check: ${asError(error).message}`);
    return undefined;
  }
  // ApplyExtrinsicResult = Result<Result<(), DispatchError>, TransactionValidityError>
  return !outcome.isErr && outcome.asOk.isErr ? describeDispatch(api, outcome.asOk.asErr) : undefined;
}

/**
 * Submission contract:
 * - `not-landed`: this call broadcast nothing, or the pool refused it (1010/1011/1014, whose
 *   message is kept verbatim); resubmit with the same id. The pool alone judges validity.
 * - `inclusion-unknown`: it may still land; settle it with `resolveInclusion`.
 * - `dispatch`: the runtime rejects it, or its id holds a different payload.
 * A stored record matching the payload is success (`reconciled: true`), whoever stored it.
 */
export async function submit<T>(provider: MateriosProvider, submission: Submission<T>, opts: TimeoutOptions): Promise<T> {
  const timeoutMs = timeoutBudget(opts.timeoutMs ?? provider.inclusionTimeoutMs);
  const deadline = Date.now() + timeoutMs;
  const watchDeadline = deadline - Math.min(30_000, timeoutMs / 2);
  const { id, expected } = submission;
  const label = expected.kind === "receipt" ? "Receipt" : "Anchor";
  const finalized = expected.kind === "anchor";
  let extrinsic: SubmittedExtrinsic | undefined;
  const notLanded = (message: string, cause?: unknown) =>
    new MateriosSubmissionError("not-landed", id, message, { expected, extrinsic, cause });

  let api: ApiPromise;
  try {
    api = await provider.connection(watchDeadline);
  } catch (cause) {
    if (!(cause instanceof MateriosConnectionError)) throw cause;
    throw notLanded(cause.message, cause);
  }
  const prepare = async <R>(step: string, run: () => Promise<R>): Promise<R> => {
    try {
      return await withinDeadline(run, watchDeadline, () => {
        provider.markUnresponsive(api);
        return notLanded(`${label} ${id} was not broadcast: ${step} did not finish before the preparation deadline`);
      });
    } catch (cause) {
      if (cause instanceof MateriosSubmissionError) throw cause;
      throw notLanded(asError(cause).message, cause);
    }
  };
  /** Polls storage until it holds the matching record, up to the total deadline; `conflict` ends it early. */
  const reconcile = (txHash?: string, conflict?: MateriosSubmissionError) => pollHeads(provider, api.genesisHash.toHex(), deadline, POLL_MS, finalized,
    async (at, head) => {
      const state = await readRecord(at, expected, id);
      if (state === "conflict" && conflict) throw conflict;
      return state === "match"
        ? submission.result({ blockHash: head.hash, blockNumber: head.number, ...(txHash ? { txHash } : {}), reconciled: true })
        : undefined;
    });
  /** The id is taken: success when it holds this payload, otherwise the dispatch failure stands. */
  const alreadyExists = async (failure: DispatchFailure, message: string, txHash?: string): Promise<T> => {
    const rejected = new MateriosSubmissionError("dispatch", id, message, { expected, extrinsic });
    if (failure.name !== ALREADY_EXISTS[expected.kind]) throw rejected;
    const { value } = await reconcile(txHash, rejected);
    if (value === undefined) throw rejected;
    return value;
  };

  const tx = submission.build(api);
  const keypair = provider.getKeypair();
  const signed = await prepare("signing", () => tx.signAsync(keypair, { nonce: -1 }));
  const best = await prepare("reading the best block", () => readHead(api, false));
  extrinsic = { txHash: signed.hash.toHex(), signer: keypair.address, nonce: signed.nonce.toNumber(), mortalityEnd: mortalityEnd(signed.era, best.number) };
  const head = finalized ? await prepare("reading the finalized block", () => readHead(api, true)) : best;
  const stored = await prepare("reading storage", async () => readRecord(await api.at(head.hash), expected, id));
  if (stored === "match") return submission.result({ blockHash: head.hash, blockNumber: head.number, reconciled: true });
  if (stored === "conflict") throw conflictError(id, expected, head, extrinsic);
  if (expected.kind === "receipt") {
    const failure = await prepare("the dry-run", () => dryRunFailure(api, signed));
    if (failure) {
      return alreadyExists(failure, `Receipt submission would fail at dispatch: ${failure.message}. ` +
        "This was caught by dry-run BEFORE broadcasting — no nonce was consumed.");
    }
  }
  if (Date.now() >= watchDeadline) throw notLanded(`${label} ${id} was not broadcast: the preparation deadline passed`);

  const outcome = await watchSubmission(api, callback => signed.send(callback), watchDeadline, finalized);
  let lost: Error;
  switch (outcome.status) {
    case "refused":
      throw notLanded(outcome.cause.message, outcome.cause);
    case "failed":
      return alreadyExists(outcome.failure, outcome.failure.message, extrinsic.txHash);
    case "included": {
      const observation = { blockHash: outcome.blockHash, blockNumber: outcome.blockNumber, txHash: extrinsic.txHash, reconciled: false };
      if (finalized) return submission.result(observation);
      try {
        const confirmed = await boundedRead(() => readRecord(api, expected, id), deadline, () => provider.markUnresponsive(api));
        if (confirmed === "match") return submission.result(observation);
        lost = new Error(`Included in block ${outcome.blockHash}, but best-block storage does not hold the matching record`);
      } catch (error) {
        lost = asError(error);
      }
      break;
    }
    case "lost":
      if (outcome.timedOut) provider.markUnresponsive(api);
      lost = outcome.cause;
      break;
  }

  const recovery = await reconcile(extrinsic.txHash);
  if (recovery.value !== undefined) return recovery.value;
  throw new MateriosSubmissionError("inclusion-unknown", id,
    inclusionUnknownMessage(expected, id, extrinsic, lost.message, recovery.lastHead, recovery.lastError),
    { expected, extrinsic, lastHead: recovery.lastHead, cause: lost });
}
