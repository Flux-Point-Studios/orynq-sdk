import { describe, expect, it } from "vitest";
import * as L8 from "@midnightntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";
import { MIDNIGHT_REGISTRIES, headerFromRpc, headerHash, unprovenRegistryCall, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { LEDGER8_RUNTIMES, SUBMITTER_RUNTIME_SPEC_VERSIONS, TimeToDismissError, assertBuiltFor, assertDismissable, assertKnownRuntime, registryStateOnNode } from "../src/submission.js";
import { FORK, forkBlock, recorded } from "../../anchors-midnight/src/__tests__/fork-chain.js";
import { chain, deployed, deployed9, issue838Parameters, recordedDustSpend } from "./fakes.js";
import { prover } from "./prover.js";

const GENERATION_1 = MIDNIGHT_REGISTRIES.mainnet[0]!;
// A mainnet node whose best block is at `height` and holds the recorded state of mainnet block
// `stateOf`, whose code runs the next block: before the fork 1000300, at the set_code block
// 3346138 :pending_code 2001100, after it 2001100. Its runtime version reports :code alone, so
// at 3346138 it says 1000300.
function mainnetNode(height: number, stateOf: number) {
  const recordedBlock = forkBlock(stateOf);
  const rpcHeader = { ...recordedBlock.rpcHeader, number: `0x${height.toString(16)}` };
  const hash = `0x${Buffer.from(headerHash(headerFromRpc(rpcHeader))).toString("hex")}`;
  const calls: unknown[][] = [];
  const call = async (method: string, params: unknown[] = []) => {
    calls.push([method, ...params]);
    if (method === "chain_getHeader" && params.length === 0) return rpcHeader;
    if (method === "state_getReadProof" && params[1] === hash) return { at: hash, proof: recorded<{ proof: string[] }>("state_getReadProof", [params[0], `0x${recordedBlock.blockHash}`]).proof };
    if (method === "state_getRuntimeVersion") return { specVersion: stateOf >= FORK.firstLedger9 ? 2001100 : 1000300 };
    throw new Error(`unexpected ${method}`);
  };
  return { source: { operator: "test", node: { call, batch: async () => [] }, indexer: {} } as unknown as MidnightSource, calls, hash };
}

// A transaction sent now lands at the earliest in the block after the node's best, which the
// code in the best block's state executes: its :pending_code when set_code left one, else :code.
describe("assertKnownRuntime names the runtime of the block a transaction can land in", () => {
  it("is 2001100 while the node's best block is the set_code block 3346138, whose runtime version still reports 1000300", async () => {
    const { source } = mainnetNode(FORK.setCode, FORK.setCode);
    await expect(assertKnownRuntime(source, "mainnet", SUBMITTER_RUNTIME_SPEC_VERSIONS, GENERATION_1.address)).resolves.toBe(2001100);
    const ledger8 = L8.Transaction.fromParts("mainnet", undefined, undefined, L8.Intent.new(new Date(Date.now() + 600e3))).mockProve().bind().serialize();
    expect(() => assertBuiltFor(ledger8, 2001100)).toThrow("the prepared bytes cannot land: transaction header midnight:transaction[v9] is not one runtime 2001100 executes");
    await expect(assertKnownRuntime(source, "mainnet", LEDGER8_RUNTIMES)).rejects.toThrow("the mainnet node runs runtime 2001100, which is not one this submitter knows (1000300)");
  });

  it("is 1000300 after block 3346137 and 2001100 after block 3346139, the controls either side", async () => {
    await expect(assertKnownRuntime(mainnetNode(FORK.setCode - 1, FORK.setCode - 1).source, "mainnet", SUBMITTER_RUNTIME_SPEC_VERSIONS, GENERATION_1.address)).resolves.toBe(1000300);
    await expect(assertKnownRuntime(mainnetNode(FORK.firstLedger9, FORK.firstLedger9).source, "mainnet", SUBMITTER_RUNTIME_SPEC_VERSIONS, GENERATION_1.address)).resolves.toBe(2001100);
  });

  it("reads the code from the best block's state, not the node's runtime version", async () => {
    const { source, calls, hash } = mainnetNode(FORK.setCode, FORK.setCode);
    await assertKnownRuntime(source, "mainnet", SUBMITTER_RUNTIME_SPEC_VERSIONS, GENERATION_1.address);
    expect(calls).toEqual([["chain_getHeader"], ["state_getReadProof", ["0x3a636f646500", "0x3a70656e64696e675f636f646500"], hash]]);
  });

  it.each([
    [FORK.setCode - 1, FORK.firstLedger9, 2001100],
    [FORK.setCode, FORK.setCode - 1, 1000300],
    [3113817, FORK.setCode - 1, 1000300],
  ] as const)("refuses, after best block %i, a runtime outside generation 1's span at the block after it", async (height, stateOf, spec) => {
    const { source } = mainnetNode(height, stateOf);
    await expect(assertKnownRuntime(source, "mainnet", SUBMITTER_RUNTIME_SPEC_VERSIONS, GENERATION_1.address)).rejects.toThrow(`the mainnet node runs runtime ${spec} at block ${height + 1}, which registry generation 1 does not run there`);
  });

  it("refuses a best block whose code no runtime table entry names", async () => {
    const net = chain({ spec: 1000400 });
    await expect(assertKnownRuntime(net.source, "preprod", SUBMITTER_RUNTIME_SPEC_VERSIONS)).rejects.toThrow("Executing runtime code is not supported");
  });
});

describe("registryStateOnNode", () => {
  it("reads the registry's ledger 8 state, and the ledger 9 state the fork translated it to", async () => {
    expect(await registryStateOnNode(chain().source, deployed.address)).toBeInstanceOf(L8.ContractState);
    expect(await registryStateOnNode(chain({ state: deployed9.state }).source, deployed.address)).toBeInstanceOf(L9.ContractState);
  });
});

// A ledger 9 anchor paid with one DUST spend, its call partitioned with ledger 9's initial parameters.
async function anchorPaidWithOneSpend() {
  const ttl = new Date(Date.now() + 600e3);
  const { tx } = unprovenRegistryCall({ networkId: "preprod", address: deployed.address, state: deployed9.state, parameters: L9.LedgerParameters.initialParameters(), call: { circuit: "anchor", args: [new Uint8Array(32).fill(5), 1n] }, witnesses: { authorSecret: new Uint8Array(32).fill(9) }, ttl });
  const proven = await prover.prove(tx);
  const intents = proven.intents!, intent = intents.get(1)!;
  intent.dustActions = new L9.DustActions("signature", "proof", new Date(ttl.getTime() - 60_000), [recordedDustSpend], []);
  proven.intents = intents;
  return proven.bind();
}

describe("assertDismissable (midnight-ledger#838)", () => {
  it("passes an anchor whose fee is one DUST spend under ledger 9's initial time-to-dismiss limits", async () => {
    const final = await anchorPaidWithOneSpend();
    expect(() => assertDismissable(final, L9.LedgerParameters.initialParameters())).not.toThrow();
  });

  it("refuses with a typed error, naming its DUST spends, bytes the node would dismiss too slowly", async () => {
    const final = await anchorPaidWithOneSpend();
    const refusal = (() => {
      try {
        assertDismissable(final, issue838Parameters());
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(refusal).toBeInstanceOf(TimeToDismissError);
    expect(refusal).toMatchObject({ dustSpends: 1 });
    expect((refusal as Error).message).toMatch(/^the final bytes exceed ledger 9's time to dismiss with 1 DUST spend: exceeded the maximum time to dismiss/);
    expect((refusal as Error).message).toMatch(/a fee paid with one DUST spend can exceed it where two pass \(midnight-ledger#838\); nothing was submitted$/);
  });
});
