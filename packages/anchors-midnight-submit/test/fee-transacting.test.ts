import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import { TTL_MARGIN_MILLIS } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { NIGHT, closeSimulators, dustOnSimulator, run } from "./simulator.js";

afterEach(closeSimulators);

const dustCtimes = (tx: L.ProofErasedTransaction) => [...(tx.intents?.values() ?? [])].flatMap((intent) => (intent.dustActions ? [intent.dustActions.ctime] : []));

describe("reverting a fee transaction that never landed", () => {
  // On preprod, a transaction the node refused was reverted after the wallet had applied newer
  // DUST events: wallet-sdk-dust-wallet 4.2.0 had already forgotten which coin it spent, and the
  // wallet's one coin stayed spent for the ledger's three-hour grace period.
  it("frees the coin it spent, even after the wallet applied a newer block", async () => {
    const { wallet, anotherBlock, balanced, coins } = await dustOnSimulator([NIGHT]);
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
    const { wallet, balanced, coins, reopen } = await dustOnSimulator([NIGHT, NIGHT]);
    await balanced();
    const [later] = await coins();
    const refused = await balanced();
    expect(await coins()).toEqual([]);
    await wallet.revertTransaction(refused);
    expect(await coins()).toEqual([later]);
    expect(await coins(await reopen())).toEqual([later]);
  });

  it("leaves the freed coin free in the state saved and restored after it", async () => {
    const { wallet, anotherBlock, balanced, coins, reopen } = await dustOnSimulator([NIGHT]);
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
    const a = await dustOnSimulator([NIGHT]);
    const stranger = await dustOnSimulator([NIGHT], { simulator: a.simulator });
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
    const { simulator, wallet, now, balanced, coins, syncTime } = await dustOnSimulator([NIGHT]);
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

// How long a balancing may take once its process has set up the wallet: a few dry runs.
const BALANCING_MS = 30_000;

interface Balanced {
  coinValues: string[];
  feeAsItIs: string;
  error?: string;
  intents?: Array<string[] | null>;
  coinsUntouched?: boolean;
  landed?: true | string;
}

// Runs a scenario of balance-on-simulator.ts in a process of its own and kills it when its
// balancing has not returned within BALANCING_MS: nothing inside that process can interrupt the
// synchronous loop of an unterminated balancing.
function balancing(scenario: string): Promise<Balanced> {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./balance-on-simulator.ts", import.meta.url)), scenario], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  let timer: NodeJS.Timeout | undefined;
  return new Promise((resolve, reject) => {
    child.stderr.on("data", (chunk) => (err += chunk));
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (timer === undefined && out.includes("balancing\n")) {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`the ${scenario} balancing did not return within ${BALANCING_MS / 1000} s`));
        }, BALANCING_MS);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = out.split("\n").find((line) => line.startsWith("{"));
      if (code === 0 && result) resolve(JSON.parse(result));
      else reject(new Error(`the ${scenario} balancing exited ${code}: ${err.slice(-2000)}`));
    });
  });
}

// wallet-sdk-dust-wallet 4.2.0 selects DUST until it covers the fee its dry run computes, seeding
// every round after the first with that fee as a surplus: once the first round's coins cover the
// fee of the transaction as it is but not the fee their own spends add, no round selects anything
// again and the loop never ends (midnight-wallet#438, #700). The workspace runs it with
// midnight-wallet#741, whose rounds each select against the outstanding deficit.
describe("balancing a fee", () => {
  it("terminates when the smallest coin covers the fee of the transaction as it is but not that fee plus its own spend, and the simulator takes the result", async () => {
    const r = await balancing("under-covered");
    const [small, large] = r.coinValues.map(BigInt) as [bigint, bigint];
    expect(small).toBeGreaterThanOrEqual(BigInt(r.feeAsItIs));
    expect(r.error).toBeUndefined();
    // The smaller coin, chosen first, pays all it holds; the larger pays the rest of the fee.
    const [base, fee] = r.intents!;
    expect(base).toBeNull();
    expect(fee).toHaveLength(2);
    expect(BigInt(fee![0]!)).toBe(small);
    expect(BigInt(fee![1]!)).toBeLessThan(large);
    expect(r.landed).toBe(true);
  });

  // A transaction that already covers its fee needs no DUST spend, and an intent with empty
  // DustActions is not well-formed: midnight-node refused one with Custom error: 117 (#700).
  it("adds no intent and spends no DUST for a fee computed as 0, and the simulator takes the transaction as it is", async () => {
    const r = await balancing("zero-fee");
    expect(r.feeAsItIs).toBe("0");
    expect(r).toMatchObject({ intents: [null], coinsUntouched: true, landed: true });
  });

  // The wallet's 1 SPECK of overhead keeps every fee above 0, so a fee is always paid with a DUST
  // spend: on a quiet chain one spend of one coin pays that SPECK and the 1 SPECK its own spend
  // costs at the floor prices.
  it("with the wallet's 1 SPECK of overhead, pays it and its own spend from one coin, and the simulator takes it", async () => {
    const r = await balancing("zero-fee-with-overhead");
    expect(r.feeAsItIs).toBe("1");
    expect(r).toMatchObject({ intents: [null, ["2"]], landed: true });
  });
});
