import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as L from "@midnight-ntwrk/ledger-v8";
import { REGISTRY_VERIFIER_KEY_SHA256, registryInitialState } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { registryDeployer } from "../src/deployer.js";
import { chain, fresh, hex, wallet } from "./fakes.js";
import { prover } from "./prover.js";

function setup({ tamper, spec }: { tamper?: (tx: L.FinalizedTransaction) => L.FinalizedTransaction; spec?: number } = {}) {
  const net = chain(spec === undefined ? {} : { spec });
  const journalPath = fresh("journal.sqlite");
  const w = wallet(net, () => journalPath, tamper);
  const deployer = registryDeployer({ network: "preprod", wallet: w, source: net.source, prover, journalPath, pollMillis: 1 });
  const rows = () => {
    const db = new DatabaseSync(journalPath);
    const out = db.prepare("select tx_hash, state from attempts order by id").all();
    db.close();
    return out;
  };
  // A deploy journalled through a proxy that answered its broadcast with HTTP 403, so its bytes
  // never reached the node.
  const refusedByProxy = async () => {
    const proxy = registryDeployer({
      network: "preprod",
      wallet: {
        ...w,
        submit: async () => {
          throw new Error("test node: HTTP 403: Forbidden");
        },
      },
      source: net.source,
      prover,
      journalPath,
      pollMillis: 1,
    });
    const refused = await proxy.prepare();
    await expect(proxy.submit(refused)).rejects.toThrow(/HTTP 403/);
    proxy.close();
    return refused;
  };
  return { deployer, wallet: w, rows, net, journalPath, refusedByProxy };
}

const OUTDATED = `test node: author_submitExtrinsic failed: {"code":1010,"message":"Invalid Transaction","data":"the TTL is behind the chain's time"}`;

const MINUTE = 60_000;

const mutableDeploy = async () => {
  const mutable = registryInitialState();
  mutable.maintenanceAuthority = new L.ContractMaintenanceAuthority([], 0, 0n);
  const tx = L.Transaction.fromParts("preprod", undefined, undefined, L.Intent.new(new Date(Date.now() + 600e3)).addDeploy(new L.ContractDeploy(mutable)));
  return (await prover.prove(tx)).bind();
};

describe("registryDeployer", () => {
  it("prepares the final bytes and everything a human must see before they are sent, journalling and submitting nothing", async () => {
    const { deployer, wallet: w, rows } = setup();
    const prepared = await deployer.prepare();
    const tx = L.Transaction.deserialize("signature", "proof", "binding", prepared.bytes);
    const deploy = [...tx.intents!.values()][0]!.actions[0] as L.ContractDeploy;
    expect(prepared).toMatchObject({
      network: "preprod",
      address: String(deploy.address),
      txHash: tx.transactionHash(),
      authority: { committee: 0, threshold: 1, counter: "0" },
      verifierKeys: REGISTRY_VERIFIER_KEY_SHA256,
      declaredFee: 0n,
      runtime: 1000300,
    });
    expect(hex(deploy.initialState.serialize())).toBe(hex(registryInitialState().serialize()));
    expect(w.submitted).toHaveLength(0);
    expect(rows()).toEqual([]);
    deployer.close();
  });

  it("submits exactly the prepared bytes through the journal and reads the address back from the landed transaction", async () => {
    const { deployer, wallet: w, rows } = setup();
    const prepared = await deployer.prepare();
    const deployment = await deployer.submit(prepared);
    expect(w.submitted.map((t) => hex(t.serialize()))).toEqual([hex(prepared.bytes)]);
    expect(w.rowsAtSubmit).toEqual([[{ tx_hash: prepared.txHash, state: "pending" }]]);
    expect(deployment).toEqual({ network: "preprod", address: prepared.address, txHash: prepared.txHash, blockHeight: 500, blockHash: "ab".repeat(32) });
    expect(rows()).toEqual([{ tx_hash: prepared.txHash, state: "landed" }]);
    deployer.close();
  });

  it("sends only the bytes prepare() checked, at the transaction hash and address the human confirmed, and refuses others before the journal", async () => {
    const { deployer, wallet: w, rows } = setup();
    const prepared = await deployer.prepare();
    const sentNothing = () => expect([w.submitted.length, rows().length]).toEqual([0, 0]);
    const mutable = (await mutableDeploy()).serialize();
    await expect(deployer.submit({ ...prepared, bytes: mutable })).rejects.toThrow(/threshold must be exactly 1, got 0/);
    sentNothing();
    const other = await deployer.prepare();
    await expect(deployer.submit({ ...prepared, bytes: other.bytes })).rejects.toThrow(`the bytes hash to ${other.txHash}, not the confirmed ${prepared.txHash}; nothing was sent`);
    sentNothing();
    await expect(deployer.submit({ ...prepared, address: "ff".repeat(32) })).rejects.toThrow(`the bytes deploy ${prepared.address}, not the confirmed ${"ff".repeat(32)}; nothing was sent`);
    sentNothing();
    expect((await deployer.submit(prepared)).txHash).toBe(prepared.txHash);
    expect(w.submitted.map((t) => t.transactionHash())).toEqual([prepared.txHash]);
    deployer.close();
  });

  it("never sends a second deploy of the registry: bytes prepared after one is journalled are discarded", async () => {
    const { deployer, wallet: w } = setup();
    const first = await deployer.submit(await deployer.prepare());
    const second = await deployer.prepare();
    await expect(deployer.submit(second)).rejects.toThrow(new RegExp(`a registry deploy is already journalled on preprod: ${first.txHash}`));
    expect(w.submitted).toHaveLength(1);
    expect(w.discarded).toEqual([second.txHash]);
    deployer.close();
  });

  it("frees the registry for new bytes once the chain is past the TTL of a journalled deploy that never landed, and never sends the old bytes again", async () => {
    const { deployer, wallet: w, rows, net, refusedByProxy } = setup();
    const stale = await refusedByProxy();

    const early = await deployer.prepare();
    await expect(deployer.submit(early)).rejects.toThrow(`a registry deploy is already journalled on preprod: ${stale.txHash} (pending); the prepared bytes were discarded`);
    expect(w.discarded).toEqual([early.txHash]);

    net.advance(15 * MINUTE + 5 * MINUTE + 1_000);
    const next = await deployer.prepare();
    expect(await deployer.submit(next)).toMatchObject({ txHash: next.txHash, address: next.address });
    expect(w.submitted.map((t) => t.transactionHash())).toEqual([next.txHash]);
    expect(rows()).toEqual([
      { tx_hash: stale.txHash, state: "failed" },
      { tx_hash: next.txHash, state: "landed" },
    ]);
    deployer.close();
  });

  it("hands back no deploy once the chain is past the TTL plus the margin of a journalled deploy that never landed", async () => {
    const { deployer, rows, net, refusedByProxy } = setup();
    const refused = await refusedByProxy();
    net.advance(15 * MINUTE + 5 * MINUTE + 1_000);
    expect(await deployer.journalled()).toBeNull();
    expect(rows()).toEqual([{ tx_hash: refused.txHash, state: "failed" }]);
    deployer.close();
  });

  it("hands back a deploy that landed while its submit failed, rebuilt from the journal's bytes, whose submit returns the deployment and sends nothing", async () => {
    const { deployer, wallet: w, rows, net, journalPath } = setup();
    expect(await deployer.journalled()).toBeNull();
    let lost = 1;
    const lossyIndexer = registryDeployer({
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
      pollMillis: 1,
    });
    const prepared = await lossyIndexer.prepare();
    await expect(lossyIndexer.submit(prepared)).rejects.toThrow(/HTTP 502/);
    lossyIndexer.close();

    const resumed = await deployer.journalled();
    expect(resumed).toEqual(prepared);
    expect(await deployer.submit(resumed!)).toEqual({ network: "preprod", address: prepared.address, txHash: prepared.txHash, blockHeight: 500, blockHash: "ab".repeat(32) });
    expect(w.submitted.map((t) => t.transactionHash())).toEqual([prepared.txHash]);
    expect(w.discarded).toEqual([]);
    expect(rows()).toEqual([{ tx_hash: prepared.txHash, state: "landed" }]);
    deployer.close();
  });

  it("never retires a deploy that landed while the indexer's lookup lags the head it reads chain time from: the node holds the registry at that head", async () => {
    const { deployer, wallet: w, rows, net, journalPath } = setup();
    const options = { network: "preprod" as const, prover, journalPath, pollMillis: 1 };
    const timedOut = registryDeployer({
      ...options,
      wallet: {
        ...w,
        async submit(tx) {
          await w.submit(tx);
          throw new Error("test node: ETIMEDOUT after the node accepted the transaction");
        },
      },
      source: net.source,
    });
    const prepared = await timedOut.prepare();
    await expect(timedOut.submit(prepared)).rejects.toThrow(/ETIMEDOUT/);
    timedOut.close();
    net.advance(15 * MINUTE + 5 * MINUTE + 1_000);

    const lagging = registryDeployer({ ...options, wallet: w, source: { ...net.source, indexer: { ...net.source.indexer, transactions: async () => [] } } });
    expect(await lagging.journalled()).toEqual(prepared);
    expect(rows()).toEqual([{ tx_hash: prepared.txHash, state: "landed" }]);
    const second = await lagging.prepare();
    await expect(lagging.submit(second)).rejects.toThrow(`a registry deploy is already journalled on preprod: ${prepared.txHash} (landed); the prepared bytes were discarded`);
    expect(w.discarded).toEqual([second.txHash]);
    await expect(lagging.submit(prepared)).rejects.toThrow(`transaction ${prepared.txHash} took effect on preprod, as the node's state shows, but the indexer does not list it yet`);
    lagging.close();

    expect(await deployer.submit(prepared)).toEqual({ network: "preprod", address: prepared.address, txHash: prepared.txHash, blockHeight: 500, blockHash: "ab".repeat(32) });
    expect(w.submitted.map((t) => t.transactionHash())).toEqual([prepared.txHash]);
    deployer.close();
  });

  it("hands back a deploy whose bytes a proxy refused while the chain has not reached their TTL, and submit sends exactly those bytes again", async () => {
    const { deployer, wallet: w, rows, net, refusedByProxy } = setup();
    const refused = await refusedByProxy();
    net.advance(10 * MINUTE);
    const resumed = await deployer.journalled();
    expect(resumed).toEqual(refused);
    expect(await deployer.submit(resumed!)).toMatchObject({ txHash: refused.txHash, address: refused.address });
    expect(w.submitted.map((t) => hex(t.serialize()))).toEqual([hex(refused.bytes)]);
    expect(rows()).toEqual([{ tx_hash: refused.txHash, state: "landed" }]);
    deployer.close();
  });

  it("between a refused deploy's TTL and its TTL plus the margin, hands back that deploy, whose resend the node refuses, and prepares nothing new", async () => {
    const { deployer, wallet: w, rows, net, refusedByProxy } = setup();
    const refused = await refusedByProxy();
    net.advance(15 * MINUTE + 4 * MINUTE);
    const payFee = vi.spyOn(w, "payFee");
    const resumed = await deployer.journalled();
    expect(resumed).toEqual(refused);
    await expect(deployer.submit(resumed!)).rejects.toThrow(OUTDATED);
    expect(w.submitted.map((t) => hex(t.serialize()))).toEqual([hex(refused.bytes)]);
    expect(payFee).not.toHaveBeenCalled();
    expect(rows()).toEqual([{ tx_hash: refused.txHash, state: "pending" }]);
    deployer.close();
  });

  it("refuses final bytes whose deploy is not exactly the immutable registry, and releases their DUST", async () => {
    const swapped = await mutableDeploy();
    const { deployer, wallet: w, rows } = setup({ tamper: () => swapped });
    await expect(deployer.prepare()).rejects.toThrow(/threshold must be exactly 1, got 0/);
    expect(w.discarded).toEqual([swapped.transactionHash()]);
    expect([w.submitted.length, rows().length]).toEqual([0, 0]);
    deployer.close();
  });

  it("refuses to prepare while the node runs a runtime the decoder does not know", async () => {
    const { deployer, wallet: w } = setup({ spec: 1000400 });
    await expect(deployer.prepare()).rejects.toThrow(/runs runtime 1000400, which is not one this submitter knows/);
    expect(w.submitted).toHaveLength(0);
    deployer.close();
  });

  it("discard releases the DUST of prepared bytes nobody confirmed", async () => {
    const { deployer, wallet: w } = setup();
    const prepared = await deployer.prepare();
    await deployer.discard(prepared);
    expect(w.discarded).toEqual([prepared.txHash]);
    expect(w.submitted).toHaveLength(0);
    deployer.close();
  });
});
