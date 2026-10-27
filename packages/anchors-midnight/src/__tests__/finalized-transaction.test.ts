import { describe, expect, it } from "vitest";
import fixture from "./fixtures/rpc-mainnet-execution.json";
import { rpcOnlySource } from "../rpc-source.js";
import { verifyFinalizedTransaction } from "../finalized-transaction.js";
import type { FinalityCheckpoint } from "../grandpa.js";
import type { MidnightSource } from "../source.js";

const checkpoint: FinalityCheckpoint = { ...fixture.checkpoint, setId: BigInt(fixture.checkpoint.setId), authorities: fixture.checkpoint.authorities.map(author => ({ ...author, weight: BigInt(author.weight) })) };
function source(edit: (method: string, value: any) => unknown = (_, value) => value) {
  const calls: string[] = [];
  const node: MidnightSource["node"] = {
    async call<T>(method: string, params: unknown[] = []) {
      calls.push(method);
      const key = method + JSON.stringify(params);
      if (!(key in fixture.recording)) throw new Error(`Unrecorded RPC ${method}`);
      return edit(method, structuredClone(fixture.recording[key as keyof typeof fixture.recording])) as T;
    },
    async batch<T>(requests: [string, unknown[]][]) { return Promise.all(requests.map(([method, params]) => node.call<T>(method, params))); },
  };
  return { source: rpcOnlySource({ network: "mainnet", node, hints: fixture.hints, registries: [] }), calls };
}

describe("finalized transaction primitive", () => {
  it("authenticates real bytes, inclusion, GRANDPA and execution from read RPC", async () => {
    const result = await verifyFinalizedTransaction(fixture.hints[0]!.txHash, { ...source(), checkpoints: [checkpoint] });
    expect(result.block.hash).toBe(fixture.hints[0]!.blockHash);
    expect(result.timestamp).toBeGreaterThan(0);
    expect(result.bytes.length).toBeGreaterThan(1000);
    expect(result.finality.finalized).toBe(true);
  });

  it("rejects a missing checkpoint", async () => {
    await expect(verifyFinalizedTransaction(fixture.hints[0]!.txHash, { ...source(), checkpoints: [] })).rejects.toThrow(/finality/);
  });

  it("fixes the trusted checkpoint configuration before asynchronous source reads", async () => {
    const options = source();
    const mutableCheckpoint = structuredClone(checkpoint);
    const locate = options.source.indexer.transactions.bind(options.source.indexer);
    options.source.indexer.transactions = async hash => {
      mutableCheckpoint.setId += 1n;
      mutableCheckpoint.startsAfter.hash = "ee".repeat(32);
      mutableCheckpoint.authorities[0]!.key = "ff".repeat(32);
      return locate(hash);
    };
    const result = await verifyFinalizedTransaction(fixture.hints[0]!.txHash, { ...options, checkpoints: [mutableCheckpoint] });
    expect(result.finality.finalized).toBe(true);
    expect(result.block.hash).toBe(fixture.hints[0]!.blockHash);
  });

  it("rejects an altered block body", async () => {
    const options = source((method, value) => method === "chain_getBlock" ? { ...value, block: { ...value.block, extrinsics: [...value.block.extrinsics, "0x00"] } } : value);
    await expect(verifyFinalizedTransaction(fixture.hints[0]!.txHash, { ...options, checkpoints: [checkpoint] })).rejects.toThrow(/body/);
  });

  it("never asks for execution proofs until finality passes", async () => {
    const options = source((method, value) => method === "grandpa_proveFinality" ? null : value);
    await expect(verifyFinalizedTransaction(fixture.hints[0]!.txHash, { ...options, checkpoints: [checkpoint] })).rejects.toThrow(/finality/);
    expect(options.calls).not.toContain("state_getReadProof");
  });

  it("rejects unproved execution", async () => {
    const options = source((method, value) => method === "state_getReadProof" ? { ...value, proof: [] } : value);
    await expect(verifyFinalizedTransaction(fixture.hints[0]!.txHash, { ...options, checkpoints: [checkpoint] })).rejects.toThrow();
  });
});
