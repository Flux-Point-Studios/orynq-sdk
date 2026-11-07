import { describe, expect, it } from "vitest";
import * as L from "@midnightntwrk/ledger-v8";
import { readFileSync } from "node:fs";
import { anchorCallsIn, decodeAnchorTransaction } from "../anchor-transaction.js";
import { pureCircuits } from "../../contract/managed/contract/index.js";
import { fromHex } from "../scale.js";
import { midnightTransactionIn } from "../substrate.js";
import { NETWORK, deployedRegistry, finalBytes, hex, random32, unprovenRegistryCall } from "./registry-call.js";
import { eventsCodec } from "./fork-chain.js";
import ledger9Block from "./fixtures/mainnet-ledger9-block.json";

const failure = (f: () => unknown) => {
  try {
    f();
    return "decoded";
  } catch (e) {
    return (e as Error).message;
  }
};
const ttl = () => new Date(Date.now() + 3600e3);

describe("decodeAnchorTransaction reads an anchor from the transaction's own bytes", () => {
  const registry = deployedRegistry();
  const secret = random32();
  const author = hex(pureCircuits.author_key(secret));

  it("reads commitment, kind, author and a zero attribute from anchor(); the hash is the transaction's own", async () => {
    const commitment = random32();
    commitment[31] = 0;
    commitment[30] = 0;
    const bytes = await finalBytes(unprovenRegistryCall({ ...registry, call: { circuit: "anchor", args: [commitment, 1n] }, witnesses: { authorSecret: secret } }).tx);
    const decoded = decodeAnchorTransaction(bytes, [registry.address]);
    expect(decoded.txHash).toBe(L.Transaction.deserialize("signature", "proof", "binding", bytes).transactionHash());
    expect(decoded.touches).toEqual([]);
    expect(decoded.calls).toEqual([{ address: registry.address, entryPoint: "anchor", kind: 1, commitment: hex(commitment), attribute: "00".repeat(32), author }]);
  });

  it("reads the in-circuit commitment and the attribute from anchor_hiding()", async () => {
    const attribute = random32();
    const entry = { root_hash: random32(), manifest_hash: random32(), merkle_root: random32(), salt: random32() };
    const { tx, after } = unprovenRegistryCall({ ...registry, call: { circuit: "anchor_hiding", args: [attribute] }, witnesses: { authorSecret: secret, hiddenEntry: entry } });
    expect(decodeAnchorTransaction(await finalBytes(tx), [registry.address]).calls).toEqual([
      { address: registry.address, entryPoint: "anchor_hiding", kind: 2, commitment: hex(after.last_commitment), attribute: hex(attribute), author },
    ]);
  });

  it("reports no anchor in a transaction that calls no registry", async () => {
    const { tx } = unprovenRegistryCall({ ...registry, call: { circuit: "anchor", args: [random32(), 1n] }, witnesses: { authorSecret: secret } });
    expect(decodeAnchorTransaction(await finalBytes(tx), ["ab".repeat(32)]).calls).toEqual([]);
  });

  it("reports a maintenance update on a registry carried by the same transaction", () => {
    const { tx } = unprovenRegistryCall({ ...registry, call: { circuit: "anchor", args: [random32(), 1n] }, witnesses: { authorSecret: secret } });
    const intent = [...tx.intents!.values()][0]!.addMaintenanceUpdate(new L.MaintenanceUpdate(registry.address, [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority([], 0, 1n))], 0n));
    const both = L.Transaction.fromParts(NETWORK, undefined, undefined, intent);
    expect(anchorCallsIn(both, [registry.address], "tx").touches).toEqual([{ action: "maintenance", address: registry.address }]);
  });

  it("refuses bytes that are not the canonical encoding of the transaction they decode to", async () => {
    const { tx } = unprovenRegistryCall({ ...registry, call: { circuit: "anchor", args: [random32(), 1n] }, witnesses: { authorSecret: secret } });
    const bytes = await finalBytes(tx);
    expect(failure(() => decodeAnchorTransaction(new Uint8Array([...bytes, 0]), [registry.address]))).toMatch(/not a Midnight transaction: .*bytes remaining/);
    expect(failure(() => decodeAnchorTransaction(bytes.subarray(0, bytes.length - 3), [registry.address]))).toMatch(/not a Midnight transaction/);
  });
});

// The transcript is compared field by field with what the compiled circuits write; a call that
// writes anything else, or carries effects or a fallible part, is not an anchor. These calls
// could never be proven, so they are checked as the unproven transactions a submitter holds.
describe("anchorCallsIn refuses a registry call whose transcript is not the circuit's", () => {
  const registry = deployedRegistry();
  const call = () => unprovenRegistryCall({ ...registry, call: { circuit: "anchor", args: [random32(), 1n] }, witnesses: { authorSecret: random32() } });
  // Rebuilds the call's transaction with an edited guaranteed transcript.
  const rebuilt = (edit: (t: L.Transcript<L.AlignedValue>) => L.Transcript<L.AlignedValue> | undefined, fallible?: L.Transcript<L.AlignedValue>, entryPoint = "anchor") => {
    const { result, guaranteed } = call();
    const prototype = new L.ContractCallPrototype(
      registry.address,
      entryPoint,
      registry.state.operation("anchor")!,
      edit(guaranteed!),
      fallible,
      result.proofData.privateTranscriptOutputs,
      result.proofData.input,
      result.proofData.output,
      L.communicationCommitmentRandomness(),
      "anchor",
    );
    return L.Transaction.fromParts(NETWORK, undefined, undefined, L.Intent.new(ttl()).addCall(prototype));
  };
  const decode = (tx: L.UnprovenTransaction) => failure(() => anchorCallsIn(tx, [registry.address], "tx"));
  const push = (value: number, length: number): L.Op<L.AlignedValue> => ({
    push: { storage: true, value: { tag: "cell", content: { value: [new Uint8Array([value])], alignment: [{ tag: "atom", value: { tag: "bytes", length } }] } } },
  });
  const at = (index: number, op: L.Op<L.AlignedValue>) => (t: L.Transcript<L.AlignedValue>) => ({ ...t, program: t.program.map((o, i) => (i === index ? op : o)) });

  it("positive control: the unedited rebuild decodes", () => {
    expect(decode(rebuilt((t) => t))).toBe("decoded");
  });

  it("refuses kind 2 written through anchor()", () => {
    expect(decode(rebuilt(at(4, push(2, 1))))).toMatch(/anchor\(\) never writes kind 2/);
  });

  it("refuses a nonzero attribute written through anchor()", () => {
    expect(decode(rebuilt(at(7, push(9, 32))))).toMatch(/anchor\(\) writes a zero attribute/);
  });

  it("the ledger itself refuses a value atom with a trailing zero byte, so each value has one encoding", () => {
    const trailing: L.Op<L.AlignedValue> = {
      push: { storage: true, value: { tag: "cell", content: { value: [new Uint8Array([7, 0])], alignment: [{ tag: "atom", value: { tag: "bytes", length: 32 } }] } } },
    };
    expect(() => rebuilt(at(1, trailing))).toThrow(/failed alignment check \(value: \[0700\]; alignment: b32\)/);
  });

  it("refuses a transcript that writes another field, drops an op, or has no guaranteed part", () => {
    expect(decode(rebuilt(at(0, { push: { storage: false, value: { tag: "cell", content: { value: [new Uint8Array([1])], alignment: [{ tag: "atom", value: { tag: "bytes", length: 1 } }] } } } })))).toMatch(
      /transcript is not the registry circuit's/,
    );
    expect(decode(rebuilt((t) => ({ ...t, program: t.program.slice(0, -1) })))).toMatch(/transcript is not the registry circuit's/);
    expect(decode(rebuilt(() => undefined))).toMatch(/has no guaranteed transcript/);
  });

  it("refuses a transcript that claims effects", () => {
    expect(decode(rebuilt((t) => ({ ...t, effects: { ...t.effects, claimedNullifiers: ["ab".repeat(32)] } })))).toMatch(/claims effects/);
  });

  it("refuses a fallible transcript and an entry point the registry does not have", () => {
    const { guaranteed } = call();
    expect(decode(rebuilt((t) => t, guaranteed!))).toMatch(/carries a fallible transcript/);
    expect(decode(rebuilt((t) => t, undefined, "rewrite"))).toMatch(/entry point rewrite is not anchor or anchor_hiding/);
  });

  it("the template matches what both compiled circuits write, for any values", () => {
    for (let i = 0; i < 20; i++) {
      const value = random32();
      value.fill(0, 32 - (i % 4));
      const hiding = unprovenRegistryCall({
        ...registry,
        call: { circuit: "anchor_hiding", args: [value] },
        witnesses: { authorSecret: random32(), hiddenEntry: { root_hash: random32(), manifest_hash: random32(), merkle_root: random32(), salt: random32() } },
      });
      const anchor = unprovenRegistryCall({ ...registry, call: { circuit: "anchor", args: [value, BigInt(i % 2 ? 1 : 0)] }, witnesses: { authorSecret: random32() } });
      expect(anchorCallsIn(hiding.tx, [registry.address], "tx").calls[0]).toMatchObject({ kind: 2, attribute: hex(value) });
      expect(anchorCallsIn(anchor.tx, [registry.address], "tx").calls[0]).toMatchObject({ kind: i % 2 ? 1 : 0, commitment: hex(value) });
    }
  });
});

describe("golden: real transactions of other contracts", () => {
  const txs = (network: string) =>
    (JSON.parse(readFileSync(new URL(`./fixtures/${network}-blocks.json`, import.meta.url), "utf8")).blocks as Array<{ extrinsics: string[] }>).flatMap((b) =>
      b.extrinsics.flatMap((e) => {
        const tx = midnightTransactionIn(fromHex(e, "extrinsic"));
        return tx ? [tx] : [];
      }),
    );

  it("decodes every recorded mainnet and preprod transaction, with its own hash, and finds no anchor in any", () => {
    const all = [...txs("mainnet"), ...txs("preprod")];
    expect(all.length).toBe(8);
    for (const tx of all) {
      const decoded = decodeAnchorTransaction(tx, []);
      expect(decoded.txHash).toBe(L.Transaction.deserialize("signature", "proof", "binding", tx).transactionHash());
      expect(decoded.calls).toEqual([]);
    }
  });

  it("refuses mainnet 56a425d1, whose contract has an entry point named anchor, as a registry call", () => {
    const tx = txs("mainnet")[0]!;
    expect(decodeAnchorTransaction(tx, []).txHash).toMatch(/^56a425d1a6b15cb7/);
    const address = "9ef16e583fbc361ba6016b2751e6f26a5ab2bbf2f7102ea5e28dc8810696eb9c";
    expect(failure(() => decodeAnchorTransaction(tx, [address]))).toMatch(/transcript is not the registry circuit's/);
  });
});

describe("golden: registry transactions proven in-process with the committed prover keys", () => {
  const f = JSON.parse(readFileSync(new URL("./fixtures/registry-transactions.json", import.meta.url), "utf8"));
  const decode = (tx: string) => decodeAnchorTransaction(fromHex(tx, "tx"), [f.registry.address]);

  it("reads each proven call's anchor and hash from its final bytes", () => {
    expect(decode(f.anchor.tx)).toEqual({
      txHash: f.anchor.txHash,
      touches: [],
      calls: [{ address: f.registry.address, entryPoint: "anchor", kind: 1, commitment: f.anchor.commitment, attribute: "00".repeat(32), author: f.author.key }],
    });
    expect(decode(f.hiding.tx).calls).toEqual([
      { address: f.registry.address, entryPoint: "anchor_hiding", kind: 2, commitment: f.hiding.commitment, attribute: f.hiding.attribute, author: f.author.key },
    ]);
    expect(decode(f.stranger.tx).calls[0]!.author).toBe(f.stranger.key);
  });

  it("reports the registry's own deploy as a deploy aimed at the registry, and anchors in none of it", () => {
    expect(decode(f.registry.tx)).toEqual({ txHash: f.registry.txHash, calls: [], touches: [{ action: "deploy", address: f.registry.address }] });
  });
});

describe("decodeAnchorTransaction chooses the ledger by the transaction's header tag", () => {
  const extrinsic = fromHex(ledger9Block.extrinsics[3]!, "extrinsic");
  const v12 = midnightTransactionIn(extrinsic)!;
  const tag = (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, bytes.indexOf(0x28))).toString("latin1");
  const retagged = (bytes: Uint8Array, from: string, to: string) => {
    const text = Buffer.from(bytes).toString("latin1");
    expect(from.length).toBe(to.length);
    return new Uint8Array(Buffer.from(text.replace(from, to), "latin1"));
  };
  const deployed = "12981fb62370529be5e7b73acb905d3b5326307fbea4e705b3d94e7d3f2bac7c";

  it("reads mainnet 3346954's ledger 9 transaction[v12] with ledger 9, hashed as its TxApplied event names it", () => {
    expect(tag(v12)).toBe("midnight:transaction[v12]");
    const events = eventsCodec(2001100).dec(ledger9Block.events) as any[];
    const applied = events.filter(row => row.phase.type === "ApplyExtrinsic" && row.phase.value === 3 && row.event.type === "Midnight" && row.event.value.type === "TxApplied");
    expect(applied.map(row => row.event.value.value)).toEqual(["0x655fe3d8bd2c06494e2dc95c82883d1b7d235969b905939e6f57533b18dd84b8"]);
    expect(decodeAnchorTransaction(v12, ["438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736", deployed])).toEqual({
      txHash: "655fe3d8bd2c06494e2dc95c82883d1b7d235969b905939e6f57533b18dd84b8", calls: [], touches: [{ action: "deploy", address: deployed }],
    });
  });

  it("still reads a ledger 8 transaction[v9] with ledger 8", async () => {
    const registry = deployedRegistry();
    const bytes = await finalBytes(unprovenRegistryCall({ ...registry, call: { circuit: "anchor", args: [random32(), 1n] }, witnesses: { authorSecret: random32() } }).tx);
    expect(tag(bytes)).toBe("midnight:transaction[v9]");
    expect(decodeAnchorTransaction(bytes, [registry.address]).txHash).toBe(L.Transaction.deserialize("signature", "proof", "binding", bytes).transactionHash());
  });

  it.each(["v10", "v11", "v13", "v99"])("fails closed on a transaction tagged %s, which neither ledger defines", next => {
    expect(failure(() => decodeAnchorTransaction(retagged(v12, "transaction[v12]", `transaction[${next}]`), []))).toMatch(new RegExp(`transaction header midnight:transaction\\[${next}\\] is not one this decoder knows`));
  });

  it("fails closed on bytes with no Midnight transaction header", () => {
    expect(failure(() => decodeAnchorTransaction(retagged(v12, "midnight:", "midnyght:"), []))).toMatch(/transaction header .* is not one this decoder knows/);
  });
});
