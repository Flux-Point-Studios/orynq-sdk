import { describe, expect, it } from "vitest";
import * as L8 from "@midnight-ntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";
import { MIDNIGHT_REGISTRIES, headerFromRpc, headerHash, unprovenRegistryCall, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { SUBMITTER_RUNTIME_SPEC_VERSIONS, TimeToDismissError, assertDismissable, assertKnownRuntime, registryStateOnNode } from "../src/submission.js";
import { chain, deployed, deployed9, issue838Parameters, recordedDustSpend } from "./fakes.js";
import { prover } from "./prover.js";

const GENERATION_1 = MIDNIGHT_REGISTRIES.mainnet[0]!;
// A mainnet node whose best block is `height`, running `specVersion` there.
function mainnetNode(height: number, specVersion: number) {
  const header = { parentHash: `0x${"00".repeat(32)}`, number: `0x${height.toString(16)}`, stateRoot: `0x${"00".repeat(32)}`, extrinsicsRoot: `0x${"00".repeat(32)}`, digest: { logs: [] } };
  const calls: unknown[][] = [];
  const call = async (method: string, params: unknown[] = []) => {
    calls.push([method, ...params]);
    if (method === "chain_getHeader" && params.length === 0) return header;
    if (method === "state_getRuntimeVersion") return { specVersion };
    throw new Error(`unexpected ${method}`);
  };
  const hash = `0x${Buffer.from(headerHash(headerFromRpc(header))).toString("hex")}`;
  return { source: { operator: "test", node: { call, batch: async () => [] }, indexer: {} } as unknown as MidnightSource, calls, hash };
}

describe("assertKnownRuntime binds the runtime to the registry generation's span at the node's best block", () => {
  it("accepts 1000300 through block 3346138 and 2001100 from block 3346139 for generation 1", async () => {
    for (const [height, spec] of [[3346138, 1000300], [3346139, 2001100], [3400000, 2001100]] as const) {
      const { source } = mainnetNode(height, spec);
      await expect(assertKnownRuntime(source, "mainnet", SUBMITTER_RUNTIME_SPEC_VERSIONS, GENERATION_1.address)).resolves.toBe(spec);
    }
  });

  it("reads the runtime at the best block it names", async () => {
    const { source, calls, hash } = mainnetNode(3346139, 2001100);
    await assertKnownRuntime(source, "mainnet", SUBMITTER_RUNTIME_SPEC_VERSIONS, GENERATION_1.address);
    expect(calls).toEqual([["chain_getHeader"], ["state_getRuntimeVersion", hash]]);
  });

  it.each([[3346138, 2001100], [3346139, 1000300], [3113818, 1000300]] as const)("refuses runtime %i's height %i outside generation 1's span for it", async (height, spec) => {
    const { source } = mainnetNode(height, spec);
    await expect(assertKnownRuntime(source, "mainnet", SUBMITTER_RUNTIME_SPEC_VERSIONS, GENERATION_1.address)).rejects.toThrow(`the mainnet node runs runtime ${spec} at block ${height}, which registry generation 1 does not run there`);
  });

  it("refuses a runtime the submitter does not write for before reading any height", async () => {
    const { source, calls } = mainnetNode(3346139, 1000400);
    await expect(assertKnownRuntime(source, "mainnet", SUBMITTER_RUNTIME_SPEC_VERSIONS)).rejects.toThrow("the mainnet node runs runtime 1000400, which is not one this submitter knows (1000300, 2001100)");
    expect(calls).toEqual([["state_getRuntimeVersion"]]);
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
