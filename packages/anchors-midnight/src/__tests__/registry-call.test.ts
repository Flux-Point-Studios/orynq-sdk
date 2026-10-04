import { describe, expect, it } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import { buildRegistryDeploy } from "../registry.js";
import { unprovenRegistryCall } from "../registry-call.js";
import { deployOf, random32 } from "./registry-call.js";

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
