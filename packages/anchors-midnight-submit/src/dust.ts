import * as L from "@midnight-ntwrk/ledger-v8";
import { Transacting, WalletError, type AnyTransaction, type CoreWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet/v1";
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

// wallet-sdk-dust-wallet 4.2.0's fee transactions, except that reverting one frees exactly the
// coins it spent. The SDK's own revert finds them in a list of this process's spends from which
// every applied sync update drops the held coins and which no restart restores, so a revert after
// either frees nothing for the grace period (three hours); and it frees by processing TTLs at the
// end of that period, which also frees every coin an earlier transaction still in flight spends
// and drops coins that run out by then (midnight-wallet#789).
export const exactRevert =
  (secretKey: L.DustSecretKey) =>
  (
    configuration: Transacting.DefaultTransactingConfiguration,
    getContext: () => Transacting.DefaultTransactingContext,
  ): Transacting.TransactingCapability<L.DustSecretKey, CoreWallet, L.FinalizedTransaction> => {
    const transacting = Transacting.makeDefaultTransactingCapability(configuration, getContext);
    transacting.revertTransaction = (wallet, tx) =>
      Either.try({
        try: () => releaseSpends(wallet, tx, secretKey),
        catch: (cause) => new WalletError.OtherWalletError({ message: `Error while reverting transaction ${tx.identifiers().at(0)}`, cause }),
      });
    return transacting;
  };
