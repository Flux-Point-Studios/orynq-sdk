import { describe, expect, it } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import {
  assertImmutableAuthority,
  assertRegistryDeployBytes,
  buildRegistryDeploy,
  compiledVerifierKeys,
  registryInitialState,
} from "../registry.js";
import { deployOf, NETWORK } from "./registry-call.js";

const authority = (committee: L.SignatureVerifyingKey[], threshold: number, counter: bigint) =>
  new L.ContractMaintenanceAuthority(committee, threshold, counter);
const someKey = () => L.signatureVerifyingKey(L.sampleSigningKey());
const ttl = () => new Date(Date.now() + 3600e3);
const deployTx = (...states: L.ContractState[]) => {
  let intent = L.Intent.new(ttl());
  for (const s of states) intent = intent.addDeploy(new L.ContractDeploy(s));
  return L.Transaction.fromParts(NETWORK, undefined, undefined, intent);
};
const stateWith = (a: L.ContractMaintenanceAuthority) => {
  const s = registryInitialState();
  s.maintenanceAuthority = a;
  return s;
};

describe("assertImmutableAuthority accepts exactly committee [], threshold 1, counter 0", () => {
  it("accepts [] / 1 / 0", () => {
    expect(() => assertImmutableAuthority(authority([], 1, 0n))).not.toThrow();
  });

  it("refuses threshold 0, under which an unsigned update replaces the authority", () => {
    expect(() => assertImmutableAuthority(authority([], 0, 0n))).toThrow("threshold must be exactly 1, got 0");
  });

  it("refuses threshold 2: also unsatisfiable, but not the one form verifiers pin", () => {
    expect(() => assertImmutableAuthority(authority([], 2, 0n))).toThrow("threshold must be exactly 1, got 2");
  });

  it("refuses any committee member", () => {
    expect(() => assertImmutableAuthority(authority([someKey()], 1, 0n))).toThrow("committee must be empty, got 1");
  });

  it("refuses a non-zero counter, the mark of an applied update", () => {
    expect(() => assertImmutableAuthority(authority([], 1, 1n))).toThrow("counter must be 0, got 1");
  });
});

describe("the deploy is asserted on its exact serialized bytes", () => {
  it("buildRegistryDeploy returns the address the serialized transaction deploys to", () => {
    const { tx, address } = buildRegistryDeploy({ networkId: NETWORK, ttl: ttl() });
    expect(assertRegistryDeployBytes(tx.serialize(), "unproven")).toBe(address);
    expect(String(deployOf(tx).address)).toBe(address);
  });

  it("refuses deploy bytes whose authority is threshold 0", () => {
    expect(() => assertRegistryDeployBytes(deployTx(stateWith(authority([], 0, 0n))).serialize(), "unproven")).toThrow(
      "threshold must be exactly 1, got 0",
    );
  });

  it("refuses deploy bytes that carry a committee", () => {
    expect(() => assertRegistryDeployBytes(deployTx(stateWith(authority([someKey()], 1, 0n))).serialize(), "unproven")).toThrow(
      "committee must be empty, got 1",
    );
  });

  it("refuses deploy bytes whose verifier keys are swapped", () => {
    const keys = compiledVerifierKeys();
    const swapped = registryInitialState({ anchor: keys.anchor_hiding, anchor_hiding: keys.anchor });
    expect(() => assertRegistryDeployBytes(deployTx(swapped).serialize(), "unproven")).toThrow("verifier key mismatch for anchor");
  });

  it("refuses deploy bytes with an operation beyond anchor and anchor_hiding", () => {
    const extra = registryInitialState();
    extra.setOperation("rewrite", extra.operation("anchor")!);
    expect(() => assertRegistryDeployBytes(deployTx(extra).serialize(), "unproven")).toThrow(
      "operations must be exactly anchor,anchor_hiding",
    );
  });

  it("refuses a transaction that deploys twice", () => {
    expect(() => assertRegistryDeployBytes(deployTx(registryInitialState(), registryInitialState()).serialize(), "unproven")).toThrow(
      "exactly one contract action",
    );
  });

  it("decodes the final, proven and bound encoding of the same deploy", async () => {
    const { tx, address } = buildRegistryDeploy({ networkId: NETWORK, ttl: ttl() });
    const refuse = async () => {
      throw new Error("a deploy needs no proof");
    };
    const final = (await tx.prove({ check: refuse, prove: refuse }, L.CostModel.initialCostModel())).bind();
    expect(assertRegistryDeployBytes(final.serialize(), "final")).toBe(address);
    expect(() => assertRegistryDeployBytes(final.serialize(), "unproven")).toThrow();
  });
});
