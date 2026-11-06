import { describe, expect, it } from "vitest";
import fixture from "./fixtures/rpc-mainnet-execution.json";
import { rpcOnlySource } from "../rpc-source.js";
import { verifyMidnightAnchor, type VerifyRequest } from "../verify.js";
import { verifyBlockEffects } from "../execution.js";
import { verifyFinality, type FinalityCheckpoint } from "../grandpa.js";
import { toHex } from "../scale.js";
import { finalityRpc, type MidnightSource } from "../source.js";
import { headerHash } from "../substrate.js";
import { FORK, forkBlock, forkCheckpoint, forkNode, forkSends } from "./fork-chain.js";

const checkpoint: FinalityCheckpoint = { ...fixture.checkpoint, setId: BigInt(fixture.checkpoint.setId), authorities: fixture.checkpoint.authorities.map((author) => ({ ...author, weight: BigInt(author.weight) })) };
const request = fixture.request as VerifyRequest;
function options(edit: (method: string, params: unknown[], answer: any) => unknown = (_, __, answer) => answer) {
  const calls: string[] = [];
  const node: MidnightSource["node"] = {
    async call<T>(method: string, params: unknown[] = []) {
      calls.push(method);
      const key = method + JSON.stringify(params);
      if (!(key in fixture.recording)) throw new Error(`Unrecorded RPC ${method}`);
      return edit(method, params, structuredClone(fixture.recording[key as keyof typeof fixture.recording])) as T;
    },
    async batch<T>(batch: [string, unknown[]][]) { return Promise.all(batch.map(([method, params]) => node.call<T>(method, params))); },
  };
  return { source: rpcOnlySource({ network: "mainnet", node, hints: fixture.hints }), checkpoints: [checkpoint], calls };
}

describe("public RPC-only verification replays real finalized mainnet execution", () => {
  it("verifies both existing anchors, including the registry deployment execution", async () => {
    for (const [txHash, expectation] of [[request.txHash, request.expect], [fixture.hints[1]!.txHash, { kind: 2, attribute: "6087363539cf4a83f465b586740d385ffe9d87d3be00701a66f0ad0f2f50ae15" }]] as const) {
      const opts = options();
      const result = await verifyMidnightAnchor({ ...request, txHash, expect: expectation }, opts);
      expect(result.status).toBe("valid");
      expect(result.assurance).toBe("consensus-verified");
      expect(result.checks.filter((check) => check.name.endsWith("execution"))).toHaveLength(2);
      expect(opts.calls).not.toContain("state_getMetadata");
      expect(opts.calls).not.toContain("state_getRuntimeVersion");
    }
  });

  it("does not read or decode execution witnesses until finality succeeds", async () => {
    const skipped = options();
    expect((await verifyMidnightAnchor(request, { ...skipped, finality: "skip" })).status).toBe("unverified-finality");
    expect(skipped.calls).not.toContain("state_getReadProof");
    const missing = options((method, _, answer) => method === "grandpa_proveFinality" ? null : answer);
    expect((await verifyMidnightAnchor(request, missing)).status).not.toBe("valid");
    expect(missing.calls).not.toContain("state_getReadProof");
  });

  it("rejects missing runtime, event or deployment execution proofs as conflicts", async () => {
    for (const target of ["parent", "anchor", "deploy"]) {
      const opts = options((method, params, answer) => {
        if (method !== "state_getReadProof") return answer;
        const code = (params[0] as string[]).includes("0x3a636f646500");
        if ((target === "parent" && code) || (target === "anchor" && !code && params[1] === `0x${fixture.hints[0]!.blockHash}`) || (target === "deploy" && !code && params[1] !== `0x${fixture.hints[0]!.blockHash}`)) return { ...answer, proof: [] };
        return answer;
      });
      expect((await verifyMidnightAnchor(request, opts)).status).toBe("conflict");
    }
  });
});

describe("public RPC-only verification replays the recorded mainnet Ledger 9 fork range 3346131-3346145", () => {
  it("finalizes the range under set 11197 and authenticates every block's execution, 1000300 through 3346138 and 2001100 from 3346139", async () => {
    const { node, calls } = forkNode();
    const source = rpcOnlySource({ network: "mainnet", node, hints: [] });
    const finality = await verifyFinality({ rpc: finalityRpc(source), block: FORK.end, checkpoints: [forkCheckpoint] });
    expect(finality.finalized).toBe(true);
    const runtimes: number[] = [];
    let child = forkBlock(FORK.end.height);
    expect(child.blockHash).toBe(FORK.end.hash);
    for (let height = FORK.end.height; height > FORK.after.height; height--) {
      const block = forkBlock(height);
      expect(block.header.number).toBe(height);
      if (height < FORK.end.height) expect(toHex(headerHash(block.header))).toBe(toHex(child.header.parentHash));
      const applied = await verifyBlockEffects(source.node, block);
      applied.assertApplications(forkSends(height));
      runtimes.unshift(applied.runtimeSpecVersion);
      child = block;
    }
    expect(toHex(child.header.parentHash)).toBe(FORK.after.hash);
    expect(runtimes).toEqual([...Array(FORK.setCode - FORK.after.height).fill(1000300), ...Array(FORK.end.height - FORK.setCode).fill(2001100)]);
    expect(calls).not.toContain("state_getMetadata");
    expect(calls).not.toContain("state_getRuntimeVersion");
  });
});
