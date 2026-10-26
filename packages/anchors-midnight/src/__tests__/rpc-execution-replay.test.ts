import { describe, expect, it } from "vitest";
import fixture from "./fixtures/rpc-mainnet-execution.json";
import { rpcOnlySource } from "../rpc-source.js";
import { verifyMidnightAnchor, type VerifyRequest } from "../verify.js";
import type { FinalityCheckpoint } from "../grandpa.js";
import type { MidnightSource } from "../source.js";

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
