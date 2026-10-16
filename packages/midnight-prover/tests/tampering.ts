import assert from "node:assert/strict";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import type { CircuitProof } from "../src/real-prover.js";

function firstIntent(transaction: Buffer) {
  return [...ledger.Transaction.deserialize("signature", "proof", "binding", transaction).intents!.values()][0]!;
}

// Flips a byte in the middle of the call's proof, leaving the transcript, binding and TTL untouched.
export function withCorruptedProof<T extends CircuitProof>(proof: T): T {
  const bytes = Buffer.from(proof.transactionBase64, "base64");
  const call = firstIntent(bytes).actions[0] as ledger.ContractCall<ledger.Proof>;
  const tagged = Buffer.from(call.proof.serialize());
  const body = tagged.subarray(tagged.indexOf(":", tagged.indexOf(":") + 1) + 1);
  const start = bytes.indexOf(body);
  assert.ok(start > 0 && bytes.indexOf(body, start + 1) === -1, "proof bytes not located");
  const middle = start + Math.floor(body.length / 2);
  bytes[middle] = bytes[middle]! ^ 1;
  return { ...proof, transactionBase64: bytes.toString("base64") };
}

// The binding signature does not cover the TTL, so anyone holding an envelope can rewrite it.
export function withTtl<T extends CircuitProof>(proof: T, ttlSeconds: number): T {
  const bytes = Buffer.from(proof.transactionBase64, "base64");
  const ttlOf = (candidate: Buffer) => firstIntent(candidate).ttl.getTime() / 1000;
  const needle = Buffer.alloc(4);
  needle.writeUInt32LE(ttlOf(bytes));
  for (let offset = bytes.indexOf(needle); offset >= 0; offset = bytes.indexOf(needle, offset + 1)) {
    const candidate = Buffer.from(bytes);
    candidate.writeUInt32LE(ttlSeconds, offset);
    if (ttlOf(candidate) === ttlSeconds) return { ...proof, transactionBase64: candidate.toString("base64") };
  }
  throw new Error("TTL bytes not located");
}
