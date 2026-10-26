import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import { buildProofDeploy, buildProofCall, proofInitialState, assertProofDeploy, presentationId } from "../onchain.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const contextDigest = digest("broker:nonce:synthetic");
const capability = new Uint8Array(32).fill(7);
const commitment = createHash("sha256").update(capability).update(Buffer.from(contextDigest, "hex")).digest("hex");
const notAfter = 2_000_000_000;
const expected = { circuit: "proveCapability" as const, commitment, contextDigest, notAfter };
const genesisHash = digest("genesis");
const eventDigest = digest("event");
const rolling = { circuit: "proveRolling1" as const, genesisHash, rootHash: digest(`poi-trace:roll:v1|${genesisHash}|${eventDigest}`), anchorHash: digest("anchor"), contextDigest, notAfter };
const build = (statement = expected, witness = { capability }) => buildProofCall({ state: proofInitialState(), network: "preprod", address: "ab".repeat(32), statement, witness });

describe("immutable on-chain proof presentations", () => {
  it("deploys only the pinned immutable state", () => {
    const { tx, address } = buildProofDeploy("preprod", new Date(notAfter * 1000));
    expect(assertProofDeploy(tx.serialize(), "unproven")).toBe(address);
    const state = proofInitialState();
    expect(state.maintenanceAuthority.committee).toEqual([]);
    expect(state.maintenanceAuthority.threshold).toBe(1);
    expect(state.maintenanceAuthority.counter).toBe(0n);
    expect(state.operations().sort()).toEqual(["proveCapability", "proveRolling1"]);
    state.maintenanceAuthority = new L.ContractMaintenanceAuthority([], 0, 0n);
    const changed = L.Transaction.fromParts("preprod", undefined, undefined, L.Intent.new(new Date(notAfter * 1000)).addDeploy(new L.ContractDeploy(state)));
    expect(() => assertProofDeploy(changed.serialize(), "unproven")).toThrow(/pinned/);
  });

  it("records a capability by its public statement without reading an old value", () => {
    const call = build();
    expect(Buffer.from(call.after.presentations.lookup(presentationId(expected)).commitment).toString("hex")).toBe(commitment);
    expect(JSON.stringify(call.program.slice(5))).not.toContain("popeq");
    expect(call.program[3]).toBe("lt");
  });

  it("rejects a wrong capability in the circuit", () => {
    expect(() => build(expected, { capability: new Uint8Array(32).fill(8) })).toThrow(/capability mismatch/);
  });

  it("checks the exact rolling relation", () => {
    const call = buildProofCall({ state: proofInitialState(), network: "preprod", address: "ab".repeat(32), statement: rolling, witness: { eventDigest } });
    expect(Buffer.from(call.after.presentations.lookup(presentationId(rolling)).rootHash).toString("hex")).toBe(rolling.rootHash);
    expect(JSON.stringify(call.program.slice(5))).not.toContain("popeq");
    expect(call.program[3]).toBe("lt");
    expect(() => buildProofCall({ state: proofInitialState(), network: "preprod", address: "ab".repeat(32), statement: { ...rolling, rootHash: digest("wrong") }, witness: { eventDigest } })).toThrow(/rolling root mismatch/);
  });

  it.each(["A".repeat(64), "g".repeat(64)])("rejects noncanonical private hex %s", eventDigest => {
    expect(() => buildProofCall({ state: proofInitialState(), network: "preprod", address: "ab".repeat(32), statement: rolling, witness: { eventDigest } })).toThrow(/canonical event digest/);
  });

  it("rejects noncanonical genesis in the circuit", () => {
    expect(() => buildProofCall({ state: proofInitialState(), network: "preprod", address: "ab".repeat(32), statement: { ...rolling, genesisHash: "A".repeat(64) }, witness: { eventDigest } })).toThrow(/noncanonical hex digest/);
  });

  it("rejects an expired deadline in the circuit", () => {
    expect(() => build({ ...expected, notAfter: 1 })).toThrow(/proof deadline passed/);
  });
});
