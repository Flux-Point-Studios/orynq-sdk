import * as L from "@midnight-ntwrk/ledger-v8";
import { toHex } from "./scale.js";

export interface AnchorCall {
  address: string;
  entryPoint: "anchor" | "anchor_hiding";
  kind: number;
  commitment: string;
  attribute: string;
  author: string;
}

export interface AnchorTransaction {
  txHash: string;
  calls: AnchorCall[];
  // Deploys and maintenance updates the transaction aims at a registry address.
  touches: Array<{ action: "deploy" | "maintenance"; address: string }>;
}

// What both registry circuits write, in order: last_commitment (field 2), last_kind (3),
// last_attribute (5) and last_author (4), each as push(key) push(value) ins, then the anchors
// counter (1) incremented; each slot holds a value the circuit discloses.
type Slot = { slot: "commitment" | "kind" | "attribute" | "author"; length: number };
const atom = (length: number) => [{ tag: "atom", value: { tag: "bytes", length } }];
const cell = (value: unknown, length: number) => ({ tag: "cell", content: { value: [value], alignment: atom(length) } });
const field = (index: number, slot: Slot) => [
  { push: { storage: false, value: cell(new Uint8Array([index]), 1) } },
  { push: { storage: true, value: cell(slot, slot.length) } },
  { ins: { cached: false, n: 1 } },
];
const TEMPLATE: unknown[] = [
  ...field(2, { slot: "commitment", length: 32 }),
  ...field(3, { slot: "kind", length: 1 }),
  ...field(5, { slot: "attribute", length: 32 }),
  ...field(4, { slot: "author", length: 32 }),
  { idx: { cached: false, pushPath: true, path: [{ tag: "value", value: { value: [new Uint8Array([1])], alignment: atom(1) } }] } },
  { addi: { immediate: 1 } },
  { ins: { cached: true, n: 1 } },
];

const isSlot = (t: unknown): t is Slot => typeof t === "object" && t !== null && "slot" in t;

// Matches `actual` against `template` exactly, filling `slots` with the bytes at each slot. A
// value atom drops its trailing zero bytes; the ledger refuses one that keeps any, or that is
// longer than its alignment, so padding restores the value.
function matches(actual: unknown, template: unknown, slots: Map<string, Uint8Array>): boolean {
  if (isSlot(template)) {
    if (!(actual instanceof Uint8Array)) return false;
    const padded = new Uint8Array(template.length);
    padded.set(actual);
    slots.set(template.slot, padded);
    return true;
  }
  if (template instanceof Uint8Array) return actual instanceof Uint8Array && toHex(actual) === toHex(template);
  if (Array.isArray(template)) return Array.isArray(actual) && actual.length === template.length && template.every((t, i) => matches(actual[i], t, slots));
  if (typeof template === "object" && template !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
    const keys = Object.keys(template);
    return Object.keys(actual).length === keys.length && keys.every((k) => matches((actual as Record<string, unknown>)[k], (template as Record<string, unknown>)[k], slots));
  }
  return actual === template;
}

const noEffects = (e: L.Effects) =>
  e.claimedNullifiers.length === 0 &&
  e.claimedShieldedReceives.length === 0 &&
  e.claimedShieldedSpends.length === 0 &&
  e.claimedContractCalls.length === 0 &&
  [e.shieldedMints, e.unshieldedMints, e.unshieldedInputs, e.unshieldedOutputs, e.claimedUnshieldedSpends].every((m) => m.size === 0);

function anchorCall(call: L.ContractCall<L.Proofish>, at: string): AnchorCall {
  const entryPoint = typeof call.entryPoint === "string" ? call.entryPoint : Buffer.from(call.entryPoint).toString("utf8");
  if (entryPoint !== "anchor" && entryPoint !== "anchor_hiding") throw new Error(`${at}: entry point ${entryPoint} is not anchor or anchor_hiding`);
  if (call.fallibleTranscript !== undefined) throw new Error(`${at} carries a fallible transcript`);
  const transcript = call.guaranteedTranscript;
  if (!transcript) throw new Error(`${at} has no guaranteed transcript`);
  if (!noEffects(transcript.effects)) throw new Error(`${at} claims effects`);
  const slots = new Map<string, Uint8Array>();
  if (!matches(transcript.program, TEMPLATE, slots)) throw new Error(`${at}: its transcript is not the registry circuit's`);
  const kind = slots.get("kind")![0]!;
  const attribute = toHex(slots.get("attribute")!);
  if (entryPoint === "anchor" && kind === 2) throw new Error(`${at}: anchor() never writes kind 2`);
  if (entryPoint === "anchor" && attribute !== "00".repeat(32)) throw new Error(`${at}: anchor() writes a zero attribute`);
  if (entryPoint === "anchor_hiding" && kind !== 2) throw new Error(`${at}: anchor_hiding() writes only kind 2`);
  return { address: String(call.address), entryPoint, kind, commitment: toHex(slots.get("commitment")!), attribute, author: toHex(slots.get("author")!) };
}

// The anchors a transaction writes to any of `registries`, and every deploy or maintenance
// update it aims at one of them. Every call to a registry must write exactly what a registry
// circuit writes. It reads proven and unproven transactions alike.
export function anchorCallsIn(
  tx: L.Transaction<L.Signaturish, L.Proofish, L.Bindingish>,
  registries: readonly string[],
  label: string,
): Pick<AnchorTransaction, "calls" | "touches"> {
  const calls: AnchorCall[] = [];
  const touches: AnchorTransaction["touches"] = [];
  for (const intent of tx.intents?.values() ?? []) {
    for (const action of intent.actions) {
      const address = String(action.address);
      if (!registries.includes(address)) continue;
      if (action instanceof L.ContractCall) calls.push(anchorCall(action, `${label}: the call to registry ${address}`));
      else touches.push({ action: action instanceof L.ContractDeploy ? "deploy" : "maintenance", address });
    }
  }
  return { calls, touches };
}

// Decodes a proven, bound Midnight transaction from its exact bytes, which must be the
// canonical encoding of what they decode to, and returns its hash and anchorCallsIn.
export function decodeAnchorTransaction(bytes: Uint8Array, registries: readonly string[]): AnchorTransaction {
  let tx: L.Transaction<L.SignatureEnabled, L.Proof, L.Binding>;
  try {
    tx = L.Transaction.deserialize("signature", "proof", "binding", bytes);
  } catch (error) {
    throw new Error(`the bytes are not a Midnight transaction: ${(error as Error).message}`);
  }
  if (toHex(tx.serialize()) !== toHex(bytes)) throw new Error("the bytes are not the canonical encoding of the transaction they decode to");
  const txHash = tx.transactionHash();
  return { txHash, ...anchorCallsIn(tx, registries, `transaction ${txHash}`) };
}
