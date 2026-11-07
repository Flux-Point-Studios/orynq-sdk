import { describe, expect, it } from "vitest";
import execution from "./fixtures/rpc-mainnet-execution.json";
import { MIDNIGHT_REGISTRIES } from "../registries.js";
import * as L8 from "@midnight-ntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";
import { createHash } from "node:crypto";
import { REGISTRY_CIRCUITS, REGISTRY_VERIFIER_KEY_SHA256, registryState, registryVerifierKeysIn } from "../registry.js";
import { fromHex } from "../scale.js";
import { FORK, contractStateAt } from "./fork-chain.js";

const REGISTRY = "438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736";
const PROOF_CONTRACT = "f44d99b014af2c21c3bb4db4ba727470c006181a3ede24074db1541a2c319cc5";
// Block 3113832, the first mainnet anchor's, under ledger 8; block 3346145, after the upgrade.
const v6 = fromHex(execution.recording[`midnight_contractState["${REGISTRY}","0x18e31c819837ede6ed536fcd85a8d8f29af6affd87d642793ef9bcbe50ea1008"]`], "v6 state");
const v8 = contractStateAt(REGISTRY, FORK.end.height);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
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

describe("registryState, the registry's state as the ledger its tag names reads it", () => {
  it("is a ledger 8 state for the v6 bytes and a ledger 9 state for the v8 bytes, each the immutable registry", () => {
    expect(registryState(v6)).toBeInstanceOf(L8.ContractState);
    expect(registryState(v8)).toBeInstanceOf(L9.ContractState);
    expect(Buffer.from(registryState(v8).serialize())).toEqual(Buffer.from(v8));
  });

  it("refuses another contract's state and a tag neither ledger defines", () => {
    expect(() => registryState(contractStateAt(PROOF_CONTRACT, FORK.end.height))).toThrow();
    expect(() => registryState(retagged(v8, "v7"))).toThrow(/contract-state\[v7\] is not one this verifier knows/);
  });

  // The canonical-encoding check refuses bytes a ledger decodes to a state that re-encodes
  // differently. Ledger 9.1's decoder admits no such bytes one alteration away from the chain's:
  // every flipped byte either fails to decode, or decodes to a state that encodes to exactly those
  // bytes. A decoder that starts admitting other encodings fails here, where the check starts to
  // matter, and none of the alterations yields other verifier keys.
  it("finds no non-canonical encoding of the registry's v8 state one flipped byte away, and no alteration with other keys", () => {
    const pinned = registryVerifierKeysIn(v8);
    const outcome = <T>(f: () => T): T | Error => {
      try {
        return f();
      } catch (error) {
        return error as Error;
      }
    };
    let decoded = 0;
    for (let i = "midnight:contract-state[v8]:".length; i < v8.length; i++) {
      const altered = new Uint8Array(v8);
      altered[i]! ^= 1;
      const state = outcome(() => L9.ContractState.deserialize(altered));
      if (state instanceof Error) continue;
      decoded++;
      expect(Buffer.from(state.serialize()).equals(Buffer.from(altered)), `byte ${i}`).toBe(true);
      const keys = REGISTRY_CIRCUITS.map((circuit) => state.operation(circuit)?.verifierKey);
      if (keys.some((key, i) => !key || sha256(key) !== pinned[REGISTRY_CIRCUITS[i]!])) expect(() => registryVerifierKeysIn(altered), `byte ${i}`).toThrow();
    }
    expect(decoded).toBeGreaterThan(1000);
  }, 180_000);
});

