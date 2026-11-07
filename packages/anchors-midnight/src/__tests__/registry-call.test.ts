import { describe, expect, it } from "vitest";
import * as L from "@midnightntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";
import { decodeAnchorTransaction } from "../anchor-transaction.js";
import { buildRegistryDeploy } from "../registry.js";
import { unprovenRegistryCall, type Ledger9RegistryCall } from "../registry-call.js";
import { deployOf, deployedRegistry9, finalBytes9, hex, ledger9Strictness, random32 } from "./registry-call.js";

const now = new Date();
const strictness = () => {
  const s = new L.WellFormedStrictness();
  s.enforceBalancing = false;
  s.verifyNativeProofs = false;
  s.verifyContractProofs = false;
  return s;
};
const context = (state: L.LedgerState) =>
  new L.TransactionContext(state, { secondsSinceEpoch: BigInt(Math.floor(now.getTime() / 1000)), secondsSinceEpochErr: 30, parentBlockHash: "00".repeat(32), lastBlockTime: BigInt(Math.floor(now.getTime() / 1000) - 6) });

// A deployed registry on a blank ledger of `networkId`, and an anchor call built for `callNetwork`.
function attempt(networkId: string, callNetwork: string) {
  const ttl = new Date(now.getTime() + 1800e3);
  const deploy = buildRegistryDeploy({ networkId, ttl });
  let ledger = L.LedgerState.blank(networkId);
  [ledger] = ledger.apply(deploy.tx.eraseProofs().wellFormed(ledger, strictness(), now), context(ledger));
  const call = unprovenRegistryCall({
    networkId: callNetwork,
    address: deploy.address,
    state: deployOf(deploy.tx).initialState,
    call: { circuit: "anchor", args: [random32(), 1n] },
    witnesses: { authorSecret: random32() },
    ttl,
  });
  return () => call.tx.eraseProofs().wellFormed(ledger, strictness(), now);
}

describe("unprovenRegistryCall", () => {
  it("builds the call for the network it is given", () => {
    expect(attempt("preprod", "preprod")).not.toThrow();
    expect(attempt("preprod", "mainnet")).toThrow(/network/i);
  });
});

describe("unprovenRegistryCall against the state a ledger 9 network holds", () => {
  const now = new Date();
  const registry = deployedRegistry9("preprod", now);
  const secret = random32();
  const call9 = (overrides: Record<string, unknown> = {}) =>
    unprovenRegistryCall({ networkId: "preprod", address: registry.address, state: registry.state, parameters: registry.parameters, call: { circuit: "anchor", args: [random32(), 1n] }, witnesses: { authorSecret: secret }, ttl: new Date(now.getTime() + 1800e3), ...overrides } as Parameters<typeof unprovenRegistryCall>[0]) as Ledger9RegistryCall;

  it("builds a ledger 9 transaction[v12] carrying the ledger 8 circuit's call, well-formed on that network", () => {
    const { tx } = call9();
    expect(tx).toBeInstanceOf(L9.Transaction);
    expect(Buffer.from(tx.serialize().subarray(0, 26)).toString("latin1")).toBe("midnight:transaction[v12](");
    expect(() => tx.eraseProofs().wellFormed(registry.ledger, ledger9Strictness(), now)).not.toThrow();
  });

  it("writes exactly the anchor the circuit computes, as decodeAnchorTransaction reads it back", async () => {
    const commitment = random32();
    const { tx, after } = call9({ call: { circuit: "anchor", args: [commitment, 3n] } });
    const { calls } = decodeAnchorTransaction(await finalBytes9(tx), [registry.address]);
    expect(calls).toEqual([{ address: registry.address, entryPoint: "anchor", kind: 3, commitment: hex(commitment), attribute: "00".repeat(32), author: hex(after.last_author) }]);
  });

  it("refuses a ledger 9 state without the chain's ledger 9 parameters", () => {
    expect(() => call9({ parameters: undefined })).toThrow("a call against a ledger 9 state is partitioned with the chain's ledger 9 parameters");
    expect(() => call9({ parameters: L.LedgerParameters.initialParameters() as never })).toThrow("a call against a ledger 9 state is partitioned with the chain's ledger 9 parameters");
  });

  it("refuses ledger 9 parameters for a ledger 8 state, whose transaction ledger 8 partitions", () => {
    const l8 = buildRegistryDeploy({ networkId: "preprod", ttl: new Date(now.getTime() + 1800e3) });
    expect(() => unprovenRegistryCall({ networkId: "preprod", address: l8.address, state: deployOf(l8.tx).initialState, parameters: registry.parameters as never, call: { circuit: "anchor", args: [random32(), 1n] }, witnesses: { authorSecret: secret }, ttl: new Date(now.getTime() + 1800e3) })).toThrow("a call against a ledger 8 state is partitioned with ledger 8 parameters");
  });
});
