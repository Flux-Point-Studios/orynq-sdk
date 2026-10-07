import { randomBytes } from "node:crypto";
import * as L from "@midnight-ntwrk/ledger-v8";
import { makeSimulatorProvingService } from "@midnight-ntwrk/wallet-sdk-capabilities/proving";
import { Simulator, immediateBlockProducer } from "@midnight-ntwrk/wallet-sdk-capabilities/simulation";
import { CustomDustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { SyncService, V1Builder } from "@midnight-ntwrk/wallet-sdk-dust-wallet/v1";
import { Effect, Exit, Scope } from "effect";
import { filter, firstValueFrom } from "rxjs";
import { feeTransacting } from "../src/fee-transacting.js";

export const NETWORK = "undeployed";
// A NIGHT UTXO, in STAR, whose two hours of DUST pay many fees.
export const NIGHT = 150_000_000_000n;
export const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
export const prover = makeSimulatorProvingService();
const scopes: Scope.CloseableScope[] = [];
const running: Array<{ stop(): Promise<void> }> = [];

// Stops every wallet and simulator opened since the last call.
export async function closeSimulators() {
  for (const wallet of running.splice(0)) await wallet.stop();
  for (const scope of scopes.splice(0)) await run(Scope.close(scope, Exit.void));
}

// The SDK's in-memory ledger simulator, which produces a block for each transaction submitted.
// Each block is as full as `fullness` (0 to 1), which moves the fee prices: on blocks of 0 they
// fall to the ledger's floor within a thousand blocks, as on a quiet chain.
export async function simulatorOf(fullness?: number) {
  const scope = Effect.runSync(Scope.make());
  scopes.push(scope);
  return run(Scope.extend(Simulator.init({ networkId: NETWORK, ...(fullness === undefined ? {} : { blockProducer: immediateBlockProducer(fullness) }) }), scope));
}

// wallet-sdk-dust-wallet 4.2.0 with feeTransacting's fee transactions, synced from the SDK's
// in-memory ledger simulator instead of an indexer, holding one DUST coin per NIGHT UTXO it
// registered, one UTXO of each value in `nights`. A registration backdates DUST generation only
// for the one UTXO that pays its fee, so each UTXO has a key and a registration of its own, two
// hours after its NIGHT arrived: each coin starts with two hours of DUST less the fee of its
// registration, and the last registration is the newest DUST event the wallet applies, as new as
// the simulator's clock.
export async function dustOnSimulator(nights: readonly bigint[], { simulator, additionalFeeOverhead = 1n }: { simulator?: Simulator; additionalFeeOverhead?: bigint } = {}) {
  simulator ??= await simulatorOf();
  const secretKey = L.DustSecretKey.fromSeed(randomBytes(32));
  const Wallet = CustomDustWallet(
    { simulator, networkId: NETWORK, costParameters: { additionalFeeOverhead, feeBlocksMargin: 5 } },
    new V1Builder()
      .withDefaultTransactionType()
      .withSync(SyncService.makeSimulatorSyncService, SyncService.makeSimulatorSyncCapability)
      .withSerializationDefaults()
      .withTransacting(feeTransacting(secretKey))
      .withCoinsAndBalancesDefaults()
      .withTransactionHistory(() => ({ put: () => Effect.void, getTransactionDetails: (hash) => Effect.succeed({ hash, timestamp: 0, status: "SUCCESS" as const }) }))
      .withKeysDefaults()
      .withCoinSelectionDefaults(),
  );
  type DustWallet = ReturnType<typeof Wallet.restore>;
  const open = async (wallet: DustWallet) => {
    running.push(wallet);
    await wallet.start(secretKey);
    return wallet;
  };
  const wallet = await open(Wallet.startWithSecretKey(secretKey, L.LedgerParameters.initialParameters().dust));

  const keys = nights.map(() => L.sampleSigningKey());
  for (const [i, night] of keys.entries()) await run(simulator.rewardNight(L.signatureVerifyingKey(night), nights[i]!));
  await run(simulator.fastForward(7_200n));
  for (const night of keys) {
    const nightKey = L.signatureVerifyingKey(night);
    const before = await run(simulator.getLatestState());
    const utxos = [...before.ledger.utxo.filter(L.addressFromKey(nightKey))].map((utxo) => ({ ...utxo, ctime: before.ledger.utxo.lookupMeta(utxo)!.ctime, registeredForDustGeneration: false }));
    const registration = await wallet.createDustGenerationTransaction(before.currentTime, new Date(before.currentTime.getTime() + 60_000), utxos, nightKey, (await firstValueFrom(wallet.state)).address);
    const signed = await wallet.addDustGenerationSignature(registration, L.signData(night, registration.intents!.get(1)!.signatureData(1)));
    await run(simulator.submitTransaction(await prover.prove(signed)));
  }

  await firstValueFrom(wallet.state.pipe(filter((s) => s.availableCoins.length === nights.length)));
  // `count` blocks with nothing of the wallet's in them, which the wallet applies like any other.
  const blocks = async (count: number, w = wallet) => {
    let block;
    for (let i = 0; i < count; i++) block = await run(simulator.rewardNight(L.signatureVerifyingKey(L.sampleSigningKey()), 1n));
    await firstValueFrom(w.state.pipe(filter((s) => s.progress.appliedIndex > block!.number)));
  };
  const anotherBlock = (w = wallet) => blocks(1, w);
  const now = async () => (await run(simulator.getLatestState())).currentTime;
  // Balances a transaction of its own the way payFee does: the wallet books the DUST it spends.
  const balanced = async (w = wallet, ttl?: Date) => {
    ttl ??= new Date((await now()).getTime() + 15 * 60_000);
    const tx = L.Transaction.fromParts(NETWORK, undefined, undefined, L.Intent.new(ttl));
    const fee = await w.balanceTransactions(secretKey, [tx], ttl);
    return prover.prove(tx.merge(fee));
  };
  const coins = async (w = wallet) => (await firstValueFrom(w.state)).availableCoins.map((c) => c.token.nonce);
  // The time of the newest DUST event the wallet has applied.
  const syncTime = async (w = wallet) => (await firstValueFrom(w.state)).state.state.syncTime;
  const reopen = async () => open(Wallet.restore(await wallet.serializeState()));
  // A wallet restored from `serialized` that never syncs, so it stays where that state was.
  const restored = (serialized: string) => {
    const w = Wallet.restore(serialized);
    running.push(w);
    return w;
  };
  return { simulator, wallet, blocks, anotherBlock, now, balanced, coins, syncTime, reopen, restored };
}
