import { describe, expect, it } from "vitest";
import * as rt from "@midnight-ntwrk/compact-runtime";
import * as L from "@midnight-ntwrk/ledger-v8";
import { ledger } from "../../contract/managed/contract/index.js";
import { assertRegistryDeployBytes, assertRegistryState, buildRegistryDeploy, compiledVerifierKeys, registryInitialState } from "../registry.js";
import { deployOf, NETWORK, random32, unprovenRegistryCall } from "./registry-call.js";

// A ledger-v8 8.1.3 ledger with signatures checked and proofs off: the maintenance rules
// under test are signature and threshold rules, which do not depend on proofs.
const now = new Date();
const ttl = new Date(now.getTime() + 3600e3);
const context = (state: L.LedgerState) =>
  new L.TransactionContext(state, {
    secondsSinceEpoch: BigInt(Math.floor(now.getTime() / 1000)),
    secondsSinceEpochErr: 30,
    parentBlockHash: "00".repeat(32),
    lastBlockTime: BigInt(Math.floor(now.getTime() / 1000) - 6),
  });
const strictness = () => {
  const s = new L.WellFormedStrictness();
  s.enforceBalancing = false;
  s.verifyNativeProofs = false;
  s.verifyContractProofs = false;
  s.verifySignatures = true;
  return s;
};
const apply = (state: L.LedgerState, tx: L.Transaction<L.SignatureEnabled, L.NoProof, L.NoBinding>) => {
  const [after, result] = state.apply(tx.wellFormed(state, strictness(), now), context(state));
  return { after, result };
};

function deployOnBlankLedger(deploy: L.ContractDeploy) {
  const tx = L.Transaction.fromParts(NETWORK, undefined, undefined, L.Intent.new(ttl).addDeploy(deploy)).eraseProofs();
  const { after, result } = apply(L.LedgerState.blank(NETWORK), tx);
  expect(result.type).toBe("success");
  return { ledgerState: after, tx };
}

function attempt(state: L.LedgerState, address: string, updates: L.SingleUpdate[], sign?: { idx: bigint; key: L.SigningKey }): string {
  let update = new L.MaintenanceUpdate(address, updates, 0n);
  if (sign) update = update.addSignature(sign.idx, L.signData(sign.key, update.dataToSign));
  const tx = L.Transaction.fromParts(NETWORK, undefined, undefined, L.Intent.new(ttl).addMaintenanceUpdate(update)).eraseProofs();
  try {
    return `accepted:${apply(state, tx).result.type}`;
  } catch (e) {
    return `rejected:${e instanceof Error ? e.message : String(e)}`;
  }
}

const hijack = () => [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority([], 0, 1n))];
const dropAnchor = () => [new L.VerifierKeyRemove("anchor", new L.ContractOperationVersion("v3"))];
const addRewrite = () => [new L.VerifierKeyInsert("rewrite", new L.ContractOperationVersionedVerifierKey("v3", compiledVerifierKeys().anchor))];

describe("maintenance against the deployed registry, on a ledger-v8 8.1.3 ledger", () => {
  it("positive control: a threshold-0 registry accepts unsigned authority replacement, key removal and key insertion", () => {
    const thresholdZero = registryInitialState();
    thresholdZero.maintenanceAuthority = new L.ContractMaintenanceAuthority([], 0, 0n);
    const deploy = new L.ContractDeploy(thresholdZero);
    const { ledgerState } = deployOnBlankLedger(deploy);
    const address = String(deploy.address);
    expect(attempt(ledgerState, address, hijack())).toBe("accepted:success");
    expect(attempt(ledgerState, address, dropAnchor())).toBe("accepted:success");
    expect(attempt(ledgerState, address, addRewrite())).toBe("accepted:success");
  });

  it("the v1 registry rejects every update, unsigned or signed by anyone at index 0 or 1", () => {
    const { tx, address } = buildRegistryDeploy({ networkId: NETWORK, ttl });
    const { ledgerState } = deployOnBlankLedger(deployOf(tx));
    const key = L.sampleSigningKey();
    for (const updates of [hijack(), dropAnchor(), addRewrite()]) {
      expect(attempt(ledgerState, address, updates)).toMatch(/^rejected:.*does not meet required threshold \(0\/1 signatures/);
      for (const idx of [0n, 1n]) {
        expect(attempt(ledgerState, address, updates, { idx, key })).toMatch(/^rejected:.*does not correspond to a committee member/);
      }
    }
  });

  it("immutability reads back from the applied ledger and from the decoded deploy transaction", () => {
    const { tx, address } = buildRegistryDeploy({ networkId: NETWORK, ttl });
    const { ledgerState, tx: applied } = deployOnBlankLedger(deployOf(tx));
    assertRegistryState(ledgerState.index(address)!);
    const decoded = L.Transaction.deserialize("signature", "no-proof", "no-binding", applied.serialize());
    const deploys = [...decoded.intents!.values()].flatMap((i) => i.actions.filter((a) => a instanceof L.ContractDeploy));
    expect(deploys.map((d) => String(d.address))).toEqual([address]);
    assertRegistryState(deploys[0]!.initialState);
    expect(assertRegistryDeployBytes(tx.serialize(), "unproven")).toBe(address);
  });

  it("two anchors built against the same pre-state both apply: writes never depend on a read", () => {
    const deploy = new L.ContractDeploy(registryInitialState());
    const address = String(deploy.address);
    let { ledgerState } = deployOnBlankLedger(deploy);
    const pre = ledgerState.index(address)!;
    const calls = [1, 2].map(() =>
      unprovenRegistryCall({ address, state: pre, call: { circuit: "anchor", args: [random32(), 1n] }, witnesses: { authorSecret: random32() }, ttl }).tx,
    );
    for (const call of calls) {
      const { after, result } = apply(ledgerState, call.eraseProofs());
      expect(result.type).toBe("success");
      ledgerState = after;
    }
    expect(ledger(rt.ContractState.deserialize(ledgerState.index(address)!.serialize()).data).anchors).toBe(2n);
  });
});
