import * as L from "@midnight-ntwrk/ledger-v8";
import { Transacting, WalletError, type AnyTransaction, type CoreWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet/v1";
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

// wallet-sdk-dust-wallet 4.2.0's fee transactions, with two changes.
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
export const feeTransacting =
  (secretKey: L.DustSecretKey) =>
  (
    configuration: Transacting.DefaultTransactingConfiguration,
    getContext: () => Transacting.DefaultTransactingContext,
  ): Transacting.TransactingCapability<L.DustSecretKey, CoreWallet, L.FinalizedTransaction> => {
    const transacting = Transacting.makeDefaultTransactingCapability(configuration, getContext);
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
