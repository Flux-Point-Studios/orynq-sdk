import { describe, expect, it } from "vitest";
import execution from "./fixtures/rpc-mainnet-execution.json";
import { MIDNIGHT_REGISTRIES } from "../registries.js";
import { REGISTRY_VERIFIER_KEY_SHA256, registryVerifierKeysIn } from "../registry.js";
import { fromHex } from "../scale.js";
import { FORK, contractStateAt } from "./fork-chain.js";

const REGISTRY = "438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736";
const PROOF_CONTRACT = "f44d99b014af2c21c3bb4db4ba727470c006181a3ede24074db1541a2c319cc5";
// Block 3113832, the first mainnet anchor's, under ledger 8; block 3346145, after the upgrade.
const v6 = fromHex(execution.recording[`midnight_contractState["${REGISTRY}","0x18e31c819837ede6ed536fcd85a8d8f29af6affd87d642793ef9bcbe50ea1008"]`], "v6 state");
const v8 = contractStateAt(REGISTRY, FORK.end.height);
const tag = (state: Uint8Array) => Buffer.from(state.subarray(0, 28)).toString("latin1");
const retagged = (state: Uint8Array, next: string) => {
  const out = new Uint8Array(state);
  out.set(Buffer.from(next, "latin1"), "midnight:contract-state[".length);
  return out;
};

describe("the gen-1 registry's verifier keys, read from its state before and after the Ledger 9 upgrade", () => {
  it("reads the pinned keys from the ledger 8 v6 state at 3113832 and the ledger 9 v8 state at 3346145 alike", () => {
    expect([tag(v6), tag(v8)]).toEqual(["midnight:contract-state[v6]:", "midnight:contract-state[v8]:"]);
    const pinned = { anchor: MIDNIGHT_REGISTRIES.mainnet[0]!.circuits.anchor.vkSha256, anchor_hiding: MIDNIGHT_REGISTRIES.mainnet[0]!.circuits.anchor_hiding.vkSha256 };
    expect(pinned).toEqual(REGISTRY_VERIFIER_KEY_SHA256);
    expect(registryVerifierKeysIn(v6)).toEqual(pinned);
    expect(registryVerifierKeysIn(v8)).toEqual(pinned);
  });

  it("refuses a contract-state tag neither ledger defines", () => {
    for (const next of ["v7", "v9"]) expect(() => registryVerifierKeysIn(retagged(v8, next))).toThrow(new RegExp(`contract-state\\[${next}\\] is not one this verifier knows`));
  });

  it("refuses the v8 state of another immutable contract: the proof contract at 3346145", () => {
    const other = contractStateAt(PROOF_CONTRACT, FORK.end.height);
    expect(tag(other)).toBe("midnight:contract-state[v8]:");
    expect(() => registryVerifierKeysIn(other)).toThrow(/operations must be exactly anchor,anchor_hiding|verifier key mismatch|schema must be/);
  });
});
