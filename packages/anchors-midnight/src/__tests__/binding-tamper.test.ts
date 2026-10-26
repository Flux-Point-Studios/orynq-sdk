import { describe, expect, it } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import { flipBindingRandomness, NETWORK, random32, unprovenRegistryCall } from "./registry-call.js";
import { registryInitialState } from "../registry.js";

const now = new Date();
const ttl = new Date(now.getTime() + 1800e3);
const strictness = () => {
  const s = new L.WellFormedStrictness();
  s.enforceBalancing = false;
  s.verifyNativeProofs = false;
  s.verifyContractProofs = false;
  return s;
};
const context = (state: L.LedgerState) =>
  new L.TransactionContext(state, {
    secondsSinceEpoch: BigInt(Math.floor(now.getTime() / 1000)),
    secondsSinceEpochErr: 30,
    parentBlockHash: "00".repeat(32),
    lastBlockTime: BigInt(Math.floor(now.getTime() / 1000) - 6),
  });
const failure = (f: () => unknown) => {
  try {
    f();
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

// The slow suite's canary tampers the proven call's binding randomness and needs the ledger
// to reach the binding check every time; these calls carry the same randomness bytes.
describe("flipBindingRandomness", () => {
  it("every tampered call still deserializes and fails only the binding check, across 256 fresh calls", () => {
    const deploy = new L.ContractDeploy(registryInitialState());
    const address = String(deploy.address);
    const blank = L.LedgerState.blank(NETWORK);
    const deployTx = L.Transaction.fromParts(NETWORK, undefined, undefined, L.Intent.new(ttl).addDeploy(deploy)).eraseProofs();
    const [ledgerState] = blank.apply(deployTx.wellFormed(blank, strictness(), now), context(blank));
    const state = ledgerState.index(address)!;
    const reparse = (bytes: Uint8Array) => L.Transaction.deserialize("signature", "pre-proof", "pre-binding", bytes);

    const problems: string[] = [];
    for (let i = 0; i < 256; i++) {
      const witnesses = { authorSecret: random32(), hiddenEntry: { root_hash: random32(), manifest_hash: random32(), merkle_root: random32(), salt: random32() } };
      const call = i % 2 ? { circuit: "anchor" as const, args: [random32(), 1n] as [Uint8Array, bigint] } : { circuit: "anchor_hiding" as const, args: [random32()] as [Uint8Array] };
      const { tx } = unprovenRegistryCall({ address, state, call, witnesses, ttl });
      const original = tx.serialize();
      const untampered = failure(() => reparse(original).wellFormed(ledgerState, strictness(), now));
      if (untampered) problems.push(`${i} ${call.circuit} untampered: ${untampered}`);

      const tampered = flipBindingRandomness(tx);
      const changed = original.reduce((n, byte, j) => n + (byte !== tampered[j] ? 1 : 0), 0);
      if (tampered.length !== original.length || changed !== 1) problems.push(`${i} ${call.circuit}: ${changed} bytes changed`);
      let parsed: ReturnType<typeof reparse> | undefined;
      const decode = failure(() => (parsed = reparse(tampered)));
      if (decode) {
        problems.push(`${i} ${call.circuit} deserialize: ${decode}`);
        continue;
      }
      const check = failure(() => parsed!.wellFormed(ledgerState, strictness(), now));
      if (!check?.startsWith("binding commitment calculation mismatch")) problems.push(`${i} ${call.circuit} wellFormed: ${check ?? "accepted"}`);
    }
    expect(problems).toEqual([]);
  }, 120_000);
});
