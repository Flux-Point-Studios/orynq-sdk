import { randomBytes } from "node:crypto";
import * as L from "@midnightntwrk/ledger-v9";
import { ProtocolVersion, WalletTransaction } from "@midnightntwrk/wallet-sdk-abstractions";
import { makeV9SimulatorProvingService } from "@midnightntwrk/wallet-sdk-capabilities/proving";
import { V9 } from "@midnightntwrk/wallet-sdk-capabilities/simulation";
import { CustomDustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { CoinsAndBalances, SyncService, V2Builder } from "@midnightntwrk/wallet-sdk-dust-wallet/v2";
import { Effect, Either, Exit, Scope } from "effect";
import { filter, firstValueFrom } from "rxjs";

type CoinSelection = CoinsAndBalances.CoinSelection;
const { chooseCoin } = CoinsAndBalances;

export const NETWORK = "undeployed";
// A NIGHT UTXO, in STAR, whose two hours of DUST pay many fees.
export const NIGHT = 150_000_000_000n;
export const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
export const prover = makeV9SimulatorProvingService();
const scopes: Scope.CloseableScope[] = [];
const running: Array<{ stop(): Promise<void> }> = [];

// Stops every wallet and simulator opened since the last call.
export async function closeSimulators() {
  for (const wallet of running.splice(0)) await wallet.stop();
  for (const scope of scopes.splice(0)) await run(Scope.close(scope, Exit.void));
}

// The SDK's in-memory ledger 9 simulator, which produces a block for each transaction submitted.
// Each block is as full as `fullness` (0 to 1), which moves the fee prices: on blocks of 0 they
// fall to the ledger's floor within a thousand blocks, as on a quiet chain.
export async function simulatorOf(fullness?: number) {
  const scope = Effect.runSync(Scope.make());
  scopes.push(scope);
  return run(Scope.extend(V9.Simulator.init({ networkId: NETWORK, ...(fullness === undefined ? {} : { blockProducer: V9.immediateBlockProducer(fullness) }) }), scope));
}

// A single-variant ledger 9 wallet acts at every protocol version, so its handles carry the lowest.
const sealed = (tx: L.UnprovenTransaction | L.FinalizedTransaction | L.ProofErasedTransaction, stage: "Unproven" | "Finalized") => WalletTransaction.adopt(stage, tx, ProtocolVersion.MinSupportedVersion);
const unsealed = <T>(handle: WalletTransaction) => Either.getOrThrow(WalletTransaction.unwrapWithin<T>(handle, [ProtocolVersion.MinSupportedVersion, ProtocolVersion.MaxSupportedVersion]));

// wallet-sdk-dust-wallet 5.0.0's ledger 9 DUST wallet, as the operator wallet's facade runs it from
// the fork on, synced from the SDK's in-memory ledger 9 simulator instead of an indexer, holding one
// DUST coin per NIGHT UTXO it registered, one UTXO of each value in `nights`. A registration
// backdates DUST generation only for the one UTXO that pays its fee, so each UTXO has a key and a
// registration of its own, two hours after its NIGHT arrived.
export async function dustOnSimulator(nights: readonly bigint[], { simulator, additionalFeeOverhead = 1n, coinSelection }: { simulator?: V9.Simulator; additionalFeeOverhead?: bigint; coinSelection?: CoinSelection } = {}) {
  simulator ??= await simulatorOf();
  const secretKey = L.DustSecretKey.fromSeed(randomBytes(32));
  const Wallet = CustomDustWallet<never, L.DustSecretKey, L.FinalizedTransaction, SyncService.SimulatorSyncUpdate>(
    { simulator, networkId: NETWORK, costParameters: { additionalFeeOverhead, feeBlocksMargin: 5 } } as never,
    new V2Builder()
      .withDefaultTransactionType()
      .withSync(SyncService.makeSimulatorSyncService, SyncService.makeSimulatorSyncCapability)
      .withSerializationDefaults()
      .withTransactingDefaults()
      .withCoinSelection(() => coinSelection ?? chooseCoin)
      .withCoinsAndBalancesDefaults()
      .withTransactionHistory(() => ({ put: () => Effect.void, getTransactionDetails: (hash: string) => Effect.succeed({ hash, timestamp: 0, status: "SUCCESS" as const }) }) as never)
      .withKeysDefaults()
      .withMigrationDefaults()
      .withStartAuxDefaults() as never,
  );
  type DustWallet = ReturnType<typeof Wallet.restore>;
  const open = async (wallet: DustWallet) => {
    running.push(wallet);
    await wallet.start({ v9: secretKey });
    return wallet;
  };
  const wallet = await open(Wallet.startWithSecretKey(secretKey, L.LedgerParameters.initialParameters().dust));

  const keys = nights.map(() => L.sampleSigningKey());
  for (const [i, night] of keys.entries()) await run(simulator.rewardNight(L.signatureVerifyingKey(night), nights[i]!));
  await run(simulator.fastForward(7_200n));
  // Each registration's DUST coin, in the order of `nights`.
  const registered: bigint[] = [];
  for (const night of keys) {
    const nightKey = L.signatureVerifyingKey(night);
    const before = await run(simulator.getLatestState());
    const utxos = [...before.ledger.utxo.filter(L.addressFromKey(nightKey))].map((utxo) => ({ ...utxo, ctime: before.ledger.utxo.lookupMeta(utxo)!.ctime, registeredForDustGeneration: false }));
    const registration = await wallet.createDustGenerationTransaction(before.currentTime, new Date(before.currentTime.getTime() + 60_000), utxos as never, nightKey, (await firstValueFrom(wallet.state)).address);
    const unproven = unsealed<L.UnprovenTransaction>(registration);
    const signed = await wallet.addDustGenerationSignature(registration, L.signData(night, unproven.intents!.get(1)!.signatureData(1)) as never);
    await run(simulator.submitTransaction(await prover.prove(unsealed<L.UnprovenTransaction>(signed))));
    const { availableCoins } = await firstValueFrom(wallet.state.pipe(filter((s) => s.availableCoins.length === registered.length + 1)));
    registered.push(availableCoins.map((c) => c.token.nonce).find((nonce) => !registered.includes(nonce))!);
  }

  // `count` blocks with nothing of the wallet's in them, which the wallet applies like any other.
  const blocks = async (count: number, w = wallet) => {
    let block: { number: bigint } | undefined;
    for (let i = 0; i < count; i++) block = await run(simulator.rewardNight(L.signatureVerifyingKey(L.sampleSigningKey()), 1n));
    await firstValueFrom(w.state.pipe(filter((s) => s.progress.appliedIndex >= block!.number)));
  };
  const anotherBlock = (w = wallet) => blocks(1, w);
  const now = async () => (await run(simulator.getLatestState())).currentTime;
  // Balances a transaction of its own the way the operator's fee does: the wallet books the DUST it
  // spends. Returns the balanced transaction with its proofs erased, as the simulator takes it.
  const balanced = async (w = wallet, ttl?: Date, transaction?: L.UnprovenTransaction) => {
    ttl ??= new Date((await now()).getTime() + 15 * 60_000);
    const tx = transaction ?? L.Transaction.fromParts(NETWORK, undefined, undefined, L.Intent.new(ttl));
    const { transaction: fee } = await w.balanceTransactions([sealed(tx, "Unproven")], ttl);
    return prover.prove(tx.merge(unsealed<L.UnprovenTransaction>(fee)));
  };
  const revert = (w: DustWallet, tx: L.ProofErasedTransaction) => w.revertTransaction(sealed(tx, "Finalized"));
  const coins = async (w = wallet) => (await firstValueFrom(w.state)).availableCoins.map((c) => c.token.nonce);
  const reopen = async () => open(Wallet.restore(await wallet.serializeState()));
  // A wallet restored from `serialized`, started on the simulator with this wallet's key.
  const restored = (serialized: string): Promise<DustWallet> => open(Wallet.restore(serialized));
  return { simulator, wallet, secretKey, registered, blocks, anotherBlock, now, balanced, revert, coins, reopen, restored };
}
