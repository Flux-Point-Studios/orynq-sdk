import type { IndexedTransaction, MidnightSource } from "../source.js";

// A source's answers, recorded from the live network: replaying them lets a test run the
// production verifier against real chain data, and fail on any request that was not recorded.
export interface Recording {
  network: string;
  operator: string;
  indexer: Record<string, IndexedTransaction[]>;
  node: Record<string, unknown>;
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
