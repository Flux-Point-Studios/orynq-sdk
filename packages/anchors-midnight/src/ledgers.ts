import * as L8 from "@midnight-ntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";

export type Ledger = typeof L8 | typeof L9;
export type AnyTransaction = L8.Transaction<L8.Signaturish, L8.Proofish, L8.Bindingish> | L9.Transaction<L9.Signaturish, L9.Proofish, L9.Bindingish>;
export type FinalTransaction = L8.FinalizedTransaction | L9.FinalizedTransaction;

// Ledger 8 writes transaction[v9], contract-state[v6] and ledger-parameters[v5]; ledger 9 writes
// transaction[v12], contract-state[v8] and ledger-parameters[v8], and its network translated
// every contract state to [v8].
const LEDGERS_BY_TAG = {
  transaction: new Map<string, Ledger>([["midnight:transaction[v9]", L8], ["midnight:transaction[v12]", L9]]),
  "contract-state": new Map<string, Ledger>([["midnight:contract-state[v6]", L8], ["midnight:contract-state[v8]", L9]]),
  "ledger-parameters": new Map<string, Ledger>([["midnight:ledger-parameters[v5]", L8], ["midnight:ledger-parameters[v8]", L9]]),
};

// The ledger each runtime the decoder knows executes: neither ledger reads the other's
// transactions, so a block carries only transactions of its runtime's ledger.
const RUNTIME_LEDGERS = new Map<number, Ledger>([[1000300, L8], [2001100, L9]]);

// The header tag serialized bytes open with, through its version bracket, as printable text, and
// the ledger that reads `kind` bytes with that tag, if any.
export function taggedLedger(bytes: Uint8Array, kind: keyof typeof LEDGERS_BY_TAG): { tag: string; ledger: Ledger | undefined } {
  const head = Buffer.from(bytes.subarray(0, 64)).toString("latin1");
  const end = head.indexOf("]");
  const tag = (end < 0 ? head.slice(0, 32) : head.slice(0, end + 1)).replace(/[^\x20-\x7e]/g, "?");
  return { tag, ledger: LEDGERS_BY_TAG[kind].get(tag) };
}

export function runtimeLedger(specVersion: number): Ledger {
  const ledger = RUNTIME_LEDGERS.get(specVersion);
  if (!ledger) throw new Error(`runtime ${specVersion} executes no ledger this decoder knows`);
  return ledger;
}

// A proven, bound transaction, read with the ledger its header tag names.
export function decodeTransaction(bytes: Uint8Array): { tx: FinalTransaction; ledger: Ledger } {
  const { tag, ledger } = taggedLedger(bytes, "transaction");
  if (!ledger) throw new Error(`transaction header ${tag} is not one this decoder knows`);
  try {
    const tx: FinalTransaction = ledger === L9
      ? L9.Transaction.deserialize<L9.SignatureEnabled, L9.Proof, L9.Binding>("signature", "proof", "binding", bytes)
      : L8.Transaction.deserialize<L8.SignatureEnabled, L8.Proof, L8.Binding>("signature", "proof", "binding", bytes);
    return { tx, ledger };
  } catch (error) {
    throw new Error(`the bytes are not a Midnight transaction: ${(error as Error).message}`);
  }
}

// Refuses a transaction whose ledger is not the one `specVersion` executes. Ledger 8 bytes under
// ledger 9's header decode under ledger 9 as another transaction, so the header alone does not
// place bytes in an era; the runtime that executed them does.
export function assertTransactionRuntime(bytes: Uint8Array, specVersion: number): void {
  const executed = runtimeLedger(specVersion);
  const { tag, ledger } = taggedLedger(bytes, "transaction");
  if (ledger !== executed) throw new Error(`transaction header ${tag} is not one runtime ${specVersion} executes`);
}

export function ledgerParametersIn(bytes: Uint8Array): L8.LedgerParameters | L9.LedgerParameters {
  const { tag, ledger } = taggedLedger(bytes, "ledger-parameters");
  if (!ledger) throw new Error(`ledger parameters header ${tag} is not one this decoder knows`);
  return ledger === L9 ? L9.LedgerParameters.deserialize(bytes) : L8.LedgerParameters.deserialize(bytes);
}
