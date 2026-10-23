import { describe, expect, it } from "vitest";
import fixture from "./fixtures/storage-proof-mainnet.json";
import { provedValue } from "../storage-proof.js";
import { verifyExecution } from "../execution.js";
import { readFileSync } from "node:fs";
import { metadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { headerFromRpc, headerHash, blake2b256 } from "../substrate.js";
import { fromHex, toHex } from "../scale.js";
import type { MidnightSource } from "../source.js";

const request = { blockHash: fixture.hash.slice(2), header: headerFromRpc(fixture.header), extrinsicIndex: 4, txHash: "e273d480e57b3315937c8929fbc3c11ab798d42b4ff6c0b88172856dec6b7d58" };
const node = (change: (answers: unknown[]) => void = () => {}): MidnightSource["node"] => ({
  async call() { throw new Error("unexpected individual RPC"); },
  async batch<T>(calls: [string, unknown[]][]) {
    expect(calls.map(([method]) => method)).toEqual(["chain_getHeader", "state_getReadProof", "state_getReadProof"]);
    expect(calls[0]![1]).toEqual([fixture.header.parentHash]);
    const answers = structuredClone([fixture.parent.header, fixture.parent.proof, fixture.executionProof]);
    change(answers);
    return answers as T[];
  },
});

const codec = getDynamicBuilder(getLookupFn(unifyMetadata(metadata.dec(readFileSync(new URL("../../runtime/1000300.scale", import.meta.url)))))).buildStorage("System", "Events").value;
const digest = (value: string) => `0x${toHex(blake2b256(fromHex(value, "test witness")))}`;
function changedValue(proof: string[], root: string, oldValue: string, value: string) {
  const nodes = [...proof];
  const index = nodes.indexOf(oldValue);
  expect(index).toBeGreaterThanOrEqual(0);
  nodes[index] = value;
  const pending = [[digest(oldValue), digest(value)]];
  for (let at = 0; at < pending.length; at++) {
    const [oldHash, newHash] = pending[at]!;
    if (root === oldHash) root = newHash!;
    for (let i = 0; i < nodes.length; i++) {
      const before = nodes[i]!;
      const after = before.replaceAll(oldHash!.slice(2), newHash!.slice(2));
      if (after !== before) { nodes[i] = after; pending.push([digest(before), digest(after)]); }
    }
  }
  return { nodes, root };
}

describe("authenticated Midnight execution after finalized inclusion", () => {
  it("proves the executing parent runtime, matching events and timestamp at the target block", async () => {
    const result = await verifyExecution(node(), request);
    expect(result.runtimeSpecVersion).toBe(1000300);
    expect(result.timestamp).toBe(Number(Buffer.from(fixture.timestamp.slice(2), "hex").readBigUInt64LE()));
  });

  it("does not accept a successful neighbor extrinsic or a different transaction hash", async () => {
    await expect(verifyExecution(node(), { ...request, extrinsicIndex: 3 })).rejects.toThrow();
    await expect(verifyExecution(node(), { ...request, txHash: "00".repeat(32) })).rejects.toThrow();
  });

  it("rejects authenticated partial execution and failed dispatch events", async () => {
    for (const mode of ["partial", "failed"] as const) {
      const events = codec.dec(fixture.events) as any[];
      for (const record of events.filter((event) => event.phase.type === "ApplyExtrinsic" && event.phase.value === 4)) {
        if (mode === "partial" && record.event.type === "Midnight" && record.event.value.type === "TxApplied") record.event.value.type = "TxPartialSuccess";
        if (mode === "failed" && record.event.type === "System" && record.event.value.type === "ExtrinsicSuccess") record.event.value = { type: "ExtrinsicFailed", value: { dispatch_error: { type: "Other", value: undefined }, dispatch_info: record.event.value.value.dispatch_info } };
      }
      const changed = changedValue(fixture.executionProof.proof, fixture.header.stateRoot, fixture.events, `0x${Buffer.from(codec.enc(events)).toString("hex")}`);
      const header = { ...request.header, stateRoot: fromHex(changed.root, "synthetic state root") };
      const blockHash = toHex(headerHash(header));
      const answers = node((answers: any[]) => { answers[2] = { at: `0x${blockHash}`, proof: changed.nodes }; });
      await expect(verifyExecution(answers, { ...request, header, blockHash })).rejects.toThrow(/full execution/);
    }
  });

  it("uses the parent code when the target post-state contains another runtime", async () => {
    const code = fixture.proof.proof.find((value) => value.includes("39568eeb0802fa59d74ac0bc5c7ab62fc05c23ea947937458a4b011558516138"))!;
    const replacement = code.replace("39568eeb0802fa59d74ac0bc5c7ab62fc05c23ea947937458a4b011558516138", "aa".repeat(32));
    const combined = [...new Set([...fixture.proof.proof, ...fixture.executionProof.proof])];
    const changed = changedValue(combined, fixture.header.stateRoot, code, replacement);
    expect(provedValue(changed.root, "0x3a636f6465", changed.nodes, true)).toBe(`0x${"aa".repeat(32)}`);
    const header = { ...request.header, stateRoot: fromHex(changed.root, "upgrade state root") };
    const blockHash = toHex(headerHash(header));
    const answers = node((answers: any[]) => { answers[2] = { at: `0x${blockHash}`, proof: changed.nodes }; });
    expect((await verifyExecution(answers, { ...request, header, blockHash })).runtimeSpecVersion).toBe(1000300);
  });

  it("refuses substituted parents, runtime witnesses, event witnesses and proof block identifiers", async () => {
    for (const change of [
      (a: any[]) => { a[0].number = "0x1"; },
      (a: any[]) => { a[1].proof = []; },
      (a: any[]) => { a[2].proof = []; },
      (a: any[]) => { a[1].at = fixture.hash; },
      (a: any[]) => { a[2].at = fixture.header.parentHash; },
    ]) await expect(verifyExecution(node(change), request)).rejects.toThrow();
  });
});
