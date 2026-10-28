// Balances one transaction's fee with openWallet's DUST fee payment (payingFees) on the SDK's simulator, in a
// process of its own: wallet-sdk-dust-wallet 4.2.0 balances in a synchronous loop, so a balancing
// that never returns can only be stopped by killing the process that runs it. Prints "balancing"
// just before it balances and then one JSON line of what it observed.
//   node --import tsx balance-on-simulator.ts small-and-large|under-covered|zero-fee|zero-fee-with-overhead
//   multi-round [quote/actual] affordable two-coin regression; short/full binding classes,
//                              default full/full, e.g. multi-round short/full
//   small-and-large         two coins, the smaller covering the fee of the transaction as it is but
//                           not that fee plus a DUST spend, the larger covering both
//   under-covered           two small coins, the larger covering the fee of the transaction as it
//                           is but not that fee plus its own DUST spend, and both together not that
//                           fee plus two spends
//   zero-fee                fee prices at the ledger's floor and no fee overhead: the fee computes as 0
//   zero-fee-with-overhead  the same with the wallet's 1 SPECK of overhead
import { readFileSync } from "node:fs";
import { buildRegistryDeploy, entryCommitment, unprovenRegistryCall, anchorCallsIn } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
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
  if (scenario === "mainnet-anchor") return dustOnSimulator([NIGHT, NIGHT]);
  if (scenario === "multi-round") return dustOnSimulator([14_500_000n, 14_500_000n]);
  if (scenario === "under-covered") return dustOnSimulator([SMALL, SMALL]);
  if (scenario !== "zero-fee" && scenario !== "zero-fee-with-overhead") throw new Error(`unknown scenario ${scenario}`);
  const quiet = await dustOnSimulator([NIGHT], { simulator: await simulatorOf(0), additionalFeeOverhead: scenario === "zero-fee" ? 0n : 1n });
  await quiet.blocks(QUIET_BLOCKS);
  return quiet;
};
const { simulator, wallet, secretKey, now, balanced, coins, anotherBlock } = await opened();

const ttl = new Date((await now()).getTime() + 15 * 60_000);
let baseTransaction = L.Transaction.fromParts(NETWORK, undefined, undefined, L.Intent.new(ttl));
let anchorEvidence = {};
if (scenario === "mainnet-anchor") {
  const deployed = buildRegistryDeploy({ networkId: NETWORK, ttl });
  await run(simulator.submitTransaction(await balanced(wallet, ttl, deployed.tx)));
  await anotherBlock();
  const state = await run(simulator.getLatestState());
  const observed = JSON.parse(readFileSync(new URL("./fixtures/mainnet-ledger-prices.json", import.meta.url), "utf8"));
  state.ledger.parameters = L.LedgerParameters.deserialize(Buffer.from(observed.parametersHex, "hex"));
  const secret = new Uint8Array(32); secret[0] = 1;
  const commitment = entryCommitment({ rootHash: "12".repeat(32), manifestHash: "34".repeat(32) });
  baseTransaction = unprovenRegistryCall({ networkId: NETWORK, address: deployed.address, state: state.ledger.index(deployed.address)!, ttl,
    call: { circuit: "anchor", args: [commitment, 1n] }, witnesses: { authorSecret: secret } }).tx;
  anchorEvidence = { observedMainnetBlock: observed.blockHeight, observedMainnetHash: observed.blockHash, parametersSha256: observed.parametersSha256, registry: deployed.address };
}
// What each coin the wallet can spend holds at the date the fee's DUST spend carries, smallest first.
const coinValues = async () => {
  const state = await firstValueFrom(wallet.state);
  return state.capabilities.coinsAndBalances
    .getAvailableCoinsWithGeneratedDust(state.state, state.state.state.syncTime)
    .map((coin) => coin.value)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};
const valuesBefore = await coinValues();
const feeAsItIs = await wallet.calculateFee([baseTransaction]);
const coinsBefore = JSON.stringify((await coins()).map(String));

// Each transaction's encoded size, and its DUST actions' share of it.
const encodedSizes = (transaction: { serialize(): Uint8Array; intents: Map<number, { dustActions: { serialize(): Uint8Array } | undefined }> | undefined }) => ({
  bytes: transaction.serialize().length,
  dustBytes: [...(transaction.intents?.values() ?? [])].reduce((sum, intent) => sum + (intent.dustActions?.serialize().length ?? 0), 0),
});

// Intent.new samples binding randomness. Its merged scalar has variable-width encoding,
// so independently sampled fee intents can differ by a priced byte even at a fixed clock.
// Keep valid intent entropy repeatable only in this isolated regression process: the oracle
// and real wallet still execute their own ledger dry runs, spend selection and proof paths.
// Select both scalar encoding classes so the former intermittent mismatch stays exercised.
// Every transaction a dry run prices is recorded with its encoded sizes.
const bindingCase = process.argv[3] ?? "full/full";
const repeatableFeeIntents = () => {
  const [quoteClass, actualClass] = bindingCase.split("/");
  if (![quoteClass, actualClass].every(value => value === "short" || value === "full")) throw new Error("unknown binding case");
  const makeIntent = L.Intent.new;
  const prototype = Transacting.TransactingCapabilityImplementation.prototype;
  const dryRunFee = prototype.dryRunFee;
  const calculateFee = prototype.calculateFee;
  const priced: Array<{ fee: bigint; bytes: number; dustBytes: number }> = [];
  const templates = new Map<number, Uint8Array>();
  let longest = 0;
  // The prefix and marker lengths are constant; the varying merged scalar is the only
  // differing field. Bounded sampling finds a full-width encoding and one byte shorter.
  for (let attempt = 0; attempt < 1024 && (attempt < 64 || !templates.has(longest - 1)); attempt++) {
    const intent = makeIntent(ttl);
    const merged = baseTransaction.merge(L.Transaction.fromParts(NETWORK).addIntent({ tag: "specific", value: 2 }, intent));
    const length = merged.eraseProofs().serialize().length;
    templates.set(length, intent.serialize()); longest = Math.max(longest, length);
  }
  const quoteLength = longest - (quoteClass === "short" ? 1 : 0), actualLength = longest - (actualClass === "short" ? 1 : 0);
  const quote = templates.get(quoteLength), actual = templates.get(actualLength);
  if (!quote || !actual) throw new Error("could not find both merged binding encoding classes");
  let pricing = false;
  prototype.dryRunFee = function (...args) {
    const previous = pricing; pricing = true;
    try { return dryRunFee.apply(this, args); } finally { pricing = previous; }
  };
  prototype.calculateFee = function (transaction, parameters) {
    const fee = calculateFee.call(this, transaction, parameters);
    if (pricing) priced.push({ fee, ...encodedSizes(transaction) });
    return fee;
  };
  L.Intent.new = expiry => {
    if (expiry.getTime() !== ttl.getTime()) throw new Error("unexpected fee-intent TTL");
    return L.Intent.deserialize("signature", "pre-proof", "pre-binding", pricing ? quote : actual);
  };
  return {
    quoteLength, actualLength, priced,
    restore() { L.Intent.new = makeIntent; prototype.dryRunFee = dryRunFee; prototype.calculateFee = calculateFee; },
  };
};
const fixedFeeIntents = scenario === "multi-round" ? repeatableFeeIntents() : undefined;
let multiRoundEvidence = {};
let pricingParameters: string | undefined, pricingTime: number | undefined;
const executeBalance = async () => {
  if (scenario === "multi-round") {
    const state = await firstValueFrom(wallet.state);
    const snapshot = await run(simulator.getLatestState());
    const params = snapshot.ledger.parameters;
    pricingParameters = Buffer.from(params.serialize()).toString("hex"); pricingTime = snapshot.currentTime.getTime();
    const original = new Transacting.TransactingCapabilityImplementation<L.FinalizedTransaction>(NETWORK, { additionalFeeOverhead: 1n, feeBlocksMargin: 5 },
      () => available => available.slice().sort((a, b) => a.value > b.value ? -1 : a.value < b.value ? 1 : 0)[0],
      () => state.capabilities.coinsAndBalances, () => state.capabilities.keys);
    const available = state.capabilities.coinsAndBalances.getAvailableCoinsWithGeneratedDust(state.state, state.state.state.syncTime).slice()
      .sort((a, b) => a.value > b.value ? -1 : a.value < b.value ? 1 : 0);
    const one = original.dryRunFee(available.slice(0, 1), [baseTransaction], secretKey, state.state, ttl, state.state.state.syncTime, params);
    const all = original.dryRunFee(available, [baseTransaction], secretKey, state.state, ttl, state.state.state.syncTime, params);
    const old = original.computeBalancingRecipe(secretKey, state.state, [baseTransaction], ttl, state.state.state.syncTime, params);
    multiRoundEvidence = { feeWithOne: one, feeWithAll: all, legacyError: Either.isLeft(old) ? old.left.message : null, bindingCase,
      quoteEmptyBytes: fixedFeeIntents!.quoteLength, actualEmptyBytes: fixedFeeIntents!.actualLength };
  }
  process.stdout.write("balancing\n");
  return balanced(wallet, ttl, baseTransaction).then(
    (paid) => ({ paid }),
    (error: Error) => ({ error: error.message }),
  );
};
const balancing = await executeBalance().finally(() => fixedFeeIntents?.restore());
const finalSnapshot = await run(simulator.getLatestState());
const finalParameters = finalSnapshot.ledger.parameters;
// The dry run that set the fee the DUST spends pay, beside the balanced transaction; the
// simulator's proving service erases proofs, as dry runs do.
const quotedAndBalanced = (paid: L.ProofErasedTransaction) => {
  const fee = [...paid.intents!.values()].flatMap((intent) => intent.dustActions?.spends.map((spend) => spend.vFee) ?? []).reduce((sum, vFee) => sum + vFee, 0n);
  const quoted = [...fixedFeeIntents!.priced].reverse().find((entry) => entry.fee === fee);
  if (!quoted) throw new Error(`no dry run priced the paid fee ${fee}`);
  const balanced = encodedSizes(paid);
  return { quotedBytes: quoted.bytes, quotedDustBytes: quoted.dustBytes, balancedBytes: balanced.bytes, balancedDustBytes: balanced.dustBytes };
};
const observed =
  "error" in balancing
    ? balancing
    : {
        ...(scenario === "mainnet-anchor" ? { anchorCalls: anchorCallsIn(balancing.paid, [(anchorEvidence as { registry: string }).registry], "mainnet-price simulator").calls.map(call => ({ kind: call.kind, entryPoint: call.entryPoint, commitment: call.commitment })) } : {}),
        ...(scenario === "multi-round" ? { actualMinimumFee: balancing.paid.fees(finalParameters), actualFeeWithMargin: balancing.paid.feesWithMargin(finalParameters, 5) + 1n,
          pricingParametersUnchanged: pricingParameters === Buffer.from(finalParameters.serialize()).toString("hex"), pricingTimeUnchanged: pricingTime === finalSnapshot.currentTime.getTime(),
          ...quotedAndBalanced(balancing.paid) } : {}),
        // Each intent's DUST spends, by the fee each pays, or null for an intent without DUST actions.
        intents: [...balancing.paid.intents!.values()].map((intent) => intent.dustActions?.spends.map((spend) => spend.vFee) ?? null),
        coinsUntouched: JSON.stringify((await coins()).map(String)) === coinsBefore,
        coinsLeft: await coinValues(),
        landed: await run(simulator.submitTransaction(balancing.paid)).then(
          () => true,
          (error: Error) => error.message,
        ),
      };
process.stdout.write(`${JSON.stringify({ coinValues: valuesBefore, feeAsItIs, ...anchorEvidence, ...multiRoundEvidence, ...observed }, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);
await closeSimulators();
process.exit(0);
