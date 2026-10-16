import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as L from "@midnight-ntwrk/ledger-v8";
import { REGISTRY_VERIFIER_KEY_SHA256, createAuthorKeyFile, registryInitialState, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { registryDeployer } from "../src/deployer.js";
import { registryOperator } from "../src/operator.js";
import { chain, fresh, hex, mutableDeploy, wallet } from "./fakes.js";
import { prover } from "./prover.js";
import type { NodeVersion } from "../../anchors-midnight/src/__tests__/ledger-node.js";

function setup({ tamper, spec, node }: { tamper?: (tx: L.FinalizedTransaction) => L.FinalizedTransaction; spec?: number; node?: NodeVersion } = {}) {
  const net = chain({ ...(spec === undefined ? {} : { spec }), ...(node === undefined ? {} : { node }) });
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
  // A deploy the node accepted and landed while its broadcast timed out, so no broadcast of it returned.
  const timedOutAfterAccept = async () => {
    const timedOut = registryDeployer({
      network: "preprod",
      wallet: {
        ...w,
        async submit(tx) {
          await w.submit(tx);
          throw new Error("test node: ETIMEDOUT after the node accepted the transaction");
        },
      },
      source: net.source,
      prover,
      journalPath,
      pollMillis: 1,
    });
    const landed = await timedOut.prepare();
    await expect(timedOut.submit(landed)).rejects.toThrow(/ETIMEDOUT/);
    timedOut.close();
    return landed;
  };
  // The same chain, read through an indexer whose transaction lookup lags its head and lists nothing.
  const laggingLookup = { ...net.source, indexer: { ...net.source.indexer, transactions: async () => [] } } as MidnightSource;
  return { deployer, wallet: w, rows, net, journalPath, refusedByProxy, timedOutAfterAccept, laggingLookup };
}

const EXPIRED = "the journalled deploy expired without landing; rerun to prepare new bytes";
// The journal's key of a preprod registry deploy.
const DEPLOY_KEY = ["preprod", "registry-deploy", "", 0, createHash("sha256").update(registryInitialState().serialize()).digest("hex"), ""].join("/");
const UNKNOWN_TIME = "the preprod node does not hold the indexer's newest block, so chain time is unknown and the journalled bytes may be past their TTL; nothing was sent";

const MINUTE = 60_000;

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
    const mutable = (await mutableDeploy("preprod")).serialize();
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

  it.each(["2.1.0", "1.0.400"] as const)("hands back no deploy once the chain is past the TTL plus the margin of a journalled deploy that never landed, on node %s", async (node) => {
    const { deployer, rows, net, refusedByProxy } = setup({ node });
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
    expect(resumed).toEqual({ ...prepared, journal: { state: "landed", broadcasts: 1, expired: false } });
    expect(await deployer.submit(resumed!)).toEqual({ network: "preprod", address: prepared.address, txHash: prepared.txHash, blockHeight: 500, blockHash: "ab".repeat(32) });
    expect(w.submitted.map((t) => t.transactionHash())).toEqual([prepared.txHash]);
    expect(w.discarded).toEqual([]);
    expect(rows()).toEqual([{ tx_hash: prepared.txHash, state: "landed" }]);
    deployer.close();
  });

  it("never retires a deploy that landed while the indexer's lookup lags the head it reads chain time from: the node holds the registry at that head", async () => {
    const { deployer, wallet: w, rows, net, journalPath, timedOutAfterAccept, laggingLookup } = setup();
    const prepared = await timedOutAfterAccept();
    net.advance(15 * MINUTE + 5 * MINUTE + 1_000);

    const lagging = registryDeployer({ network: "preprod", wallet: w, source: laggingLookup, prover, journalPath, pollMillis: 1 });
    expect(await lagging.journalled()).toEqual({ ...prepared, journal: { state: "landed", broadcasts: 0, expired: false } });
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

  it("never retires a landed deploy from any reconcile of its journal: an operator sharing the journal, reading the lagging lookup, leaves it landed, and no second deploy follows", async () => {
    const { deployer, wallet: w, rows, net, journalPath, timedOutAfterAccept, laggingLookup } = setup();
    const prepared = await timedOutAfterAccept();
    net.advance(15 * MINUTE + 5 * MINUTE + 1_000);

    const authorKeyFile = fresh("author.key");
    createAuthorKeyFile(authorKeyFile);
    const operator = registryOperator({ network: "preprod", wallet: w, source: laggingLookup, prover, journalPath, authorKeyFile, registry: prepared.address, pollMillis: 1 });
    expect(await operator.reconcile()).toEqual([expect.objectContaining({ txHash: prepared.txHash, state: "landed" })]);
    operator.close();

    expect(await deployer.journalled()).toEqual({ ...prepared, journal: { state: "landed", broadcasts: 0, expired: false } });
    const second = await deployer.prepare();
    await expect(deployer.submit(second)).rejects.toThrow(`a registry deploy is already journalled on preprod: ${prepared.txHash} (landed); the prepared bytes were discarded`);
    expect(w.submitted.map((t) => t.transactionHash())).toEqual([prepared.txHash]);
    expect(rows()).toEqual([{ tx_hash: prepared.txHash, state: "landed" }]);
    deployer.close();
  });

  it("leaves a mainnet deploy that landed while its readback failed to resume when a preprod deployer and operator reconcile the same journal file past its TTL plus the margin", async () => {
    const mainnet = chain();
    const preprod = chain();
    const journalPath = fresh("journal.sqlite");
    const w = wallet(mainnet, () => journalPath);
    let lost = 1;
    const lossyIndexer = registryDeployer({
      network: "mainnet",
      wallet: w,
      source: {
        ...mainnet.source,
        indexer: {
          ...mainnet.source.indexer,
          async transactions(hash: string) {
            const found = await mainnet.source.indexer.transactions(hash);
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
    preprod.advance(15 * MINUTE + 5 * MINUTE + 1_000);

    const preprodWallet = wallet(preprod, () => journalPath);
    const preprodDeployer = registryDeployer({ network: "preprod", wallet: preprodWallet, source: preprod.source, prover, journalPath, pollMillis: 1 });
    expect(await preprodDeployer.journalled()).toBeNull();
    preprodDeployer.close();
    const authorKeyFile = fresh("author.key");
    createAuthorKeyFile(authorKeyFile);
    const operator = registryOperator({ network: "preprod", wallet: preprodWallet, source: preprod.source, prover, journalPath, authorKeyFile, registry: prepared.address, pollMillis: 1 });
    expect(await operator.reconcile()).toEqual([]);
    operator.close();

    const deployer = registryDeployer({ network: "mainnet", wallet: w, source: mainnet.source, prover, journalPath, pollMillis: 1 });
    const resumed = await deployer.journalled();
    expect(resumed).toEqual({ ...prepared, journal: { state: "landed", broadcasts: 1, expired: false } });
    const second = await deployer.prepare();
    await expect(deployer.submit(second)).rejects.toThrow(`a registry deploy is already journalled on mainnet: ${prepared.txHash} (landed); the prepared bytes were discarded`);
    expect(await deployer.submit(resumed!)).toEqual({ network: "mainnet", address: prepared.address, txHash: prepared.txHash, blockHeight: 500, blockHash: "ab".repeat(32) });
    expect(w.submitted.map((t) => t.transactionHash())).toEqual([prepared.txHash]);
    expect(preprodWallet.submitted).toEqual([]);
    deployer.close();
  });

  it("hands back a deploy whose bytes a proxy refused while the chain has not reached their TTL, and submit sends exactly those bytes again", async () => {
    const { deployer, wallet: w, rows, net, refusedByProxy } = setup();
    const refused = await refusedByProxy();
    net.advance(10 * MINUTE);
    const resumed = await deployer.journalled();
    expect(resumed).toEqual({ ...refused, journal: { state: "pending", broadcasts: 0, expired: false } });
    expect(await deployer.submit(resumed!)).toMatchObject({ txHash: refused.txHash, address: refused.address });
    expect(w.submitted.map((t) => hex(t.serialize()))).toEqual([hex(refused.bytes)]);
    expect(rows()).toEqual([{ tx_hash: refused.txHash, state: "landed" }]);
    deployer.close();
  });

  it("between a refused deploy's TTL and its TTL plus the margin, hands back that deploy marked expired, whose submit sends nothing and waits until the chain retires it, then refuses", async () => {
    const { deployer, wallet: w, rows, net, refusedByProxy } = setup();
    const refused = await refusedByProxy();
    net.advance(15 * MINUTE + 4 * MINUTE);
    const payFee = vi.spyOn(w, "payFee");
    const resumed = await deployer.journalled();
    expect(resumed).toEqual({ ...refused, journal: { state: "pending", broadcasts: 0, expired: true } });
    const submitted = deployer.submit(resumed!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rows()).toEqual([{ tx_hash: refused.txHash, state: "pending" }]);
    net.advance(2 * MINUTE);
    await expect(submitted).rejects.toThrow(EXPIRED);
    expect(w.submitted).toEqual([]);
    expect(payFee).not.toHaveBeenCalled();
    expect(rows()).toEqual([{ tx_hash: refused.txHash, state: "failed" }]);
    deployer.close();
  });

  it("sends nothing for a resumed deploy confirmed as expired though the node, at its submit, lacks the indexer's newest block, and waits until the chain retires it", async () => {
    const { deployer, wallet: w, rows, net, refusedByProxy } = setup();
    const refused = await refusedByProxy();
    net.advance(16 * MINUTE);
    const resumed = await deployer.journalled();
    expect(resumed?.journal).toEqual({ state: "pending", broadcasts: 0, expired: true });
    net.lag(true);
    const outcome = deployer.submit(resumed!).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([w.submitted, rows()]).toEqual([[], [{ tx_hash: refused.txHash, state: "pending" }]]);
    net.lag(false);
    net.advance(5 * MINUTE);
    expect(await outcome).toBe(EXPIRED);
    expect(w.submitted).toEqual([]);
    expect(rows()).toEqual([{ tx_hash: refused.txHash, state: "failed" }]);
    deployer.close();
  });

  it("refuses a resumed deploy no send of which returned while the node lacks the indexer's newest block, sending nothing, and sends it once the node holds that block", async () => {
    const { deployer, wallet: w, rows, net, refusedByProxy } = setup();
    const refused = await refusedByProxy();
    net.advance(10 * MINUTE);
    const resumed = await deployer.journalled();
    expect(resumed?.journal).toEqual({ state: "pending", broadcasts: 0, expired: false });
    net.lag(true);
    await expect(deployer.submit(resumed!)).rejects.toThrow(UNKNOWN_TIME);
    expect([w.submitted, w.discarded]).toEqual([[], []]);
    expect(rows()).toEqual([{ tx_hash: refused.txHash, state: "pending" }]);
    net.lag(false);
    expect(await deployer.submit(resumed!)).toMatchObject({ txHash: refused.txHash, address: refused.address });
    expect(w.submitted.map((t) => t.transactionHash())).toEqual([refused.txHash]);
    deployer.close();
  });

  it("refuses a resumed deploy the chain retired while it waited for confirmation, sending nothing, instead of journalling its bytes again", async () => {
    const { deployer, wallet: w, rows, net, refusedByProxy } = setup();
    const refused = await refusedByProxy();
    net.advance(10 * MINUTE);
    const resumed = await deployer.journalled();
    expect(resumed?.journal).toEqual({ state: "pending", broadcasts: 0, expired: false });
    net.advance(11 * MINUTE);
    await expect(deployer.submit(resumed!)).rejects.toThrow(EXPIRED);
    expect([w.submitted, w.discarded]).toEqual([[], []]);
    expect(rows()).toEqual([{ tx_hash: refused.txHash, state: "failed" }]);
    deployer.close();
  });

  it("names the wallet that paid a resumed deploy, not the wallet resuming it", async () => {
    const { net, journalPath, timedOutAfterAccept, wallet: payer } = setup();
    const landed = await timedOutAfterAccept();
    expect(landed.payer).toBe(payer.addresses.unshielded);
    const other = wallet(net, () => journalPath, undefined, "b");
    const resuming = registryDeployer({ network: "preprod", wallet: other, source: net.source, prover, journalPath, pollMillis: 1 });
    expect(await resuming.journalled()).toMatchObject({ txHash: landed.txHash, payer: payer.addresses.unshielded });
    expect(other.addresses.unshielded).not.toBe(payer.addresses.unshielded);
    resuming.close();
  });

  it("with two deployers confirmed at once, the one whose bytes the journal did not take refuses and discards them, and only the other's deploy is sent", async () => {
    const { deployer, wallet: w, rows, net, journalPath } = setup();
    const w2 = wallet(net, () => journalPath, undefined, "b");
    const second = registryDeployer({ network: "preprod", wallet: w2, source: net.source, prover, journalPath, pollMillis: 1 });
    const [p1, p2] = [await deployer.prepare(), await second.prepare()];
    const [r1, r2] = await Promise.allSettled([deployer.submit(p1), second.submit(p2)]);
    const outcomes = [r1, r2].map((r) => r.status);
    expect(outcomes.sort()).toEqual(["fulfilled", "rejected"]);
    const [won, lost, loser] = r1.status === "fulfilled" ? [p1, p2, w2] : [p2, p1, w];
    const refusal = (r1.status === "rejected" ? r1 : (r2 as PromiseRejectedResult)).reason as Error;
    expect(refusal.message).toMatch(new RegExp(`^a registry deploy is already journalled on preprod: ${won.txHash} \\((pending|landed)\\); the prepared bytes were discarded$`));
    expect(loser.discarded).toEqual([lost.txHash]);
    expect([...w.submitted, ...w2.submitted].map((t) => t.transactionHash())).toEqual([won.txHash]);
    expect(rows()).toEqual([{ tx_hash: won.txHash, state: "landed" }]);
    deployer.close();
    second.close();
  });

  it("sends nothing when another deployer's row reaches the journal between its own check and the journal taking its bytes: it refuses and discards them, never broadcasting the other's", async () => {
    const { deployer: first, wallet: w, rows, net, journalPath } = setup();
    const w2 = wallet(net, () => journalPath, undefined, "b");
    const p1 = await first.prepare();
    // journalOnce asks the wallet for its address after submit found the registry's key free and
    // before the journal looks at the key: the first deployer's row is written then, unsent.
    let racing = false;
    const racingWallet = {
      ...w2,
      get addresses() {
        if (racing) {
          racing = false;
          const db = new DatabaseSync(journalPath);
          db.prepare("insert into attempts (key, tx_hash, bytes, ttl_ms, state, payer) values (?, ?, ?, ?, 'pending', ?)").run(DEPLOY_KEY, p1.txHash, p1.bytes, p1.ttl.getTime(), w.addresses.unshielded);
          db.close();
        }
        return w2.addresses;
      },
    };
    const second = registryDeployer({ network: "preprod", wallet: racingWallet, source: net.source, prover, journalPath, pollMillis: 1 });
    const p2 = await second.prepare();
    racing = true;
    await expect(second.submit(p2)).rejects.toThrow(`a registry deploy is already journalled on preprod: ${p1.txHash} (pending); the prepared bytes were discarded`);
    expect([w2.submitted, w2.discarded]).toEqual([[], [p2.txHash]]);
    expect(rows()).toEqual([{ tx_hash: p1.txHash, state: "pending" }]);
    expect(await first.submit(p1)).toMatchObject({ txHash: p1.txHash, address: p1.address });
    expect(w.submitted.map((t) => t.transactionHash())).toEqual([p1.txHash]);
    first.close();
    second.close();
  });

  it("refuses journalled bytes that deploy anything but the registry before handing back a deploy", async () => {
    const { deployer, journalPath, refusedByProxy } = setup();
    await refusedByProxy();
    const db = new DatabaseSync(journalPath);
    db.prepare("update attempts set bytes = ?").run((await mutableDeploy("preprod")).serialize());
    db.close();
    await expect(deployer.journalled()).rejects.toThrow(/threshold must be exactly 1, got 0/);
    deployer.close();
  });

  it("refuses final bytes whose deploy is not exactly the immutable registry, and releases their DUST", async () => {
    const swapped = await mutableDeploy("preprod");
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
