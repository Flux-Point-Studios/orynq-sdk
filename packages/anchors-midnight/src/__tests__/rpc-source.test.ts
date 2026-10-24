import { describe, expect, it } from "vitest";
import { rpcOnlySource } from "../rpc-source.js";
import { MIDNIGHT_REGISTRIES } from "../registries.js";
import { replaySource } from "./recorded-source.js";
import { verifyMidnightAnchor } from "../verify.js";
import { readFileSync } from "node:fs";
const recording = JSON.parse(readFileSync(new URL("./fixtures/mainnet-anchors.json", import.meta.url), "utf8")).recording;
const txHash = "e273d480e57b3315937c8929fbc3c11ab798d42b4ff6c0b88172856dec6b7d58";
const registry = MIDNIGHT_REGISTRIES.mainnet[0]!;
const hint = { txHash, blockHeight: 3113833, blockHash: recording.indexer[txHash][0].block.hash };
const node = replaySource(recording).node;

describe("explicit RPC-only source", () => {
  it("rejects contradictory hints and requires an exact registry deploy-block pin", () => {
    expect(() => rpcOnlySource({ network: "mainnet", node, hints: [hint, { ...hint, blockHeight: hint.blockHeight + 1 }] })).toThrow(/hint/i);
    const unpinned = { ...registry }; delete unpinned.deployBlockHash;
    expect(() => rpcOnlySource({ network: "mainnet", node, hints: [], registries: [unpinned] })).toThrow(/deploy.*block/i);
  });
  it("classifies a wrong block hint as conflict, never a successful lookup", async () => {
    const source = rpcOnlySource({ network: "mainnet", node, hints: [hint] });
    const result = await verifyMidnightAnchor({ network: "mainnet", txHash, expect: { kind: "any" } }, { source });
    expect(result.status).toBe("conflict");
  });
});
