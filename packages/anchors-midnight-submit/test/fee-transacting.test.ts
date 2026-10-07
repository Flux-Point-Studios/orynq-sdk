import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import { makeSimulatorProvingService } from "@midnight-ntwrk/wallet-sdk-capabilities/proving";
import { Simulator } from "@midnight-ntwrk/wallet-sdk-capabilities/simulation";
import { CustomDustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { SyncService, V1Builder } from "@midnight-ntwrk/wallet-sdk-dust-wallet/v1";
import { TTL_MARGIN_MILLIS } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { Effect, Exit, Scope } from "effect";
import { filter, firstValueFrom } from "rxjs";
import { feeTransacting } from "../src/fee-transacting.js";

const NETWORK = "undeployed";
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const prover = makeSimulatorProvingService();
const scopes: Scope.CloseableScope[] = [];
const running: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const wallet of running.splice(0)) await wallet.stop();
  for (const scope of scopes.splice(0)) await run(Scope.close(scope, Exit.void));
});

// The SDK's in-memory ledger simulator, which produces a block for each transaction submitted.
async function simulatorOf() {
  const scope = Effect.runSync(Scope.make());
  scopes.push(scope);
  return run(Scope.extend(Simulator.init({ networkId: NETWORK }), scope));
}

// wallet-sdk-dust-wallet 4.2.0 with feeTransacting's fee transactions, synced from the SDK's
// in-memory ledger simulator instead of an indexer, holding one DUST coin per NIGHT UTXO it
// registered. A registration backdates DUST generation only for the one UTXO that pays its fee,
// so each UTXO has a key and a registration of its own, two hours after its NIGHT arrived: each
// coin starts with two hours of DUST, and the last registration is the newest DUST event the
// wallet applies, as new as the simulator's clock.
async function dustOnSimulator(nightUtxos: number, simulator?: Simulator) {
  simulator ??= await simulatorOf();
  const secretKey = L.DustSecretKey.fromSeed(randomBytes(32));
  const Wallet = CustomDustWallet(
    { simulator, networkId: NETWORK, costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 } },
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

  const nights = Array.from({ length: nightUtxos }, () => L.sampleSigningKey());
  for (const night of nights) await run(simulator.rewardNight(L.signatureVerifyingKey(night), 150_000_000_000n));
  await run(simulator.fastForward(7_200n));
  for (const night of nights) {
    const nightKey = L.signatureVerifyingKey(night);
    const before = await run(simulator.getLatestState());
    const utxos = [...before.ledger.utxo.filter(L.addressFromKey(nightKey))].map((utxo) => ({ ...utxo, ctime: before.ledger.utxo.lookupMeta(utxo)!.ctime, registeredForDustGeneration: false }));
    const registration = await wallet.createDustGenerationTransaction(before.currentTime, new Date(before.currentTime.getTime() + 60_000), utxos, nightKey, (await firstValueFrom(wallet.state)).address);
    const signed = await wallet.addDustGenerationSignature(registration, L.signData(night, registration.intents!.get(1)!.signatureData(1)));
    await run(simulator.submitTransaction(await prover.prove(signed)));
  }

  await firstValueFrom(wallet.state.pipe(filter((s) => s.availableCoins.length === nightUtxos)));
  // A block with nothing of the wallet's in it, which the wallet applies like any other.
  const anotherBlock = async (w = wallet) => {
    const block = await run(simulator.rewardNight(L.signatureVerifyingKey(L.sampleSigningKey()), 1n));
    await firstValueFrom(w.state.pipe(filter((s) => s.progress.appliedIndex > block.number)));
  };
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
  return { simulator, wallet, anotherBlock, now, balanced, coins, syncTime, reopen, restored };
}

const dustCtimes = (tx: L.ProofErasedTransaction) => [...(tx.intents?.values() ?? [])].flatMap((intent) => (intent.dustActions ? [intent.dustActions.ctime] : []));

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

describe("a fee's DUST spend", () => {
  // The node checks a DUST spend's proof against the DUST trees as they stood at the spend's
  // ctime. On preprod, wallet-sdk-dust-wallet 4.2.0 dated a fee at the indexer's newest block,
  // which held a stranger's DUST spend the wallet had not applied yet: the proof matched the
  // trees one event earlier, and the node refused it (Custom error: 170, InvalidDustSpendProof).
  it("is dated at the newest DUST event the wallet applied, not at the chain's newest block", async () => {
    const a = await dustOnSimulator(1);
    const stranger = await dustOnSimulator(1, a.simulator);
    await a.anotherBlock();
    const snapshot = await a.wallet.serializeState();
    await run(a.simulator.fastForward(60n));
    await run(a.simulator.submitTransaction(await stranger.balanced()));
    const lagging = a.restored(snapshot);
    const applied = await a.syncTime(lagging);
    expect(applied.getTime()).toBeLessThan((await a.now()).getTime());

    const paid = await a.balanced(lagging);
    expect(dustCtimes(paid)).toEqual([applied]);
    await expect(run(a.simulator.submitTransaction(paid))).resolves.toMatchObject({ transactions: [{ tx: paid }] });
  });

  // The node accepts a DUST spend only in blocks up to its ctime plus the grace period (Custom
  // error: 171, OutOfDustValidityWindow, after that), and the wallet holds the coin it spends
  // until then: both must outlast the transaction's TTL plus the journal's margin.
  it("is refused, before anything is spent, when the wallet's newest DUST event is too old for the transaction's TTL", async () => {
    const { simulator, wallet, now, balanced, coins, syncTime } = await dustOnSimulator(1);
    const [coin] = await coins();
    const applied = await syncTime();
    const grace = Number(L.LedgerParameters.initialParameters().dust.dustGracePeriodSeconds) * 1000;
    const latest = new Date(applied.getTime() + grace - TTL_MARGIN_MILLIS);
    await run(simulator.fastForward(BigInt((latest.getTime() - 15 * 60_000 - (await now()).getTime()) / 1000)));

    const late = new Date(latest.getTime() + 1000);
    await expect(balanced(wallet, late)).rejects.toThrow(
      `the fee's DUST spend would date from ${applied.toISOString()}, the newest DUST event this wallet applied, and the node accepts it only until ${new Date(applied.getTime() + grace).toISOString()}, which is not past the transaction's TTL ${late.toISOString()} plus 5 minutes; no DUST was spent`,
    );
    expect(await coins()).toEqual([coin]);
    const paid = await balanced(wallet, latest);
    await expect(run(simulator.submitTransaction(paid))).resolves.toMatchObject({ transactions: [{ tx: paid }] });
  });
});
