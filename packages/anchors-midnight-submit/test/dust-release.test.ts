import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import { makeSimulatorProvingService } from "@midnight-ntwrk/wallet-sdk-capabilities/proving";
import { Simulator } from "@midnight-ntwrk/wallet-sdk-capabilities/simulation";
import { CustomDustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { SyncService, V1Builder } from "@midnight-ntwrk/wallet-sdk-dust-wallet/v1";
import { Effect, Exit, Scope } from "effect";
import { filter, firstValueFrom } from "rxjs";
import { exactRevert } from "../src/dust.js";

const NETWORK = "undeployed";
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const prover = makeSimulatorProvingService();
const scopes: Scope.CloseableScope[] = [];
const running: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const wallet of running.splice(0)) await wallet.stop();
  for (const scope of scopes.splice(0)) await run(Scope.close(scope, Exit.void));
});

// wallet-sdk-dust-wallet 4.2.0 with exactRevert's fee transactions, synced from the SDK's
// in-memory ledger simulator instead of an indexer, holding one DUST coin per NIGHT UTXO it
// registered.
async function dustOnSimulator(nightUtxos: number) {
  const scope = Effect.runSync(Scope.make());
  scopes.push(scope);
  const simulator = await run(Scope.extend(Simulator.init({ networkId: NETWORK }), scope));
  const secretKey = L.DustSecretKey.fromSeed(randomBytes(32));
  const Wallet = CustomDustWallet(
    { simulator, networkId: NETWORK, costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 } },
    new V1Builder()
      .withDefaultTransactionType()
      .withSync(SyncService.makeSimulatorSyncService, SyncService.makeSimulatorSyncCapability)
      .withSerializationDefaults()
      .withTransacting(exactRevert(secretKey))
      .withCoinsAndBalancesDefaults()
      .withTransactionHistory(() => ({ put: () => Effect.void, getTransactionDetails: (hash) => Effect.succeed({ hash, timestamp: 0, status: "SUCCESS" as const }) }))
      .withKeysDefaults()
      .withCoinSelectionDefaults(),
  );
  const open = async (wallet: ReturnType<typeof Wallet.restore>) => {
    running.push(wallet);
    await wallet.start(secretKey);
    return wallet;
  };
  const wallet = await open(Wallet.startWithSecretKey(secretKey, L.LedgerParameters.initialParameters().dust));

  const night = L.sampleSigningKey();
  const nightKey = L.signatureVerifyingKey(night);
  for (let i = 0; i < nightUtxos; i++) await run(simulator.rewardNight(nightKey, 150_000_000_000n));
  await run(simulator.fastForward(3_600n));
  const before = await run(simulator.getLatestState());
  const utxos = [...before.ledger.utxo.filter(L.addressFromKey(nightKey))].map((utxo) => ({ ...utxo, ctime: before.ledger.utxo.lookupMeta(utxo)!.ctime, registeredForDustGeneration: false }));
  const registration = await wallet.createDustGenerationTransaction(before.currentTime, new Date(before.currentTime.getTime() + 60_000), utxos, nightKey, (await firstValueFrom(wallet.state)).address);
  const signed = await wallet.addDustGenerationSignature(registration, L.signData(night, registration.intents!.get(1)!.signatureData(1)));
  await run(simulator.submitTransaction(await prover.prove(signed)));
  await run(simulator.fastForward(3_600n));

  await firstValueFrom(wallet.state.pipe(filter((s) => s.availableCoins.length === nightUtxos)));
  // A block with nothing of the wallet's in it, which the wallet applies like any other.
  const anotherBlock = async (w = wallet) => {
    const block = await run(simulator.rewardNight(L.signatureVerifyingKey(L.sampleSigningKey()), 1n));
    await firstValueFrom(w.state.pipe(filter((s) => s.progress.appliedIndex > block.number)));
  };
  // Balances a transaction of its own the way payFee does: the wallet books the DUST it spends.
  const balanced = async (w = wallet) => {
    const { currentTime } = await run(simulator.getLatestState());
    const ttl = new Date(currentTime.getTime() + 15 * 60_000);
    const tx = L.Transaction.fromParts(NETWORK, undefined, undefined, L.Intent.new(ttl));
    const fee = await w.balanceTransactions(secretKey, [tx], ttl);
    return prover.prove(tx.merge(fee));
  };
  const coins = async (w = wallet) => (await firstValueFrom(w.state)).availableCoins.map((c) => c.token.nonce);
  const reopen = async () => open(Wallet.restore(await wallet.serializeState()));
  return { wallet, anotherBlock, balanced, coins, reopen };
}

describe("reverting a fee transaction that never landed", () => {
  // On preprod, a transaction the node refused was reverted after the wallet had applied newer
  // DUST events: wallet-sdk-dust-wallet 4.2.0 had already forgotten which coin it spent, and the
  // wallet's one coin stayed spent for the ledger's three-hour grace period.
  it("frees the coin it spent, even after the wallet applied a newer block", async () => {
    const { wallet, anotherBlock, balanced, coins } = await dustOnSimulator(1);
    const [coin] = await coins();
    const final = await balanced();
    expect(await coins()).toEqual([]);
    await anotherBlock();
    await wallet.revertTransaction(final);
    expect(await coins()).toEqual([coin]);
    await expect(balanced()).resolves.toBeDefined();
  });

  // wallet-sdk-dust-wallet 4.2.0 frees a reverted spend by moving the ledger's clock for TTLs to
  // the end of its grace period, which frees every coin spent before it too; its own list of
  // spent coins hides those until a restart, which does not keep that list.
  it("never frees a coin that an earlier transaction, still in flight, spends, in the state it saves", async () => {
    const { wallet, balanced, coins, reopen } = await dustOnSimulator(2);
    await balanced();
    const [later] = await coins();
    const refused = await balanced();
    expect(await coins()).toEqual([]);
    await wallet.revertTransaction(refused);
    expect(await coins()).toEqual([later]);
    expect(await coins(await reopen())).toEqual([later]);
  });

  it("leaves the freed coin free in the state saved and restored after it", async () => {
    const { wallet, anotherBlock, balanced, coins, reopen } = await dustOnSimulator(1);
    const [coin] = await coins();
    const final = await balanced();
    await anotherBlock();
    await wallet.revertTransaction(final);
    const restored = await reopen();
    await anotherBlock(restored);
    expect(await coins(restored)).toEqual([coin]);
    await expect(balanced(restored)).resolves.toBeDefined();
  });
});
