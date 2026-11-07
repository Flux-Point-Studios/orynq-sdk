import * as L8 from "@midnight-ntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";

export type Ledger = typeof L8 | typeof L9;

// Ledger 8 writes transaction[v9] and contract-state[v6]; ledger 9 writes transaction[v12] and
// contract-state[v8], and its network translated every contract state to [v8].
const LEDGERS_BY_TAG = {
  transaction: new Map<string, Ledger>([["midnight:transaction[v9]", L8], ["midnight:transaction[v12]", L9]]),
  "contract-state": new Map<string, Ledger>([["midnight:contract-state[v6]", L8], ["midnight:contract-state[v8]", L9]]),
};

// The header tag serialized bytes open with, through its version bracket, as printable text, and
// the ledger that reads `kind` bytes with that tag, if any.
export function taggedLedger(bytes: Uint8Array, kind: keyof typeof LEDGERS_BY_TAG): { tag: string; ledger: Ledger | undefined } {
  const head = Buffer.from(bytes.subarray(0, 64)).toString("latin1");
  const end = head.indexOf("]");
  const tag = (end < 0 ? head.slice(0, 32) : head.slice(0, end + 1)).replace(/[^\x20-\x7e]/g, "?");
  return { tag, ledger: LEDGERS_BY_TAG[kind].get(tag) };
}
