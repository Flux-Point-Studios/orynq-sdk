/**
 * Storage observation for submissions whose transaction watch was lost: polling a pinned head
 * for the submission's record, and settling an inclusion-unknown outcome from finalized storage.
 */

import type { ApiPromise } from "@polkadot/api";
import type { MateriosProvider } from "./provider.js";
import type { InclusionResolution, PollOptions } from "./types.js";
import {
  MateriosConnectionError, MateriosSubmissionError,
  type ExpectedRecord, type ObservedHead, type SubmittedExtrinsic,
} from "./errors.js";
import { sleep, timeoutBudget, withinDeadline } from "./deadline.js";

/** Interval between head polls; storage is read once for each new head. */
export const POLL_MS = 1_000;
/** A read slower than this is treated as a stalled connection. */
const STALLED_READ_MS = 10_000;

type BlockApi = Awaited<ReturnType<ApiPromise["at"]>>;
export type RecordState = "absent" | "match" | "conflict";

const label = (kind: ExpectedRecord["kind"]) => kind === "receipt" ? "Receipt" : "Anchor";
const snakeCase = (name: string) => name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

/** Compares a stored record with the expected fields; any difference is a conflict. */
function classifyRecord(record: { isEmpty: boolean; toJSON(): unknown }, expected: ExpectedRecord): RecordState {
  if (record.isEmpty) return "absent";
  const stored = record.toJSON() as Record<string, unknown>;
  const matches = Object.entries(expected.fields).every(([name, value]) => {
    const actual = name in stored ? stored[name] : stored[snakeCase(name)];
    return (actual === null || actual === undefined ? null : String(actual).toLowerCase()) === value;
  });
  return matches ? "match" : "conflict";
}

export async function readRecord(at: ApiPromise | BlockApi, expected: ExpectedRecord, id: string): Promise<RecordState> {
  const storage = at.query.orinqReceipts![expected.kind === "receipt" ? "receipts" : "anchors"]!;
  return classifyRecord(await storage(id), expected);
}

export async function readHead(api: ApiPromise, finalized: boolean): Promise<ObservedHead> {
  const header = finalized
    ? await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead())
    : await api.rpc.chain.getHeader();
  return { number: header.number.toNumber(), hash: header.hash.toHex() };
}

export function conflictError(id: string, expected: ExpectedRecord, head: ObservedHead, extrinsic?: SubmittedExtrinsic) {
  return new MateriosSubmissionError("dispatch", id,
    `${label(expected.kind)} ${id} is stored with a different payload at block #${head.number} (${head.hash}); ` +
    "a submission under this id can never store this payload",
    { expected, extrinsic, lastHead: head });
}

export function inclusionUnknownMessage(
  expected: ExpectedRecord, id: string, extrinsic: SubmittedExtrinsic, reason: string,
  lastHead: ObservedHead | undefined, readFailure: unknown,
): string {
  const window = extrinsic.mortalityEnd === null ? "until its nonce is used" : `up to block #${extrinsic.mortalityEnd}`;
  const seen = lastHead ? `storage at block #${lastHead.number} (${lastHead.hash}) does not hold it` : "no storage read succeeded";
  const failed = readFailure instanceof Error ? `; the last storage read failed: ${readFailure.message}` : "";
  return `${label(expected.kind)} ${id} inclusion is unknown (${reason}): transaction ${extrinsic.txHash} ` +
    `(nonce ${extrinsic.nonce} from ${extrinsic.signer}) can still be included ${window}, and ${seen}${failed}. ` +
    "Settle it with resolveInclusion() before resubmitting; an absent record in one read does not mean it will not land.";
}

/**
 * One read, ended with `read-timeout` after STALLED_READ_MS or at `deadline` (`onStall` runs on
 * that timeout), or with `connect-aborted` when `signal` aborts.
 */
export function boundedRead<T>(read: () => Promise<T>, deadline: number, onStall?: () => void, signal?: AbortSignal): Promise<T> {
  const budgetMs = Math.min(deadline - Date.now(), STALLED_READ_MS);
  return withinDeadline(read, Date.now() + budgetMs, () => {
    onStall?.();
    return new MateriosConnectionError("read-timeout", budgetMs);
  }, signal);
}

export interface HeadPoll<T> {
  value?: T;
  /** The last head examined without a result. */
  lastHead?: ObservedHead;
  lastError?: unknown;
  /** `disconnect()` ended the poll before its deadline. */
  aborted?: true;
}

/** Why a poll that `disconnect()` ended has no result. */
export const POLL_ABORTED = "disconnect() ended the storage poll before its deadline";

/**
 * Calls `examine` once for each new head (best, or finalized when `finalized`), polling every
 * `intervalMs` through the provider's shared recovery reader, a connection isolated from the main
 * one and checked against `genesis`, until it returns a value, `deadline` passes or the provider
 * is disconnected. A failed or stalled read replaces the reader for every poll sharing it; a
 * MateriosSubmissionError from `examine` ends the poll. The reader is closed with its last poll.
 */
export async function pollHeads<T>(
  provider: MateriosProvider,
  genesis: string,
  deadline: number,
  intervalMs: number,
  finalized: boolean,
  examine: (at: BlockApi, head: ObservedHead) => Promise<T | undefined>,
  onPoll?: () => void,
): Promise<HeadPoll<T>> {
  const lease = provider.leaseReader(genesis);
  const { signal } = lease;
  const result: HeadPoll<T> = {};
  try {
    while (Date.now() < deadline && !signal.aborted) {
      onPoll?.();
      let reader: ApiPromise | undefined;
      try {
        const api = reader = await lease.api(deadline);
        const head = await boundedRead(() => readHead(api, finalized), deadline, undefined, signal);
        if (head.hash !== result.lastHead?.hash) {
          const value = await boundedRead(async () => examine(await api.at(head.hash), head), deadline, undefined, signal);
          if (value !== undefined) return { value, lastHead: head };
          result.lastHead = head;
        }
      } catch (error) {
        if (error instanceof MateriosSubmissionError) throw error;
        if (signal.aborted) break;
        result.lastError = error;
        if (reader) await lease.discard(reader);
      }
      await sleep(Math.min(intervalMs, deadline - Date.now()), signal);
    }
    if (signal.aborted) result.aborted = true;
    return result;
  } finally {
    await lease.release();
  }
}

/**
 * Settles an `inclusion-unknown` submission from finalized storage. Resolves `landed` once a
 * finalized block holds the matching record, and `not-landed` only once a finalized block without
 * it is past the extrinsic's mortality end, or shows its signer's nonce above the extrinsic's
 * nonce. A different payload stored under the id rejects with `dispatch`; no settlement by the
 * timeout, or before `disconnect()`, rejects with `inclusion-unknown` again.
 */
export async function resolveInclusion(
  provider: MateriosProvider,
  error: MateriosSubmissionError,
  opts: PollOptions = {},
): Promise<InclusionResolution> {
  const { id, expected, txHash, signer, nonce, mortalityEnd } = error;
  if (error.code !== "inclusion-unknown" || !expected || txHash === undefined || signer === undefined
    || nonce === undefined || mortalityEnd === undefined) {
    throw new TypeError("resolveInclusion() takes the inclusion-unknown MateriosSubmissionError from submitReceipt or submitAnchor");
  }
  const extrinsic: SubmittedExtrinsic = { txHash, signer, nonce, mortalityEnd };
  const timeoutMs = timeoutBudget(opts.timeoutMs ?? 600_000);
  const genesis = provider.getApi().genesisHash.toHex();
  const start = Date.now();
  let attempt = 0;
  const poll = await pollHeads<InclusionResolution>(provider, genesis, start + timeoutMs, opts.intervalMs ?? 6_000, true,
    async (at, head) => {
      const state = await readRecord(at, expected, id);
      const settled = { id, blockHash: head.hash, blockNumber: head.number };
      if (state === "match") return { status: "landed", ...settled };
      if (state === "conflict") throw conflictError(id, expected, head, extrinsic);
      if (mortalityEnd !== null && head.number >= mortalityEnd) return { status: "not-landed", reason: "expired", ...settled };
      const account = await at.query.system!.account!(signer) as unknown as { nonce: { toNumber(): number } };
      if (account.nonce.toNumber() > nonce) return { status: "not-landed", reason: "nonce-consumed", ...settled };
      return undefined;
    },
    () => opts.onPoll?.(++attempt, Date.now() - start));
  if (poll.value) return poll.value;
  const lastHead = poll.lastHead ?? error.lastHead;
  const reason = poll.aborted ? POLL_ABORTED : `finalized storage did not settle it within ${timeoutMs} ms`;
  throw new MateriosSubmissionError("inclusion-unknown", id,
    inclusionUnknownMessage(expected, id, extrinsic, reason, lastHead, poll.lastError),
    { expected, extrinsic, lastHead, cause: error.cause });
}
