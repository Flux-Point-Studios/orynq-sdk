import { describe, expect, it } from "vitest";
import { replaceProofValue } from "./proof-node.js";
import fixture from "./fixtures/storage-proof-mainnet.json";
import { provedValue } from "../storage-proof.js";
import { verifyExecution, verifyBlockEffects } from "../execution.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { metadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { headerFromRpc, headerHash, type RpcHeader } from "../substrate.js";
import { fromHex, toHex } from "../scale.js";
import { SourceConflict, type MidnightSource } from "../source.js";
import { CODE_KEYS, FORK, PENDING_CODE_KEYS, SYSTEM_EVENTS, eventsCodec, forkBlock, forkNode, forkSends, recorded } from "./fork-chain.js";

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

describe("authenticated Midnight execution after finalized inclusion", () => {
  it("proves the executing parent runtime, matching events and timestamp at the target block", async () => {
    const result = await verifyExecution(node(), request);
    expect(result.runtimeSpecVersion).toBe(1000300);
    expect(result.timestamp).toBe(Number(Buffer.from(fixture.timestamp.slice(2), "hex").readBigUInt64LE()));
  });

  it("authenticates the runtime when the transport can return only a compact code-path witness", async () => {
    const original = node(), bounded: MidnightSource["node"] = { ...original, async batch<T>(calls: [string, unknown[]][]) {
      if ((calls[1]![1][0] as string[]).includes("0x3a636f6465")) throw new Error("Raw runtime value exceeds the transport budget");
      expect(calls[1]![1]).toEqual([["0x3a636f646500", "0x3a70656e64696e675f636f646500"], fixture.header.parentHash]);
      return original.batch<T>(calls);
    } };
    expect((await verifyExecution(bounded, request)).runtimeSpecVersion).toBe(1000300);
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
      const changed = replaceProofValue(fixture.executionProof.proof, fixture.header.stateRoot, fixture.events, `0x${Buffer.from(codec.enc(events)).toString("hex")}`);
      const header = { ...request.header, stateRoot: fromHex(changed.root, "synthetic state root") };
      const blockHash = toHex(headerHash(header));
      const answers = node((answers: any[]) => { answers[2] = { at: `0x${blockHash}`, proof: changed.nodes }; });
      await expect(verifyExecution(answers, { ...request, header, blockHash })).rejects.toThrow(/execution/);
    }
  });

  it("uses the parent code when the target post-state contains another runtime", async () => {
    const code = fixture.proof.proof.find((value) => value.includes("39568eeb0802fa59d74ac0bc5c7ab62fc05c23ea947937458a4b011558516138"))!;
    const replacement = code.replace("39568eeb0802fa59d74ac0bc5c7ab62fc05c23ea947937458a4b011558516138", "aa".repeat(32));
    const combined = [...new Set([...fixture.proof.proof, ...fixture.executionProof.proof])];
    const changed = replaceProofValue(combined, fixture.header.stateRoot, code, replacement);
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


describe("authenticated block execution outcomes", () => {
  const withEvents = (edit: (events: any[]) => void) => {
    const events = codec.dec(fixture.events) as any[];
    edit(events);
    const changed = replaceProofValue(fixture.executionProof.proof, fixture.header.stateRoot, fixture.events, `0x${Buffer.from(codec.enc(events)).toString("hex")}`);
    const header = { ...request.header, stateRoot: fromHex(changed.root, "synthetic state root") };
    const blockHash = toHex(headerHash(header));
    return { node: node((answers: any[]) => { answers[2] = { at: `0x${blockHash}`, proof: changed.nodes }; }), request: { ...request, header, blockHash } };
  };
  const target = (event: any) => event.phase.type === "ApplyExtrinsic" && event.phase.value === 4;

  it("shares one authenticated block proof across execution classifications", async () => {
    const effects = await verifyBlockEffects(node(), request);
    expect(effects.runtimeSpecVersion).toBe(1000300);
    expect(effects.timestamp).toBe(Number(Buffer.from(fixture.timestamp.slice(2), "hex").readBigUInt64LE()));
    expect(effects.outcome(4, request.txHash)).toBe("SUCCESS");
    expect(() => effects.outcome(3, request.txHash)).toThrow();
  });

  it.each(["partial", "failed"] as const)("authenticates explicit %s outcomes", async (mode) => {
    const answer = withEvents(events => {
      for (let i = events.length - 1; i >= 0; i--) {
        const record = events[i];
        if (!target(record)) continue;
        if (mode === "failed" && record.event.type === "Midnight") events.splice(i, 1);
        if (mode === "partial" && record.event.type === "Midnight" && record.event.value.type === "TxApplied") record.event.value.type = "TxPartialSuccess";
        if (mode === "failed" && record.event.type === "System" && record.event.value.type === "ExtrinsicSuccess") record.event.value = { type: "ExtrinsicFailed", value: { dispatch_error: { type: "Other", value: undefined }, dispatch_info: record.event.value.value.dispatch_info } };
      }
    });
    const effects = await verifyBlockEffects(answer.node, answer.request);
    expect(effects.outcome(4, request.txHash)).toBe(mode === "partial" ? "PARTIAL_SUCCESS" : "FAILURE");
    await expect(verifyExecution(answer.node, answer.request)).rejects.toThrow(/execution/);
  });

  it.each(["missing", "wrong-hash", "duplicate-system", "duplicate-midnight", "failed-with-effects"])("refuses ambiguous authenticated events: %s", async (mode) => {
    const answer = withEvents(events => {
      const applied = events.find(record => target(record) && record.event.type === "Midnight" && record.event.value.type === "TxApplied");
      const system = events.find(record => target(record) && record.event.type === "System" && record.event.value.type === "ExtrinsicSuccess");
      if (mode === "missing") events.splice(events.indexOf(applied), 1);
      if (mode === "wrong-hash") applied.event.value.value = "0x" + "aa".repeat(32);
      if (mode === "duplicate-system") events.push(structuredClone(system));
      if (mode === "duplicate-midnight") events.push(structuredClone(applied));
      if (mode === "failed-with-effects") system.event.value = { type: "ExtrinsicFailed", value: { dispatch_error: { type: "Other", value: undefined }, dispatch_info: system.event.value.value.dispatch_info } };
    });
    const effects = await verifyBlockEffects(answer.node, answer.request);
    expect(() => effects.outcome(4, request.txHash)).toThrow();
    await expect(verifyExecution(answer.node, answer.request)).rejects.toThrow();
  });

  it("refuses invalid outcome targets and substituted execution witnesses", async () => {
    const effects = await verifyBlockEffects(node(), request);
    for (const index of [-1, 1.5, NaN]) expect(() => effects.outcome(index, request.txHash)).toThrow();
    expect(() => effects.outcome(4, "0x" + request.txHash)).toThrow();
    await expect(verifyBlockEffects(node((answers: any[]) => { answers[2].proof = []; }), request)).rejects.toThrow();
  });
});


it("holds on authenticated applications outside the body-bound send list", async () => {
  const events = codec.dec(fixture.events) as any[];
  const sends = events.filter(record => record.event.type === "Midnight" && ["TxApplied", "TxPartialSuccess"].includes(record.event.value.type)).map(record => ({ extrinsicIndex: record.phase.value, txHash: record.event.value.value.slice(2) }));
  const effects = await verifyBlockEffects(node(), request);
  expect(() => effects.assertApplications(sends)).not.toThrow();
  expect(() => effects.assertApplications(sends.slice(1))).toThrow(/unmatched|application/i);
  expect(() => effects.assertApplications(sends.map((send, i) => i ? send : { ...send, txHash: "aa".repeat(32) }))).toThrow(/unmatched|application/i);
  expect(() => effects.assertApplications([...sends, sends[0]!])).toThrow();
});

describe("authenticated execution across the Ledger 9 runtime upgrade (mainnet, recorded)", () => {
  const codeHash2001100 = "87d0c023b954ad788bba2c065320fe19f172f374adbe86ebc0a99bc1ce3fe1de";

  it("pins the 2001100 metadata the post-upgrade events decode under, and the 1000300 codec cannot read them", () => {
    const bytes = readFileSync(new URL("../../runtime/2001100.scale", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("452359103e3598e3720d28b0537f0bb89f1b8614de816928f4a3fc8732650afb");
    const { blockHash } = forkBlock(FORK.firstLedger9);
    const proof = recorded<{ proof: string[] }>("state_getReadProof", [[SYSTEM_EVENTS, "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb"], `0x${blockHash}`]);
    const events = provedValue(`0x${toHex(forkBlock(FORK.firstLedger9).header.stateRoot)}`, SYSTEM_EVENTS, proof.proof);
    const names = (eventsCodec(2001100).dec(events) as any[]).map(({ event }) => `${event.type}.${event.value.type}`);
    expect(names).toEqual(expect.arrayContaining(["CNightObservation.DustReapplyStarted", "MultiBlockMigrations.UpgradeStarted"]));
    expect(() => eventsCodec(1000300).dec(events)).toThrow();
  });

  it("executes the set_code block 3346138 under 1000300, with every body-bound send applied", async () => {
    const effects = await verifyBlockEffects(forkNode().node, forkBlock(FORK.setCode));
    expect(effects.runtimeSpecVersion).toBe(1000300);
    expect(forkSends(FORK.setCode)).toHaveLength(7);
    expect(() => effects.assertApplications(forkSends(FORK.setCode))).not.toThrow();
  });

  it("executes 3346139 under 2001100, the code its parent holds as :pending_code, and decodes its events", async () => {
    const effects = await verifyBlockEffects(forkNode().node, forkBlock(FORK.firstLedger9));
    expect(effects.runtimeSpecVersion).toBe(2001100);
    expect(effects.timestamp).toBe(Date.parse("2026-11-06T20:51:24Z"));
    expect(() => effects.assertApplications([])).not.toThrow();
  });

  it("executes 3346140 under 2001100, the code its parent holds as :code", async () => {
    const effects = await verifyBlockEffects(forkNode().node, forkBlock(FORK.firstLedger9 + 1));
    expect(effects.runtimeSpecVersion).toBe(2001100);
    expect(effects.timestamp).toBe(Date.parse("2026-11-06T20:51:30Z"));
  });

  it("refuses a parent witness that omits :pending_code, so 3346139 cannot pass as a 1000300 block", async () => {
    const parent = forkBlock(FORK.setCode).blockHash;
    const codeOnly = recorded<{ at: string; proof: string[] }>("state_getReadProof", [[CODE_KEYS], `0x${parent}`]);
    const { node } = forkNode((method, params, answer) => method === "state_getReadProof" && params[1] === `0x${parent}` ? codeOnly : answer);
    await expect(verifyBlockEffects(node, forkBlock(FORK.firstLedger9))).rejects.toThrow(SourceConflict);
  });

  it("refuses executing code outside the runtime table, as it refuses any runtime without an entry", async () => {
    const child = forkBlock(FORK.firstLedger9 + 1), parentHash = child.rpcHeader.parentHash;
    const parent = recorded<RpcHeader>("chain_getHeader", [parentHash]);
    const forged = new Map<string, { root: string; nodes: string[] }>();
    const forge = (keys: string[]) => {
      const id = JSON.stringify(keys);
      if (!forged.has(id)) {
        const { proof } = recorded<{ proof: string[] }>("state_getReadProof", [keys, parentHash]);
        const node = proof.find(value => value.includes(codeHash2001100))!;
        forged.set(id, replaceProofValue(proof, parent.stateRoot, node, node.replace(codeHash2001100, "aa".repeat(32))));
      }
      return forged.get(id)!;
    };
    const forgedParent = { ...parent, stateRoot: forge([CODE_KEYS, PENDING_CODE_KEYS]).root };
    const forgedParentHash = `0x${toHex(headerHash(headerFromRpc(forgedParent)))}`;
    const header = headerFromRpc({ ...child.rpcHeader, parentHash: forgedParentHash });
    const blockHash = toHex(headerHash(header));
    const { node } = forkNode((method, params, answer) => {
      if (method === "chain_getHeader" && params[0] === forgedParentHash) return forgedParent;
      if (method === "state_getReadProof" && params[1] === forgedParentHash) {
        const proof = forge(params[0] as string[]);
        return proof.root === forgedParent.stateRoot ? { at: forgedParentHash, proof: proof.nodes } : undefined;
      }
      if (method === "state_getReadProof" && params[1] === `0x${blockHash}`) return { ...recorded<object>(method, [params[0], `0x${child.blockHash}`]), at: `0x${blockHash}` };
      return answer;
    });
    await expect(verifyBlockEffects(node, { blockHash, header })).rejects.toThrow(/runtime code is not supported/);
  });
});
