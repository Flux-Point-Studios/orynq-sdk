import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import * as L from "@midnightntwrk/ledger-v9";
import { anchorCallsIn, entryCommitment, unprovenRegistryCall } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { parseDust } from "../src/preflight.js";
import { assertDismissable } from "../src/submission.js";
import { largestCoinFirst } from "../src/wallet.js";
import LIMITS from "../runner/limits.json";
import { deployed9 } from "./fakes.js";
import { prover } from "./prover.js";
import { NETWORK, NIGHT, closeSimulators, dustOnSimulator, run } from "./simulator.js";

// The wallet pays every fee with wallet-sdk-dust-wallet 5.0.0's ledger 9 DUST wallet as the SDK
// ships it, freeing DUST only where the journal decides (wallet.ts). These pin the behaviour of
// that wallet the operator relies on, on the SDK's ledger 9 simulator.
afterEach(closeSimulators);
const spendsOf = (tx: L.ProofErasedTransaction) => [...tx.intents!.values()].map((intent) => intent.dustActions?.spends.map((spend) => spend.vFee) ?? null);

describe("reverting a fee transaction that never landed", () => {
  // On preprod, a transaction the node refused was reverted after the wallet had applied newer
  // DUST events: wallet-sdk-dust-wallet 4.2.0 had already forgotten which coin it spent, and the
  // wallet's one coin stayed spent for the ledger's three-hour grace period.
  it("frees the coin it spent, even after the wallet applied a newer block", async () => {
    const { wallet, anotherBlock, balanced, coins, revert } = await dustOnSimulator([NIGHT]);
    const [coin] = await coins();
    const final = await balanced();
    expect(await coins()).toEqual([]);
    await anotherBlock();
    await revert(wallet, final);
    expect(await coins()).toEqual([coin]);
    await expect(balanced()).resolves.toBeDefined();
  }, 120_000);

  // wallet-sdk-dust-wallet 4.2.0 freed a reverted spend by moving the ledger's clock for TTLs to
  // the end of its grace period, which freed every coin spent before it too (midnight-wallet#789).
  it("never frees a coin that an earlier transaction, still in flight, spends, in the state it saves", async () => {
    const { wallet, balanced, coins, reopen, revert } = await dustOnSimulator([NIGHT, NIGHT]);
    await balanced();
    const [later] = await coins();
    const refused = await balanced();
    expect(await coins()).toEqual([]);
    await revert(wallet, refused);
    expect(await coins()).toEqual([later]);
    expect(await coins(await reopen())).toEqual([later]);
  }, 120_000);

  it("leaves the freed coin free in the state saved and restored after it", async () => {
    const { wallet, anotherBlock, balanced, coins, reopen, revert } = await dustOnSimulator([NIGHT]);
    const [coin] = await coins();
    const final = await balanced();
    await anotherBlock();
    await revert(wallet, final);
    const restored = await reopen();
    await anotherBlock(restored);
    expect(await coins(restored)).toEqual([coin]);
    await expect(balanced(restored)).resolves.toBeDefined();
  }, 120_000);
});

describe("the coins a fee spends", () => {
  // Every DUST spend adds to a fee, and the SDK's default order, smallest first, spends each coin
  // too small to pay alone before a larger one, and again once that coin has regenerated a little.
  it("are taken largest first: a large coin pays alone and a smaller one stays untouched", async () => {
    const { balanced, coins, registered: [small] } = await dustOnSimulator([NIGHT / 10n, NIGHT], { coinSelection: largestCoinFirst });
    const paid = await balanced();
    expect(spendsOf(paid).flatMap((spends) => spends ?? [])).toHaveLength(1);
    expect(await coins()).toEqual([small]);
  }, 120_000);

  it("in the SDK's default order would spend the small coin instead", async () => {
    const { balanced, coins, registered: [, large] } = await dustOnSimulator([NIGHT / 10n, NIGHT]);
    await balanced();
    expect(await coins()).toEqual([large]);
  }, 120_000);
});

describe("a fee's DUST spend", () => {
  it("pays a fee computed at the ledger's floor with one DUST spend, and the simulator takes it", async () => {
    const { simulator, balanced, blocks } = await dustOnSimulator([NIGHT]);
    await blocks(3);
    const paid = await balanced();
    const [base, fee] = spendsOf(paid);
    expect(base).toBeNull();
    expect(fee).toHaveLength(1);
    expect(fee![0]!).toBeGreaterThan(0n);
    await expect(run(simulator.submitTransaction(paid))).resolves.toBeDefined();
  }, 120_000);
});

// Mainnet's ledger 9 parameters at block 3350170 (fixtures/mainnet-ledger9-prices.json), read from
// the public node after the upgrade.
const mainnet9 = JSON.parse(readFileSync(new URL("./fixtures/mainnet-ledger9-prices.json", import.meta.url), "utf8"));
const mainnetParameters = () => L.LedgerParameters.deserialize(Buffer.from(mainnet9.parametersHex, "hex"));

describe("a ledger 9 registry anchor at mainnet's ledger 9 prices", () => {
  it("is balanced with one DUST spend, passes ledger 9's time to dismiss, and the simulator takes the paid call", async () => {
    const { simulator, wallet, balanced, now } = await dustOnSimulator([NIGHT, NIGHT]);
    const ttl = new Date((await now()).getTime() + 15 * 60_000);
    const deploy = L.Transaction.fromParts(NETWORK, undefined, undefined, L.Intent.new(ttl).addDeploy(new L.ContractDeploy(deployed9.state)));
    await run(simulator.submitTransaction(await balanced(wallet, ttl, deploy)));
    const state = await run(simulator.getLatestState());
    const address = String(([...deploy.intents!.values()][0]!.actions[0] as L.ContractDeploy).address);
    state.ledger.parameters = mainnetParameters();
    const commitment = entryCommitment({ rootHash: "12".repeat(32), manifestHash: "34".repeat(32) });
    const { tx } = unprovenRegistryCall({ networkId: NETWORK, address, state: state.ledger.index(address)!, parameters: mainnetParameters(), ttl, call: { circuit: "anchor", args: [commitment, 3n] }, witnesses: { authorSecret: new Uint8Array(32).fill(1) } });
    const paid = await balanced(wallet, ttl, tx);
    expect(anchorCallsIn(paid, [address], "mainnet-price simulator").calls).toEqual([expect.objectContaining({ kind: 3, entryPoint: "anchor", commitment: Buffer.from(commitment).toString("hex") })]);
    expect(spendsOf(paid).flatMap((spends) => spends ?? [])).toHaveLength(1);
    expect(() => assertDismissable(paid as unknown as L.FinalizedTransaction, mainnetParameters())).not.toThrow();
    await expect(run(simulator.submitTransaction(paid))).resolves.toBeDefined();
  }, 180_000);

  // Under ledger 8, mainnet charged an anchor 2 SPECK. Ledger 9 prices the same call, before its
  // fee's own DUST spend, at about 0.15 DUST, above the standing service's approved caps of 0.01 DUST a transaction and 0.1 DUST a day,
  // so the standing service holds every batch on its fee cap until the caps are raised.
  it("costs more than the standing service's approved per-transaction and daily caps", async () => {
    const { tx } = unprovenRegistryCall({ networkId: NETWORK, address: deployed9.address, state: deployed9.state, parameters: mainnetParameters(), ttl: new Date(Date.now() + 600e3), call: { circuit: "anchor", args: [new Uint8Array(32).fill(3), 3n] }, witnesses: { authorSecret: new Uint8Array(32).fill(1) } });
    const fee = (await prover.prove(tx)).bind().fees(mainnetParameters());
    expect(fee).toBeGreaterThan(150_000_000_000_000n);
    expect(fee).toBeLessThan(160_000_000_000_000n);
    expect(fee).toBeGreaterThan(parseDust(LIMITS.maxFeeDustPerTransaction)!);
    expect(fee).toBeGreaterThan(parseDust(LIMITS.maxDustPer24Hours)!);
  });
});
