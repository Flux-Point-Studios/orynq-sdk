import { decodeAnchorTransaction, type AnchorCall, type AnchorTransaction } from "./anchor-transaction.js";
import { hash32, type Hash32 } from "./commitment.js";
import { knownAuthors as shippedKnownAuthors, type KnownAuthors } from "./known-authors.js";
import { MIDNIGHT_REGISTRIES, type MidnightNetwork, type RegistryInfo } from "./registries.js";
import { fromHex, toHex } from "./scale.js";
import type { IndexedAction, MidnightSource } from "./source.js";

export const MAX_FIND_WINDOW = 20_000;
export const DEFAULT_MAX_ACTIONS = 2_000;

// Where a search stopped: the last action it read, which a resumed search skips past.
export interface FindCursor {
  registry: string;
  height: number;
  transactionId: number;
  actionIndex: number;
}

// An anchor as the indexer delivered it, decoded from its transaction's own bytes. It is a
// candidate: verifyMidnightAnchor is what shows it is final and in a registry.
export interface FoundAnchor extends AnchorCall {
  txHash: string;
  transactionId: number;
  actionIndex: number;
  block: { height: number; hash: string };
}

export interface FindRequest {
  network: MidnightNetwork;
  source: MidnightSource;
  fromHeight: number;
  toHeight: number;
  // Author keys to return anchors from; the KNOWN_AUTHORS document's by default.
  authors?: readonly string[] | undefined;
  kinds?: readonly number[];
  commitment?: Hash32;
  cursor?: FindCursor | null;
  // The most actions one call reads, however many strangers anchor in the window.
  maxActions?: number;
  registries?: readonly RegistryInfo[];
  knownAuthors?: KnownAuthors;
  // How long the subscription may stay quiet before the search asks whether it is done, and
  // how long the whole search may wait on it.
  idleMillis?: number;
  deadlineMillis?: number;
}

export interface FindResult {
  anchors: FoundAnchor[];
  // Calls to a registry that are not anchors, and the reason.
  rejected: Array<{ txHash: string; height: number; reason: string }>;
  scannedActions: number;
  complete: boolean;
  nextCursor: FindCursor | null;
}

const after = (a: Omit<FindCursor, "registry">, b: Omit<FindCursor, "registry">) =>
  a.height !== b.height ? a.height > b.height : a.transactionId !== b.transactionId ? a.transactionId > b.transactionId : a.actionIndex > b.actionIndex;

// The registry anchors written in blocks fromHeight to toHeight (at most MAX_FIND_WINDOW apart,
// and no higher than the indexer's head) by the given authors. It reads the indexer's
// contractActions subscription for each registry generation and stops at the first action
// past the window, after maxActions actions (returning a cursor to resume from), or when the
// subscription has delivered the newest action the indexer knows. Nothing here trusts the
// indexer's account of an action: each is decoded from its transaction's bytes.
export async function findMidnightAnchors(request: FindRequest): Promise<FindResult> {
  const { network, source, fromHeight, toHeight } = request;
  if (!Number.isSafeInteger(fromHeight) || !Number.isSafeInteger(toHeight) || fromHeight < 0 || toHeight < fromHeight || toHeight - fromHeight > MAX_FIND_WINDOW) {
    throw new Error(`a search covers fromHeight to toHeight, at most ${MAX_FIND_WINDOW} blocks apart; got ${fromHeight} to ${toHeight}`);
  }
  const registries = [...(request.registries ?? MIDNIGHT_REGISTRIES[network])].sort((a, b) => a.generation - b.generation);
  if (registries.length === 0) throw new Error(`no registry generation is deployed on ${network}`);
  const authors = new Set((request.authors ?? (request.knownAuthors ?? shippedKnownAuthors()).authors(network).map((a) => a.key)).map((k) => toHex(hash32(k, "author"))));
  if (authors.size === 0) throw new Error("no author to filter by: pass authors, or a KNOWN_AUTHORS document that lists some");
  const commitment = request.commitment === undefined ? null : toHex(hash32(request.commitment, "commitment"));
  const maxActions = request.maxActions ?? DEFAULT_MAX_ACTIONS;
  const idleMillis = request.idleMillis ?? 5_000;
  const deadline = Date.now() + (request.deadlineMillis ?? 120_000);
  const head = await source.indexer.head();
  if (toHeight > head.height) throw new Error(`toHeight ${toHeight} is above the indexer's head ${head.height}`);

  const result: FindResult = { anchors: [], rejected: [], scannedActions: 0, complete: false, nextCursor: null };
  const cursorAt = request.cursor ? registries.findIndex((r) => r.address === request.cursor!.registry) : 0;
  if (cursorAt < 0) throw new Error(`the cursor names registry ${request.cursor!.registry}, which is no generation on ${network}`);

  for (const registry of registries.slice(cursorAt)) {
    const resume = request.cursor?.registry === registry.address ? request.cursor : null;
    const start = resume?.height ?? fromHeight;
    const newestAtStart = await source.indexer.latestAction(registry.address);
    if (!newestAtStart || newestAtStart.height < start) continue;
    const stream = source.indexer.contractActions(registry.address, start);
    const decoded = new Map<string, AnchorTransaction | Error>();
    const deliveries = new Map<number, number>();
    let last: Omit<FindCursor, "registry"> | null = resume;
    let pending: Promise<IteratorResult<IndexedAction>> | null = null;
    const stopAt = () => {
      result.nextCursor = last ? { registry: registry.address, ...last } : null;
      return result;
    };
    try {
      for (;;) {
        pending ??= stream.next();
        const wait = Math.min(idleMillis, deadline - Date.now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        const next = await Promise.race([pending, new Promise<"idle">((resolve) => (timer = setTimeout(() => resolve("idle"), Math.max(wait, 0))))]);
        clearTimeout(timer);
        if (next === "idle" || next.done) {
          if (next !== "idle") pending = null;
          const newest = await source.indexer.latestAction(registry.address);
          const caughtUp = !newest || (last !== null && !after({ ...newest, actionIndex: 0 }, { ...last, actionIndex: 0 }));
          if (caughtUp) break;
          if (next !== "idle" || Date.now() >= deadline) return stopAt();
          continue;
        }
        pending = null;
        const action = next.value;
        if (action.block.height > toHeight) break;
        const actionIndex = deliveries.get(action.transactionId) ?? 0;
        deliveries.set(action.transactionId, actionIndex + 1);
        const position = { height: action.block.height, transactionId: action.transactionId, actionIndex };
        if (resume && !after(position, resume)) continue;
        if (result.scannedActions === maxActions) return stopAt();
        result.scannedActions++;
        last = position;
        if (action.txHash === registry.deployTxHash) continue;
        let tx = decoded.get(action.txHash);
        if (!tx) {
          try {
            tx = decodeAnchorTransaction(fromHex(action.raw, "raw transaction"), [registry.address]);
            if (tx.txHash !== action.txHash) throw new Error(`the indexer's bytes hash to ${tx.txHash}, not ${action.txHash}`);
          } catch (error) {
            tx = error as Error;
            result.rejected.push({ txHash: action.txHash, height: action.block.height, reason: tx.message });
          }
          decoded.set(action.txHash, tx);
        }
        if (tx instanceof Error) continue;
        const call = tx.calls[actionIndex];
        if (!call) {
          result.rejected.push({ txHash: action.txHash, height: action.block.height, reason: `action ${actionIndex} of the transaction is not an anchor call` });
          continue;
        }
        if (!authors.has(call.author) || (request.kinds && !request.kinds.includes(call.kind)) || (commitment !== null && call.commitment !== commitment)) continue;
        result.anchors.push({ ...call, txHash: action.txHash, transactionId: action.transactionId, actionIndex, block: action.block });
      }
    } finally {
      await stream.return?.();
    }
  }
  result.complete = true;
  return result;
}
