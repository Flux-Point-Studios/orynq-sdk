import * as L from "@midnight-ntwrk/ledger-v8";
import { authorKey, midnightTransactionIn, openKnownAuthors, registryInitialState, signKnownAuthors, unprovenRegistryCall, type CheckpointJson, type KnownAuthors } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { prover } from "../../test/prover.js";
import { deployed } from "../../test/fakes.js";
import { finalTransaction } from "../../src/submission.js";
import recording from "../../../anchors-midnight/src/__tests__/fixtures/rpc-mainnet-execution.json";

const secret = new Uint8Array(32).fill(19);
export const batchScope = { network: "preprod" as const, registry: deployed.address, author: Buffer.from(authorKey(secret)).toString("hex"), commitment: "00".repeat(31) + "5a" };

export function batchAuthors(change: { role?: "batch" | "relay"; validFrom?: number; validTo?: number | null } = {}, serial = 1, checkpoints: CheckpointJson[] = []): KnownAuthors {
  const signed = signKnownAuthors(JSON.stringify({ format: "orynq-known-authors/v1", serial, issued: "2026-10-24T00:00:00Z", networks: { preprod: { authors: [{ key: batchScope.author, id: "batch-test", role: "batch", validFrom: 10, validTo: null, ...change }], checkpoints } } }), new Uint8Array(32).fill(21));
  return openKnownAuthors(signed, [signed.signatures[0]!.key]);
}

function recordedSpend() {
  for (const value of Object.values(recording.recording)) {
    const body = (value as { block?: { extrinsics: string[] } }).block?.extrinsics ?? [];
    for (const encoded of body) {
      const bytes = midnightTransactionIn(Buffer.from(encoded.slice(2), "hex"));
      if (!bytes) continue;
      for (const intent of finalTransaction(bytes).intents?.values() ?? []) {
        const spend = intent.dustActions?.spends[0]; if (spend) return spend;
      }
    }
  }
  throw new Error("Recorded fee spend is missing");
}

// Reused public proofs produce canonical final-form policy fixtures, not valid new spends.
export async function batchBytes(options: { kind?: number; ttl?: number; commitment?: string; feeSpends?: number; modify?: (tx: L.UnprovenTransaction) => void } = {}) {
  const ttl = new Date(options.ttl ?? 100_000);
  const built = unprovenRegistryCall({ networkId: batchScope.network, address: batchScope.registry, state: registryInitialState(), ttl, call: { circuit: "anchor", args: [Buffer.from(options.commitment ?? batchScope.commitment, "hex"), BigInt(options.kind ?? 3)] }, witnesses: { authorSecret: secret } });
  if (options.feeSpends) built.tx.intents = new Map([...built.tx.intents!, [2, L.Intent.new(ttl)]]);
  options.modify?.(built.tx);
  const proven = await prover.prove(built.tx);
  if (options.feeSpends) {
    const intents = proven.intents!, feeIntent = intents.get(2)!;
    feeIntent.dustActions = new L.DustActions("signature", "proof", new Date(ttl.getTime() - 60_000), Array.from({ length: options.feeSpends }, recordedSpend), []);
    proven.intents = intents;
  }
  return proven.bind().serialize();
}
