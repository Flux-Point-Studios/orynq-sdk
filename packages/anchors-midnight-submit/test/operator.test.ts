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
import { windowHits } from "../../anchors-midnight/src/__tests__/privacy-scan.js";
import { MAINNET_AUTHOR_KEYS, MAINNET_SALT_KEY_IDS } from "../src/custody.js";
import { registryOperator, type OperatorOptions } from "../src/operator.js";
import { bytes32, chain, deployed, fresh, hex, prover, wallet } from "./fakes.js";

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
    expect(windowHits(sent, attribute)).toBe(25);
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
