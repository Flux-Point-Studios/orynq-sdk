// Balances one transaction's fee with openWallet's DUST fee payment (payingFees) on the SDK's simulator, in a
// process of its own: wallet-sdk-dust-wallet 4.2.0 balances in a synchronous loop, so a balancing
// that never returns can only be stopped by killing the process that runs it. Prints "balancing"
// just before it balances and then one JSON line of what it observed.
//   node --import tsx balance-on-simulator.ts small-and-large|under-covered|zero-fee|zero-fee-with-overhead
//   small-and-large         two coins, the smaller covering the fee of the transaction as it is but
//                           not that fee plus a DUST spend, the larger covering both
//   under-covered           two small coins, the larger covering the fee of the transaction as it
//                           is but not that fee plus its own DUST spend, and both together not that
//                           fee plus two spends
//   zero-fee                fee prices at the ledger's floor and no fee overhead: the fee computes as 0
//   zero-fee-with-overhead  the same with the wallet's 1 SPECK of overhead
import { firstValueFrom } from "rxjs";
import { Either } from "effect";
import { Transacting } from "@midnight-ntwrk/wallet-sdk-dust-wallet/v1";
import * as L from "@midnight-ntwrk/ledger-v8";
import { NETWORK, NIGHT, closeSimulators, dustOnSimulator, run, simulatorOf } from "./simulator.js";

const scenario = process.argv[2];
// Twelve NIGHT backdated by two hours leave a coin worth about 2.3e14 SPECK once its registration
// is paid: above the 6.6e13 the transaction costs as it is at the simulator's initial fee prices,
// below the 4.3e14 it costs with one DUST spend.
const SMALL = 12_000_000n;
// Blocks of fullness 0 that bring the simulator's fee prices to the ledger's floor.
const QUIET_BLOCKS = 1_000;

const opened = async () => {
  if (scenario === "small-and-large") return dustOnSimulator([NIGHT, SMALL]);
  if (scenario === "multi-round") return dustOnSimulator([14_500_000n, 14_500_000n]);
  if (scenario === "under-covered") return dustOnSimulator([SMALL, SMALL]);
  if (scenario !== "zero-fee" && scenario !== "zero-fee-with-overhead") throw new Error(`unknown scenario ${scenario}`);
  const quiet = await dustOnSimulator([NIGHT], { simulator: await simulatorOf(0), additionalFeeOverhead: scenario === "zero-fee" ? 0n : 1n });
  await quiet.blocks(QUIET_BLOCKS);
  return quiet;
};
const { simulator, wallet, secretKey, now, balanced, coins } = await opened();

const ttl = new Date((await now()).getTime() + 15 * 60_000);
// What each coin the wallet can spend holds at the date the fee's DUST spend carries, smallest first.
const coinValues = async () => {
  const state = await firstValueFrom(wallet.state);
  return state.capabilities.coinsAndBalances
    .getAvailableCoinsWithGeneratedDust(state.state, state.state.state.syncTime)
    .map((coin) => coin.value)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};
const valuesBefore = await coinValues();
const feeAsItIs = await wallet.calculateFee([L.Transaction.fromParts(NETWORK, undefined, undefined, L.Intent.new(ttl))]);
const coinsBefore = JSON.stringify((await coins()).map(String));

let multiRoundEvidence = {};
if (scenario === "multi-round") {
  const state = await firstValueFrom(wallet.state);
  const params = (await run(simulator.getLatestState())).ledger.parameters;
  const original = new Transacting.TransactingCapabilityImplementation<L.FinalizedTransaction>(NETWORK, { additionalFeeOverhead: 1n, feeBlocksMargin: 5 },
    () => available => available.slice().sort((a, b) => a.value > b.value ? -1 : a.value < b.value ? 1 : 0)[0],
    () => state.capabilities.coinsAndBalances, () => state.capabilities.keys);
  const available = state.capabilities.coinsAndBalances.getAvailableCoinsWithGeneratedDust(state.state, state.state.state.syncTime).slice()
    .sort((a, b) => a.value > b.value ? -1 : a.value < b.value ? 1 : 0);
  const tx = L.Transaction.fromParts(NETWORK, undefined, undefined, L.Intent.new(ttl));
  const one = original.dryRunFee(available.slice(0, 1), [tx], secretKey, state.state, ttl, state.state.state.syncTime, params);
  const all = original.dryRunFee(available, [tx], secretKey, state.state, ttl, state.state.state.syncTime, params);
  const old = original.computeBalancingRecipe(secretKey, state.state, [tx], ttl, state.state.state.syncTime, params);
  multiRoundEvidence = { feeWithOne: one, feeWithAll: all, legacyError: Either.isLeft(old) ? old.left.message : null };
}
process.stdout.write("balancing\n");
const balancing = await balanced(wallet, ttl).then(
  (paid) => ({ paid }),
  (error: Error) => ({ error: error.message }),
);
const observed =
  "error" in balancing
    ? balancing
    : {
        // Each intent's DUST spends, by the fee each pays, or null for an intent without DUST actions.
        intents: [...balancing.paid.intents!.values()].map((intent) => intent.dustActions?.spends.map((spend) => spend.vFee) ?? null),
        coinsUntouched: JSON.stringify((await coins()).map(String)) === coinsBefore,
        coinsLeft: await coinValues(),
        landed: await run(simulator.submitTransaction(balancing.paid)).then(
          () => true,
          (error: Error) => error.message,
        ),
      };
process.stdout.write(`${JSON.stringify({ coinValues: valuesBefore, feeAsItIs, ...multiRoundEvidence, ...observed }, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);
await closeSimulators();
process.exit(0);
