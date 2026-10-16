import { beforeEach, describe, expect, it } from "vitest";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as L from "@midnight-ntwrk/ledger-v8";
import {
  authorKey,
  createAuthorKeyFile,
  decodeAnchorTransaction,
  deriveSalt,
  entryCommitment,
  hiddenDigest,
  hidingCommitment,
  readAuthorSecret,
  registryInitialState,
  unprovenRegistryCall,
} from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { encodedWindows, windowHits } from "../../anchors-midnight/src/__tests__/privacy-scan.js";
import { MAINNET_AUTHOR_KEYS, MAINNET_SALT_KEY_IDS } from "../src/custody.js";
import { registryOperator, type OperatorOptions } from "../src/operator.js";
import { bytes32, chain, deployed, fresh, hex, wallet } from "./fakes.js";
import { prover } from "./prover.js";

let authorKeyFile: string;
let saltKeyFile: string;
beforeEach(() => {
  authorKeyFile = fresh("author.key");
  createAuthorKeyFile(authorKeyFile);
  saltKeyFile = fresh("salt.key");
  createAuthorKeyFile(saltKeyFile);
});

function setup(overrides: Partial<OperatorOptions> & { tamper?: (tx: L.FinalizedTransaction) => L.FinalizedTransaction; net?: ReturnType<typeof chain> } = {}) {
  const net = overrides.net ?? chain();
  const journalPath = fresh("journal.sqlite");
  const w = wallet(net, () => journalPath, overrides.tamper);
  const operator = registryOperator({
    network: "preprod",
    wallet: w,
    source: net.source,
    prover,
    journalPath,
    authorKeyFile,
    saltKeyFile,
    registry: deployed.address,
    pollMillis: 1,
    ...overrides,
  });
  return { operator, wallet: w, net, journalPath };
}

const entry = () => ({ rootHash: bytes32(), manifestHash: bytes32(), merkleRoot: bytes32() });

describe("registryOperator.anchor", () => {
  it("journals the final bytes' hash before submitting them, and returns once the indexer shows the anchor landed", async () => {
    const { operator, wallet: w } = setup();
    const e = entry();
    const receipt = await operator.anchor(e);
    expect(w.submitted).toHaveLength(1);
    const tx = w.submitted[0]!;
    expect(w.rowsAtSubmit).toEqual([[{ tx_hash: tx.transactionHash(), state: "pending" }]]);
    expect(receipt).toMatchObject({
      network: "preprod",
      registry: deployed.address,
      txHash: tx.transactionHash(),
      blockHeight: 500,
      kind: 1,
      commitment: hex(entryCommitment(e)),
      attribute: "00".repeat(32),
      author: hex(authorKey(readAuthorSecret(authorKeyFile))),
    });
    const decoded = decodeAnchorTransaction(tx.serialize(), [deployed.address]);
    expect(decoded.calls).toEqual([{ address: deployed.address, entryPoint: "anchor", kind: 1, commitment: receipt.commitment, attribute: "00".repeat(32), author: receipt.author }]);
    operator.close();
  });

  it("answers a repeat of the same entry from the journal, preparing and submitting nothing", async () => {
    const { operator, wallet: w } = setup();
    const e = entry();
    const first = await operator.anchor(e);
    expect(await operator.anchor(e)).toEqual(first);
    expect(w.submitted).toHaveLength(1);
    operator.close();
  });

  it("refuses final bytes that are not exactly the intended anchor, journals nothing, submits nothing and releases their DUST", async () => {
    const other = unprovenRegistryCall({
      networkId: "preprod",
      address: deployed.address,
      state: deployed.state,
      call: { circuit: "anchor", args: [bytes32(), 1n] },
      witnesses: { authorSecret: bytes32() },
      ttl: new Date(Date.now() + 600e3),
    });
    const swapped = (await prover.prove(other.tx)).bind();
    const { operator, wallet: w, journalPath } = setup({ tamper: () => swapped });
    await expect(operator.anchor(entry())).rejects.toThrow(/the final bytes do not carry exactly the intended anchor/);
    expect(w.submitted).toHaveLength(0);
    expect(w.discarded).toEqual([swapped.transactionHash()]);
    const db = new DatabaseSync(journalPath);
    expect(db.prepare("select count(*) as n from attempts").get()).toEqual({ n: 0 });
    db.close();
    operator.close();
  });

  it("refuses to prepare anything while the node runs a runtime the decoder does not know", async () => {
    const { operator, wallet: w } = setup({ net: chain({ spec: 1000400 }) });
    await expect(operator.anchor(entry())).rejects.toThrow(/the preprod node runs runtime 1000400, which is not one this submitter knows \(1000300\)/);
    expect(w.submitted).toHaveLength(0);
    operator.close();
  });

  it.each(["2.1.0", "1.0.400"] as const)("refuses to write to an address that holds no contract, however node %s answers for one", async (node) => {
    const { operator, wallet: w } = setup({ registry: "cd".repeat(32), net: chain({ node }) });
    await expect(operator.anchor(entry())).rejects.toThrow(`the preprod node holds no contract at ${"cd".repeat(32)}`);
    expect(w.submitted).toHaveLength(0);
    operator.close();
  });

  it("refuses to write to an address whose on-chain state is not the immutable registry", async () => {
    const mutable = registryInitialState();
    mutable.maintenanceAuthority = new L.ContractMaintenanceAuthority([], 0, 0n);
    const { operator, wallet: w } = setup({ net: chain({ state: mutable }) });
    await expect(operator.anchor(entry())).rejects.toThrow(/threshold must be exactly 1, got 0/);
    expect(w.submitted).toHaveLength(0);
    operator.close();
  });
});

describe("registryOperator.anchorHiding", () => {
  it("commits in-circuit to the entry under a salt derived from the salt key, and returns the opening only to its caller", async () => {
    const { operator, wallet: w } = setup();
    const e = entry();
    const attribute = bytes32();
    const receipt = await operator.anchorHiding(e, attribute);
    const digest = hiddenDigest(e, attribute);
    const salt = deriveSalt(readAuthorSecret(saltKeyFile), digest);
    expect(receipt).toMatchObject({ kind: 2, attribute: hex(attribute), commitment: hex(hidingCommitment(digest, salt)) });
    expect(receipt.opening).toEqual({ rootHash: hex(e.rootHash), manifestHash: hex(e.manifestHash), merkleRoot: hex(e.merkleRoot), salt: hex(salt) });
    const sent = w.submitted[0]!.serialize();
    expect(windowHits(sent, attribute)).toBe(encodedWindows(attribute));
    for (const secret of [e.rootHash, e.manifestHash, e.merkleRoot, salt, readAuthorSecret(authorKeyFile), readAuthorSecret(saltKeyFile)]) expect(windowHits(sent, secret)).toBe(0);
    operator.close();
  });

  it("refuses without a salt key, before preparing anything", async () => {
    const { operator, wallet: w } = setup({ saltKeyFile: undefined });
    await expect(operator.anchorHiding(entry(), bytes32())).rejects.toThrow(/anchorHiding needs a salt key file/);
    expect(w.submitted).toHaveLength(0);
    operator.close();
  });
});

const MINUTE = 60_000;
const EXPIRED = "the journalled anchor expired without landing; rerun to prepare new bytes";
const rows = (journalPath: string) => {
  const db = new DatabaseSync(journalPath);
  const out = db.prepare("select tx_hash, state from attempts order by id").all();
  db.close();
  return out;
};

describe("registryOperator's anchors a human confirms", () => {
  // An operator over `net` and the journal at `journalPath` whose wallet `submit` replaces.
  const sharing = (net: ReturnType<typeof chain>, journalPath: string, submit: (tx: L.FinalizedTransaction) => Promise<void>) => {
    const w = { ...wallet(net, () => journalPath), submit };
    return registryOperator({ network: "preprod", wallet: w, source: net.source, prover, journalPath, authorKeyFile, saltKeyFile, registry: deployed.address, pollMillis: 1 });
  };

  it("prepares the final bytes of a kind-1 anchor and everything a human must see, journalling and submitting nothing", async () => {
    const { operator, wallet: w, journalPath } = setup();
    const e = entry();
    const prepared = await operator.prepare({ kind: 1, entry: e });
    const tx = L.Transaction.deserialize("signature", "proof", "binding", prepared.bytes);
    expect(prepared).toMatchObject({
      network: "preprod",
      registry: deployed.address,
      author: hex(authorKey(readAuthorSecret(authorKeyFile))),
      kind: 1,
      commitment: hex(entryCommitment(e)),
      attribute: "00".repeat(32),
      txHash: tx.transactionHash(),
      declaredFee: 0n,
      payer: w.addresses.unshielded,
    });
    expect(prepared.journal).toBeUndefined();
    expect(decodeAnchorTransaction(prepared.bytes, [deployed.address]).calls).toEqual([
      { address: deployed.address, entryPoint: "anchor", kind: 1, commitment: prepared.commitment, attribute: "00".repeat(32), author: prepared.author },
    ]);
    expect([w.submitted.length, rows(journalPath).length]).toEqual([0, 0]);
    operator.close();
  });

  it("prepares a kind-2 anchor committing in-circuit under the salt key, with its attribute published", async () => {
    const { operator, wallet: w } = setup();
    const e = entry();
    const attribute = bytes32();
    const prepared = await operator.prepare({ kind: 2, entry: e, attribute });
    const salt = deriveSalt(readAuthorSecret(saltKeyFile), hiddenDigest(e, attribute));
    expect(prepared).toMatchObject({ kind: 2, attribute: hex(attribute), commitment: hex(hidingCommitment(hiddenDigest(e, attribute), salt)) });
    expect(decodeAnchorTransaction(prepared.bytes, [deployed.address]).calls[0]).toMatchObject({ entryPoint: "anchor_hiding", kind: 2, commitment: prepared.commitment, attribute: hex(attribute) });
    for (const secret of [e.rootHash, e.manifestHash, e.merkleRoot, salt]) expect(windowHits(prepared.bytes, secret)).toBe(0);
    expect(w.submitted).toHaveLength(0);
    expect((await operator.submit(prepared)).txHash).toBe(prepared.txHash);
    operator.close();
  });

  it("submits exactly the confirmed bytes through the journal and returns the anchor once it landed", async () => {
    const { operator, wallet: w, journalPath } = setup();
    const prepared = await operator.prepare({ kind: 1, entry: entry() });
    const receipt = await operator.submit(prepared);
    expect(w.submitted.map((t) => hex(t.serialize()))).toEqual([hex(prepared.bytes)]);
    expect(w.rowsAtSubmit).toEqual([[{ tx_hash: prepared.txHash, state: "pending" }]]);
    expect(receipt).toEqual({ network: "preprod", registry: deployed.address, txHash: prepared.txHash, blockHeight: 500, blockHash: "ab".repeat(32), kind: 1, commitment: prepared.commitment, attribute: "00".repeat(32), author: prepared.author });
    expect(rows(journalPath)).toEqual([{ tx_hash: prepared.txHash, state: "landed" }]);
    operator.close();
  });

  it("sends only bytes that hash to the confirmed transaction and carry exactly the confirmed anchor, refusing others before the journal", async () => {
    const { operator, wallet: w, journalPath } = setup();
    const e = entry();
    const prepared = await operator.prepare({ kind: 1, entry: e });
    const again = await operator.prepare({ kind: 1, entry: e });
    const other = await operator.prepare({ kind: 1, entry: entry() });
    const sentNothing = () => expect([w.submitted.length, rows(journalPath).length]).toEqual([0, 0]);
    await expect(operator.submit({ ...prepared, bytes: again.bytes })).rejects.toThrow(`the bytes hash to ${again.txHash}, not the confirmed ${prepared.txHash}; nothing was sent`);
    sentNothing();
    await expect(operator.submit({ ...prepared, bytes: other.bytes, txHash: other.txHash })).rejects.toThrow("the final bytes do not carry exactly the intended anchor; nothing was submitted");
    sentNothing();
    expect((await operator.submit(prepared)).txHash).toBe(prepared.txHash);
    operator.close();
  });

  it("never sends a second transaction for one anchor: bytes prepared after one is journalled are discarded", async () => {
    const { operator, wallet: w } = setup();
    const e = entry();
    const first = await operator.submit(await operator.prepare({ kind: 1, entry: e }));
    const second = await operator.prepare({ kind: 1, entry: e });
    await expect(operator.submit(second)).rejects.toThrow(`this anchor is already journalled on preprod: ${first.txHash} (landed); the prepared bytes were discarded`);
    expect(w.submitted).toHaveLength(1);
    expect(w.discarded).toEqual([second.txHash]);
    operator.close();
  });

  it("hands back an anchor that landed while its readback failed, rebuilt from the journal's bytes, whose submit returns it and sends nothing", async () => {
    const { operator, wallet: w, net, journalPath } = setup();
    const e = entry();
    expect(await operator.journalled({ kind: 1, entry: e })).toBeNull();
    let lost = 1;
    const lossy = registryOperator({
      network: "preprod",
      wallet: w,
      source: {
        ...net.source,
        indexer: {
          ...net.source.indexer,
          async transactions(hash: string) {
            const found = await net.source.indexer.transactions(hash);
            if (found.length > 0 && lost-- > 0) throw new Error("test indexer: HTTP 502: Bad Gateway");
            return found;
          },
        },
      },
      prover,
      journalPath,
      authorKeyFile,
      registry: deployed.address,
      pollMillis: 1,
    });
    const prepared = await lossy.prepare({ kind: 1, entry: e });
    await expect(lossy.submit(prepared)).rejects.toThrow(/HTTP 502/);
    lossy.close();

    const resumed = await operator.journalled({ kind: 1, entry: e });
    expect(resumed).toEqual({ ...prepared, journal: { state: "landed", broadcasts: 1, expired: false } });
    expect(await operator.submit(resumed!)).toMatchObject({ txHash: prepared.txHash, blockHeight: 500 });
    expect(w.submitted.map((t) => t.transactionHash())).toEqual([prepared.txHash]);
    expect(w.discarded).toEqual([]);
    operator.close();
  });

  it("hands back an anchor whose broadcast a proxy refused, and sends exactly those bytes again once confirmed before their TTL", async () => {
    const { operator, wallet: w, net, journalPath } = setup();
    const e = entry();
    const proxy = sharing(net, journalPath, async () => {
      throw new Error("test node: HTTP 403: Forbidden");
    });
    const refused = await proxy.prepare({ kind: 1, entry: e });
    await expect(proxy.submit(refused)).rejects.toThrow(/HTTP 403/);
    proxy.close();
    net.advance(10 * MINUTE);
    const resumed = await operator.journalled({ kind: 1, entry: e });
    expect(resumed).toEqual({ ...refused, journal: { state: "pending", broadcasts: 0, expired: false } });
    expect((await operator.submit(resumed!)).txHash).toBe(refused.txHash);
    expect(w.submitted.map((t) => hex(t.serialize()))).toEqual([hex(refused.bytes)]);
    operator.close();
  });

  it("hands back an anchor past its TTL marked expired, sends nothing for it and refuses once the chain retires it; past the margin it hands back none", async () => {
    const { operator, wallet: w, net, journalPath } = setup();
    const e = entry();
    const proxy = sharing(net, journalPath, async () => {
      throw new Error("test node: HTTP 403: Forbidden");
    });
    const refused = await proxy.prepare({ kind: 1, entry: e });
    await expect(proxy.submit(refused)).rejects.toThrow(/HTTP 403/);
    proxy.close();
    net.advance(15 * MINUTE + 4 * MINUTE);
    const resumed = await operator.journalled({ kind: 1, entry: e });
    expect(resumed?.journal).toEqual({ state: "pending", broadcasts: 0, expired: true });
    const submitted = operator.submit(resumed!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    net.advance(2 * MINUTE);
    await expect(submitted).rejects.toThrow(EXPIRED);
    expect(w.submitted).toEqual([]);
    expect(rows(journalPath)).toEqual([{ tx_hash: refused.txHash, state: "failed" }]);
    expect(await operator.journalled({ kind: 1, entry: e })).toBeNull();
    operator.close();
  });

  it("refuses journalled bytes that do not carry exactly the anchor asked for before handing them back", async () => {
    const { operator, net, journalPath } = setup();
    const e = entry();
    const proxy = sharing(net, journalPath, async () => {
      throw new Error("test node: HTTP 403: Forbidden");
    });
    await expect(proxy.submit(await proxy.prepare({ kind: 1, entry: e }))).rejects.toThrow(/HTTP 403/);
    proxy.close();
    const db = new DatabaseSync(journalPath);
    db.prepare("update attempts set bytes = ?").run((await operator.prepare({ kind: 1, entry: entry() })).bytes);
    db.close();
    await expect(operator.journalled({ kind: 1, entry: e })).rejects.toThrow("the final bytes do not carry exactly the intended anchor; nothing was submitted");
    operator.close();
  });

  it("discard releases the DUST of prepared bytes nobody confirmed", async () => {
    const { operator, wallet: w } = setup();
    const prepared = await operator.prepare({ kind: 1, entry: entry() });
    await operator.discard(prepared);
    expect([w.discarded, w.submitted.length]).toEqual([[prepared.txHash], 0]);
    operator.close();
  });

  it("refuses to prepare against an address whose on-chain state is not the immutable registry", async () => {
    const mutable = registryInitialState();
    mutable.maintenanceAuthority = new L.ContractMaintenanceAuthority([], 0, 0n);
    const { operator, wallet: w } = setup({ net: chain({ state: mutable }) });
    await expect(operator.prepare({ kind: 1, entry: entry() })).rejects.toThrow(/threshold must be exactly 1, got 0/);
    expect(w.submitted).toHaveLength(0);
    operator.close();
  });
});

describe("the FPS mainnet keys an operator off mainnet refuses by identity", () => {
  it("are the relay's author key and the salt key's id, as recorded when they were made", () => {
    expect(MAINNET_AUTHOR_KEYS).toEqual(["6a140f2346ec16bc587b506e3d447f05ddcc9bdd72778bee578767571b061f08"]);
    expect(MAINNET_SALT_KEY_IDS).toEqual(["448a1b1a6a289af3e432a9533af92250b92f8b7c91768f60b87a9de90df2ee41"]);
  });
});

describe("the author key", () => {
  it("is read from a file only its owner can read, never from anything else", () => {
    const open = fresh("open.key");
    createAuthorKeyFile(open);
    chmodSync(open, 0o644);
    expect(() => setup({ authorKeyFile: open })).toThrow(/open\.key can be read or written by group or others/);
  });

  it("is refused on mainnet in a process that carries Claude Code's environment, and only there", () => {
    const saved = { ...process.env };
    const agentless = () => {
      for (const name of Object.keys(process.env)) if (name === "CLAUDECODE" || name.startsWith("CLAUDE_CODE_")) delete process.env[name];
    };
    try {
      agentless();
      expect(() => setup({ network: "mainnet" }).operator.close()).not.toThrow();
      process.env.CLAUDECODE = "1";
      expect(() => setup({ network: "mainnet" })).toThrow(/refuses to load a mainnet author key in a process that carries Claude Code's environment/);
      agentless();
      process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
      expect(() => setup({ network: "mainnet" })).toThrow(/refuses to load a mainnet author key in a process that carries Claude Code's environment/);
      expect(() => setup({ network: "preprod" }).operator.close()).not.toThrow();
    } finally {
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });
});
