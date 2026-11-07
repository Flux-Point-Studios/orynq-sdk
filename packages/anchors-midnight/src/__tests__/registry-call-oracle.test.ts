import { describe, expect, it } from "vitest";
import * as L9 from "@midnightntwrk/ledger-v9";
import oracle from "./fixtures/midnight-js-registry-calls.json";
import { unprovenRegistryCall, type HiddenEntry, type RegistryCallArgs } from "../registry-call.js";
import { registryState } from "../registry.js";
import { fromHex } from "../scale.js";
import { contractStateAt } from "./fork-chain.js";

// midnight-js 5 builds a call to a contract deployed before the fork as a ledger 9 transaction
// carrying the ledger 8 circuit's proof and transcript. tools/midnight-js-oracle recorded what it
// builds for each registry circuit; ours must build the same call from the same inputs.
type Encoded = { bytes: string } | { bigint: string };
const revive = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    if ("bytes" in value) return fromHex((value as { bytes: string }).bytes, "bytes");
    if ("bigint" in value) return BigInt((value as { bigint: string }).bigint);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
  }
  return value;
};
const plain = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => (v instanceof Uint8Array ? { bytes: Buffer.from(v).toString("hex") } : typeof v === "bigint" ? { bigint: String(v) } : v)));

const state = registryState(contractStateAt(oracle.address, oracle.stateAt.height)) as L9.ContractState;
const parameters = L9.LedgerParameters.deserialize(fromHex(oracle.parameters, "parameters"));
const authorSecret = fromHex(oracle.authorSecret, "secret");

function both(c: (typeof oracle.cases)[number]) {
  const theirs = L9.Transaction.deserialize("signature", "pre-proof", "pre-binding", fromHex(c.oracle.tx, "oracle tx"));
  const [intent] = [...theirs.intents!.values()];
  const call = { circuit: c.circuit, args: c.args.map((a) => revive(a as Encoded)) } as RegistryCallArgs;
  const hiddenEntry = c.hiddenEntry && (Object.fromEntries(Object.entries(c.hiddenEntry).map(([k, v]) => [k, fromHex(v, k)])) as unknown as HiddenEntry);
  const ours = unprovenRegistryCall({ networkId: oracle.network, address: oracle.address, state, parameters, call, witnesses: { authorSecret, ...(hiddenEntry ? { hiddenEntry } : {}) }, ttl: intent!.ttl });
  return { theirs, theirCall: intent!.actions[0] as L9.ContractCall<L9.PreProof>, ours };
}

// What toString shows of a transaction once the segment its intent takes and its binding
// randomness, both drawn at random, are blanked.
const shape = (tx: { toString(compact?: boolean): string }) => tx.toString(false).replace(/^( {8})\d+: Intent/m, "$1<segment>: Intent").replace(/binding_randomness: [0-9a-f]+/, "binding_randomness: <random>");

describe.each(oracle.cases)("a ledger 9 call to the ledger 8 registry, $name ($circuit), against midnight-js 5", (c) => {
  it("runs the circuit to the inputs, outputs and private transcript midnight-js records", () => {
    const { ours } = both(c);
    expect(plain(ours.result.proofData.input)).toEqual(c.oracle.input);
    expect(plain(ours.result.proofData.output)).toEqual(c.oracle.output);
    expect(plain(ours.result.proofData.privateTranscriptOutputs)).toEqual(c.oracle.privateTranscriptOutputs);
  });

  it("partitions the public transcript as midnight-js does: gas, effects, program and transcript version", () => {
    const { theirCall, ours } = both(c);
    expect(plain(ours.guaranteed)).toEqual(plain(theirCall.guaranteedTranscript));
    expect(ours.fallible).toBeUndefined();
    expect(theirCall.fallibleTranscript).toBeUndefined();
  });

  it("builds a transaction of midnight-js's shape: one intent, one call, the same TTL, no offers", () => {
    const { theirs, ours } = both(c);
    expect(shape(ours.tx)).toBe(shape(theirs));
  });
});
