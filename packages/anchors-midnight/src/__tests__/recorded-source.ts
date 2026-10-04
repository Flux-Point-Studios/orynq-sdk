import type { IndexedAction, IndexedTransaction, MidnightSource } from "../source.js";

// A source's answers, recorded from the live network: replaying them lets a test run the
// production verifier against real chain data, and fail on any request that was not recorded.
export interface Recording {
  network: string;
  operator: string;
  indexer: Record<string, IndexedTransaction[]>;
  node: Record<string, unknown>;
  head?: { height: number; hash: string; timestamp: number };
  latestActions?: Record<string, { height: number; transactionId: number } | null>;
  // The actions each subscription delivered before the consumer stopped, keyed address@height,
  // one list per subscription in the order they were opened.
  subscriptions?: Record<string, IndexedAction[][]>;
}

async function* replayed(actions: IndexedAction[]) {
  yield* actions;
}

const key = (method: string, params: unknown[]) => `${method}${JSON.stringify(params)}`;

export function recordingSource(source: MidnightSource, network: string): { source: MidnightSource; recording: Recording } {
  const recording: Recording = { network, operator: source.operator, indexer: {}, node: {} };
  return {
    recording,
    source: {
      operator: source.operator,
      indexer: {
        async transactions(hash) {
          return (recording.indexer[hash] = await source.indexer.transactions(hash));
        },
        async head() {
          return (recording.head = await source.indexer.head());
        },
        async latestAction(address) {
          return ((recording.latestActions ??= {})[address] = await source.indexer.latestAction(address));
        },
        contractActions(address, fromHeight) {
          const delivered: IndexedAction[] = [];
          ((recording.subscriptions ??= {})[`${address}@${fromHeight}`] ??= []).push(delivered);
          const live = source.indexer.contractActions(address, fromHeight);
          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              const r = await live.next();
              if (!r.done) delivered.push(r.value);
              return r;
            },
            return: () => live.return!(),
          };
        },
      },
      node: {
        async call<T>(method: string, params: unknown[] = []) {
          return (recording.node[key(method, params)] = await source.node.call<T>(method, params)) as T;
        },
        async batch<T>(calls: Array<[string, unknown[]]>) {
          const out = await source.node.batch<T>(calls);
          calls.forEach(([method, params], i) => (recording.node[key(method, params)] = out[i]));
          return out;
        },
      },
    },
  };
}

export function replaySource(recording: Recording, edit: (method: string, params: unknown[], answer: unknown) => unknown = (_, __, a) => a): MidnightSource {
  const subscriptionsOpened = new Map<string, number>();
  const lookup = (method: string, params: unknown[]) => {
    const k = key(method, params);
    if (!(k in recording.node)) throw new Error(`${recording.operator} node: ${k} was not recorded`);
    return edit(method, params, recording.node[k]);
  };
  return {
    operator: recording.operator,
    indexer: {
      async transactions(hash) {
        if (!(hash in recording.indexer)) throw new Error(`${recording.operator} indexer: transaction ${hash} was not recorded`);
        return edit("indexer.transactions", [hash], recording.indexer[hash]) as IndexedTransaction[];
      },
      async head() {
        if (!recording.head) throw new Error(`${recording.operator} indexer: the head was not recorded`);
        return recording.head;
      },
      async latestAction(address) {
        if (!recording.latestActions || !(address in recording.latestActions)) throw new Error(`${recording.operator} indexer: the latest action of ${address} was not recorded`);
        return recording.latestActions[address]!;
      },
      contractActions(address, fromHeight) {
        const key = `${address}@${fromHeight}`;
        const opened = (subscriptionsOpened.get(key) ?? 0) + 1;
        subscriptionsOpened.set(key, opened);
        const actions = recording.subscriptions?.[key]?.[opened - 1];
        if (!actions) throw new Error(`${recording.operator} indexer: subscription ${opened} to ${address} from ${fromHeight} was not recorded`);
        return replayed(actions);
      },
    },
    node: {
      async call<T>(method: string, params: unknown[] = []) {
        return lookup(method, params) as T;
      },
      async batch<T>(calls: Array<[string, unknown[]]>) {
        return calls.map(([method, params]) => lookup(method, params) as T);
      },
    },
  };
}
