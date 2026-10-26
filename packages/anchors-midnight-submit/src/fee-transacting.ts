import * as L from "@midnight-ntwrk/ledger-v8";
import {
  Transacting,
  WalletError,
  type AnyTransaction,
  type BaseV1Configuration,
  type CoinsAndBalances,
  type CoreWallet,
  type RunningV1Variant,
  type V1Builder,
} from "@midnight-ntwrk/wallet-sdk-dust-wallet/v1";
import { TTL_MARGIN_MILLIS } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { Either } from "effect";

// Frees exactly the DUST coins `tx` spends. A spend holds its coin until its DUST actions' ctime
// plus the ledger's grace period, the last block time that may include it; processing TTLs at
// that time lists the coin again, and it goes back under its nullifier with no hold. A coin worth
// nothing by then is not listed and stays held; one the chain has spent is gone from the state.
function releaseSpends(wallet: CoreWallet, tx: AnyTransaction, secretKey: L.DustSecretKey): CoreWallet {
  let state = wallet.state;
  const spent = new Set<L.DustNullifier>();
  for (const intent of tx.intents?.values() ?? []) {
    const actions = intent.dustActions;
    if (!actions) continue;
    const holdEnds = new Date(actions.ctime.getTime() + Number(wallet.state.params.dustGracePeriodSeconds) * 1000);
    const listed = wallet.state.processTtls(holdEnds).utxos;
    for (const { oldNullifier } of actions.spends) {
      spent.add(oldNullifier);
      const coin = listed.find((utxo) => L.dustNullifier(utxo, secretKey) === oldNullifier);
      if (coin) state = state.addUtxo(oldNullifier, coin);
    }
  }
  return { ...wallet, state, pendingDust: wallet.pendingDust.filter((coin) => !spent.has(coin.nullifier)) };
}

// wallet-sdk-dust-wallet 4.2.0's fee transactions with exact coin-prefix pricing,
// synchronized spend dates and precise release of unbroadcast fees.
//
// A fee's DUST spend is dated at the newest DUST event the wallet applied (the local state's
// syncTime), not at the indexer's newest block. The node checks the spend's proof against the
// DUST trees as they stood at that date, and the SDK proves against the trees the wallet applied
// from the indexer's event stream but dates the spend from a separate query for the newest block
// (midnight-wallet's own TODO: "replace currentTime with updatedState.syncTime"). A DUST event in
// that block the wallet has not applied yet makes the proof match an older root, and the node
// refuses it (Custom error: 170). The node accepts the spend only in blocks up to its date plus the
// grace period, and the wallet holds the coin it spends until then, so a fee whose date is too old
// for the transaction's TTL plus the journal's margin is refused before anything is spent.
//
// Reverting a fee frees exactly the coins it spent. The SDK's own revert finds them in a list of
// this process's spends from which every applied sync update drops the held coins and which no
// restart restores, so a revert after either frees nothing for the grace period (three hours);
// and it frees by processing TTLs at the end of that period, which also frees every coin an
// earlier transaction still in flight spends and drops coins that run out by then
// (midnight-wallet#789).
const feeTransacting =
  (secretKey: L.DustSecretKey) =>
  (
    configuration: Transacting.DefaultTransactingConfiguration,
    getContext: () => Transacting.DefaultTransactingContext,
  ): Transacting.TransactingCapability<L.DustSecretKey, CoreWallet, L.FinalizedTransaction> => {
    const transacting = new Transacting.TransactingCapabilityImplementation<L.FinalizedTransaction>(
      configuration.networkId, configuration.costParameters,
      () => getContext().coinSelection, () => getContext().coinsAndBalancesCapability, () => getContext().keysCapability,
    );
    // The SDK's average marginal-spend estimate includes the first balancing-intent overhead.
    // Applying it again to later inputs can reject affordable combinations. Price each largest
    // prefix against the ledger instead: at most one dry run per available coin, no estimates.
    transacting.computeBalancingRecipe = (sk, state, transactions, ttl, currentTime, parameters) => Either.try({
      try: () => {
        const existingDust = transactions.reduce((sum, transaction) => {
          const fee = transacting.calculateFee(transaction, parameters);
          return sum + Transacting.TransactingCapabilityImplementation.feeImbalance(transaction, fee) + fee;
        }, 0n);
        let fee = transacting.dryRunFee([], transactions, sk, state, ttl, currentTime, parameters);
        if (existingDust >= fee) return { fee, recipeInputs: [] };
        const available = getContext().coinsAndBalancesCapability.getAvailableCoinsWithGeneratedDust(state, currentTime)
          .filter(coin => coin.value > 0n).sort((a, b) => a.value > b.value ? -1 : a.value < b.value ? 1 : 0);
        const selected: typeof available = [];
        let coverage = existingDust;
        for (const coin of available) {
          selected.push(coin); coverage += coin.value;
          fee = transacting.dryRunFee(selected, transactions, sk, state, ttl, currentTime, parameters);
          if (coverage < fee) continue;
          let remaining = fee - existingDust;
          return { fee, recipeInputs: selected.map(input => {
            const value = input.value < remaining ? input.value : remaining;
            remaining -= value;
            return { ...input, value };
          }) };
        }
        throw new WalletError.InsufficientFundsError({ message: "Insufficient Funds: no available largest-first DUST prefix covers its exact fee", tokenType: "dust" });
      },
      catch: cause => cause instanceof WalletError.InsufficientFundsError ? cause : new WalletError.TransactingError({ message: "Exact DUST fee pricing failed", cause }),
    });
    const balance = transacting.balanceTransactions.bind(transacting);
    transacting.balanceTransactions = (sk, wallet, transactions, ttl, _currentTime, ledgerParameters) => {
      const ctime = wallet.state.syncTime;
      const accepted = new Date(ctime.getTime() + Number(ledgerParameters.dust.dustGracePeriodSeconds) * 1000);
      if (accepted.getTime() < ttl.getTime() + TTL_MARGIN_MILLIS) {
        return Either.left(
          new WalletError.TransactingError({
            message: `the fee's DUST spend would date from ${ctime.toISOString()}, the newest DUST event this wallet applied, and the node accepts it only until ${accepted.toISOString()}, which is not past the transaction's TTL ${ttl.toISOString()} plus ${TTL_MARGIN_MILLIS / 60_000} minutes; no DUST was spent`,
          }),
        );
      }
      return balance(sk, wallet, transactions, ttl, ctime, ledgerParameters);
    };
    transacting.revertTransaction = (wallet, tx) =>
      Either.try({
        try: () => releaseSpends(wallet, tx, secretKey),
        catch: (cause) => new WalletError.OtherWalletError({ message: `Error while reverting transaction ${tx.identifiers().at(0)}`, cause }),
      });
    return transacting;
  };

// The coin a fee spends next: the largest one worth anything, so a fee one coin can pay is paid by
// one coin. Every DUST spend adds to the fee, and wallet-sdk-dust-wallet's default order, smallest
// first, spends every coin too small to pay alone before a larger one, again on each later fee.
const largestFirst: CoinsAndBalances.CoinSelection = (coins) =>
  coins.reduce<(typeof coins)[number] | undefined>((largest, coin) => (coin.value > 0n && (largest === undefined || coin.value > largest.value) ? coin : largest), undefined);

// `builder` paying fees as the operator's wallet does: feeTransacting's fee transactions, spending
// coins largest first.
export const payingFees = <TConfig extends BaseV1Configuration, TContext extends Partial<RunningV1Variant.AnyContext>, TSerialized, TSyncUpdate, TStartAux extends object>(
  builder: V1Builder<TConfig, TContext, TSerialized, TSyncUpdate, L.FinalizedTransaction, TStartAux>,
  secretKey: L.DustSecretKey,
) => builder.withTransacting(feeTransacting(secretKey)).withCoinSelection(() => largestFirst);
