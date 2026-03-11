// packages/orynq-mcp/src/store.ts
// In-memory trace store for the orynq-mcp server.
// Holds TraceEntry objects keyed by trace run ID, allowing tools
// to create, retrieve, and manage trace lifecycle state.
// Used by tool handlers registered in tools/index.ts.

import type {
  TraceRun,
  TraceBundle,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import type {
  AnchorEntry,
  AnchorTxResult,
} from "@fluxpointstudios/orynq-sdk-anchors-cardano";

export interface TraceEntry {
  run: TraceRun;
  bundle?: TraceBundle;
  preparedAnchor?: AnchorTxResult;
  anchorEntry?: AnchorEntry;
  cardanoTxHash?: string;
}

export interface TraceStore {
  get(id: string): TraceEntry | undefined;
  set(id: string, entry: TraceEntry): void;
  has(id: string): boolean;
  delete(id: string): boolean;
  list(): string[];
}

export function createTraceStore(): TraceStore {
  const traces = new Map<string, TraceEntry>();

  return {
    get: (id) => traces.get(id),
    set: (id, entry) => {
      traces.set(id, entry);
    },
    has: (id) => traces.has(id),
    delete: (id) => traces.delete(id),
    list: () => [...traces.keys()],
  };
}
