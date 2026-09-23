import { describe, expect, it, vi } from "vitest";

import {
  createChainedSubmitQueue,
  isSpentInputError,
  SubmitQueueFullError,
  type ChainedBuild,
  type ChainedSubmitQueueOptions,
  type ChainedTx,
} from "../chained-submit-queue.js";

/** Verbatim from the preprod worker's logs on 2026-09-22. */
const BLOCKFROST_SPENT =
  '(FiberFailure) TxSubmitError: Error: {"contents":{"contents":{"contents":{"era":"ShelleyBasedEraConway","error":["ConwayMempoolFailure \\"All inputs are spent. Transaction has probably already been included\\""],"kind":"ShelleyTxValidationError"},"tag":"TxValidationErrorInCardanoMode"},"tag":"TxCmdTxSubmitValidationError"},"tag":"TxSubmitFail"}';

interface Utxo {
  txHash: string;
  outputIndex: number;
  lovelace: bigint;
}

const ref = (u: Utxo) => `${u.txHash}#${u.outputIndex}`;

/**
 * A node and an indexer in one. Like Blockfrost, `providerUtxos` shows only
 * outputs confirmed in a block, including ones a mempool tx has already spent;
 * `submit` validates against the ledger plus the mempool, as a node does.
 */
class FakeChain {
  private ledger = new Map<string, Utxo>();
  private mempool = new Map<string, Utxo>();
  private spentInMempool = new Set<string>();
  private everSpent = new Set<string>();
  private counter = 0;
  readonly txs: Array<{ txHash: string; inputs: string[]; label: string }> = [];

  constructor(lovelace: bigint) {
    const genesis = { txHash: "genesis", outputIndex: 0, lovelace };
    this.ledger.set(ref(genesis), genesis);
  }

  providerUtxos(): Utxo[] {
    return [...this.ledger.values()];
  }

  /** Signs a tx spending `inputs`; the node sees nothing until `submit`. */
  sign(inputs: Utxo[], label: string): { txHash: string; change: Utxo; submit: () => Promise<void> } {
    const txHash = `tx${++this.counter}`;
    const total = inputs.reduce((sum, u) => sum + u.lovelace, 0n);
    const change = { txHash, outputIndex: 0, lovelace: total - 200_000n };
    return { txHash, change, submit: async () => this.accept(txHash, inputs, change, label) };
  }

  private accept(txHash: string, inputs: Utxo[], change: Utxo, label: string): void {
    for (const input of inputs) {
      const key = ref(input);
      const known = this.ledger.has(key) || this.mempool.has(key);
      if (!known || this.spentInMempool.has(key)) throw new Error(BLOCKFROST_SPENT);
    }
    for (const input of inputs) {
      const key = ref(input);
      if (this.everSpent.has(key)) throw new Error(`double spend of ${key}`);
      this.everSpent.add(key);
      this.spentInMempool.add(key);
    }
    this.mempool.set(ref(change), change);
    this.txs.push({ txHash, inputs: inputs.map(ref), label });
  }

  block(): void {
    for (const [key, utxo] of this.mempool) this.ledger.set(key, utxo);
    for (const key of this.spentInMempool) this.ledger.delete(key);
    this.mempool.clear();
    this.spentInMempool.clear();
  }

  isOnChain(txHash: string): boolean {
    return [...this.ledger.values()].some((u) => u.txHash === txHash);
  }
}

/** Spends the largest UTxO it is given, or the provider's view when given none. */
function anchorBuilder(chain: FakeChain, label: string): ChainedBuild<Utxo> {
  return async (walletUtxos) => {
    const available = walletUtxos ?? chain.providerUtxos();
    const input = [...available].sort((a, b) => Number(b.lovelace - a.lovelace))[0];
    if (!input) throw new Error("wallet is empty");
    const { txHash, change, submit } = chain.sign([input], label);
    return { txHash, walletUtxos: [change, ...available.filter((u) => u !== input)], submit };
  };
}

/** The same tx, but its submission fails with `error` after `reachesNode` decides whether the node got it. */
function failingSubmit(build: ChainedBuild<Utxo>, error: Error, reachesNode: boolean): ChainedBuild<Utxo> {
  return async (walletUtxos) => {
    const tx = await build(walletUtxos);
    return {
      ...tx,
      submit: async () => {
        if (reachesNode) await tx.submit();
        throw error;
      },
    };
  };
}

/** Records each awaited tip, produces a block, and reports whether the tip is in it. */
function blockThenCheck(chain: FakeChain, awaited: string[]) {
  return async (txHash: string) => {
    awaited.push(txHash);
    chain.block();
    return chain.isOnChain(txHash);
  };
}

/** Records what each build is handed. */
function watched(build: ChainedBuild<Utxo>, seen: Array<Utxo[] | undefined>): ChainedBuild<Utxo> {
  return (walletUtxos) => {
    seen.push(walletUtxos);
    return build(walletUtxos);
  };
}

/** A build that never touches a chain: tx1, tx2, ... */
function counterBuild() {
  let n = 0;
  return vi.fn<[Utxo[] | undefined], Promise<ChainedTx<Utxo>>>(async () => {
    const txHash = `tx${++n}`;
    return {
      txHash,
      walletUtxos: [{ txHash, outputIndex: 0, lovelace: 1n }],
      submit: async () => undefined,
    };
  });
}

function options(overrides: Partial<ChainedSubmitQueueOptions> = {}): ChainedSubmitQueueOptions {
  return {
    maxChainLength: 100,
    cacheTtlMs: 90_000,
    maxPending: 1_000,
    dedupeTtlMs: 3_600_000,
    dedupeMaxEntries: 1_000,
    awaitConfirmation: async () => true,
    ...overrides,
  };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe("FakeChain", () => {
  it("reproduces the production failure when builds are not serialized", async () => {
    /** Control: without it, a queue test could pass against a chain that
     * accepts anything. 224 concurrent requests landed 15 in production. */
    const chain = new FakeChain(100_000_000n);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, i) => (await anchorBuilder(chain, `k${i}`)(undefined)).submit())
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(chain.txs).toHaveLength(1);
  });
});

describe("createChainedSubmitQueue", () => {
  it("lands N concurrent submissions in order, each spending the previous tx's change", async () => {
    const chain = new FakeChain(100_000_000n);
    const queue = createChainedSubmitQueue<Utxo>(options());

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        queue.submit(`k${i}`, anchorBuilder(chain, `k${i}`))
      )
    );

    expect(chain.txs.map((t) => t.label)).toEqual(results.map((_, i) => `k${i}`));
    expect(results.map((r) => r.txHash)).toEqual(chain.txs.map((t) => t.txHash));
    expect(results.map((r) => r.chainPosition)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1)
    );
    expect(chain.txs[0]!.inputs).toEqual(["genesis#0"]);
    for (let i = 1; i < chain.txs.length; i++) {
      expect(chain.txs[i]!.inputs).toEqual([`${chain.txs[i - 1]!.txHash}#0`]);
    }
    const allInputs = chain.txs.flatMap((t) => t.inputs);
    expect(new Set(allInputs).size).toBe(allInputs.length);
  });

  it("flushes on a spent-input rejection; the next tx waits for the last landed tip, then reads the wallet fresh", async () => {
    const chain = new FakeChain(100_000_000n);
    const awaited: string[] = [];
    const queue = createChainedSubmitQueue<Utxo>(
      options({ awaitConfirmation: blockThenCheck(chain, awaited) })
    );

    const first = await queue.submit("a", anchorBuilder(chain, "a"));
    await expect(
      queue.submit("b", failingSubmit(anchorBuilder(chain, "b"), new Error(BLOCKFROST_SPENT), false))
    ).rejects.toThrow("All inputs are spent");

    const seen: Array<Utxo[] | undefined> = [];
    const third = await queue.submit("c", watched(anchorBuilder(chain, "c"), seen));

    expect(awaited).toEqual([first.txHash]);
    expect(seen).toEqual([undefined]);
    expect(third.chainPosition).toBe(1);
    expect(chain.txs[1]!.inputs).toEqual([`${first.txHash}#0`]);
  });

  it("keeps chaining after a build fails before anything is submitted", async () => {
    const chain = new FakeChain(100_000_000n);
    const awaitConfirmation = vi.fn(async () => true);
    const queue = createChainedSubmitQueue<Utxo>(options({ awaitConfirmation }));

    const first = await queue.submit("a", anchorBuilder(chain, "a"));
    await expect(
      queue.submit("b", async () => {
        throw new Error("Insufficient input in transaction");
      })
    ).rejects.toThrow("Insufficient input in transaction");
    const third = await queue.submit("c", anchorBuilder(chain, "c"));

    expect(awaitConfirmation).not.toHaveBeenCalled();
    expect(third.chainPosition).toBe(2);
    expect(chain.txs[1]!.inputs).toEqual([`${first.txHash}#0`]);
  });

  it("drops cached UTxOs older than the TTL and reads the wallet fresh", async () => {
    const chain = new FakeChain(100_000_000n);
    let now = 0;
    const awaited: string[] = [];
    const queue = createChainedSubmitQueue<Utxo>(
      options({ cacheTtlMs: 90_000, now: () => now, awaitConfirmation: blockThenCheck(chain, awaited) })
    );

    await queue.submit("a", anchorBuilder(chain, "a"));
    now = 89_999;
    const chained = await queue.submit("b", anchorBuilder(chain, "b"));
    now = 89_999 + 90_000;
    const seen: Array<Utxo[] | undefined> = [];
    const fresh = await queue.submit("c", watched(anchorBuilder(chain, "c"), seen));

    expect(chained.chainPosition).toBe(2);
    expect(awaited).toEqual([chained.txHash]);
    expect(seen).toEqual([undefined]);
    expect(fresh.chainPosition).toBe(1);
    expect(chain.txs[2]!.inputs).toEqual([`${chained.txHash}#0`]);
  });

  it("waits for the chain tip to land at the length cap instead of failing", async () => {
    const chain = new FakeChain(100_000_000n);
    const awaited: string[] = [];
    const queue = createChainedSubmitQueue<Utxo>(
      options({ maxChainLength: 3, awaitConfirmation: blockThenCheck(chain, awaited) })
    );

    const results = await Promise.all(
      Array.from({ length: 7 }, (_, i) => queue.submit(`k${i}`, anchorBuilder(chain, `k${i}`)))
    );

    expect(results.map((r) => r.chainPosition)).toEqual([1, 2, 3, 1, 2, 3, 1]);
    expect(awaited).toEqual([results[2]!.txHash, results[5]!.txHash]);
    for (let i = 1; i < chain.txs.length; i++) {
      expect(chain.txs[i]!.inputs).toEqual([`${chain.txs[i - 1]!.txHash}#0`]);
    }
  });

  it("fails only the waiting submission when confirmation fails, and does not wait on that tip again", async () => {
    const chain = new FakeChain(100_000_000n);
    const awaitConfirmation = vi.fn(async (txHash: string) => {
      throw new Error(`${txHash} not on chain`);
    });
    const queue = createChainedSubmitQueue<Utxo>(options({ maxChainLength: 1, awaitConfirmation }));

    const first = await queue.submit("a", anchorBuilder(chain, "a"));
    await expect(queue.submit("b", anchorBuilder(chain, "b"))).rejects.toThrow(
      `${first.txHash} not on chain`
    );
    chain.block();
    const third = await queue.submit("c", anchorBuilder(chain, "c"));

    expect(awaitConfirmation).toHaveBeenCalledTimes(1);
    expect(third.chainPosition).toBe(1);
  });

  it("coalesces concurrent submissions of one key onto a single tx", async () => {
    const chain = new FakeChain(100_000_000n);
    const queue = createChainedSubmitQueue<Utxo>(options());
    const build = vi.fn(anchorBuilder(chain, "same"));

    const [a, b, c] = await Promise.all([
      queue.submit("same", build),
      queue.submit("same", build),
      queue.submit("same", build),
    ]);

    expect(build).toHaveBeenCalledTimes(1);
    expect(new Set([a.txHash, b.txHash, c.txHash]).size).toBe(1);
    expect([a.deduplicated, b.deduplicated, c.deduplicated]).toEqual([false, true, true]);
  });

  it("returns a landed key's txHash without building until dedupeTtlMs after its landing was seen", async () => {
    let now = 0;
    const queue = createChainedSubmitQueue<Utxo>(
      options({ dedupeTtlMs: 1_000, maxChainLength: 1, now: () => now })
    );
    const build = counterBuild();

    const first = await queue.submit("k", build);
    await queue.submit("other", build);
    now = 999;
    const repeat = await queue.submit("k", build);
    now = 1_000;
    const expired = await queue.submit("k", build);

    expect(repeat).toEqual({ ...first, deduplicated: true });
    expect(build).toHaveBeenCalledTimes(3);
    expect(expired.txHash).not.toBe(first.txHash);
  });

  it("answers a key of the live chain with its tx without waiting for it to land", async () => {
    let now = 0;
    const awaitConfirmation = vi.fn(async () => true);
    const queue = createChainedSubmitQueue<Utxo>(options({ now: () => now, awaitConfirmation }));
    const build = counterBuild();

    const first = await queue.submit("a", build);
    now = 89_999;
    const repeat = await queue.submit("a", build);

    expect(repeat).toEqual({ ...first, deduplicated: true });
    expect(build).toHaveBeenCalledTimes(1);
    expect(awaitConfirmation).not.toHaveBeenCalled();
  });

  it.each([
    [true, "answers it with the landed tx", 1],
    [false, "submits it again", 2],
  ])(
    "waits for an idle chain to land before answering a re-post of one of its keys; if it landed %s, it %s",
    async (landed, _outcome, builds) => {
      let now = 0;
      const awaitConfirmation = vi.fn(async () => landed);
      const queue = createChainedSubmitQueue<Utxo>(
        options({ cacheTtlMs: 90_000, now: () => now, awaitConfirmation })
      );
      const build = counterBuild();

      const first = await queue.submit("a", build);
      now = 90_000;
      const repost = await queue.submit("a", build);

      expect(awaitConfirmation.mock.calls).toEqual([[first.txHash]]);
      expect(build).toHaveBeenCalledTimes(builds);
      expect(repost.deduplicated).toBe(landed);
      expect(repost.txHash === first.txHash).toBe(landed);
    }
  );

  it("forgets every key of a chain whose tip never lands, so a re-post submits again", async () => {
    const awaitConfirmation = vi.fn(async () => false);
    const queue = createChainedSubmitQueue<Utxo>(options({ maxChainLength: 3, awaitConfirmation }));
    const build = counterBuild();

    for (const key of ["a", "b", "c", "d"]) await queue.submit(key, build);
    const retries = [await queue.submit("a", build), await queue.submit("c", build)];

    expect(awaitConfirmation.mock.calls).toEqual([["tx3"]]);
    expect(retries).toEqual([
      { txHash: "tx5", chainPosition: 2, deduplicated: false },
      { txHash: "tx6", chainPosition: 3, deduplicated: false },
    ]);
  });

  it("answers a submission whose outcome is unknown with its tx once that lands, and chains on from a fresh read", async () => {
    const chain = new FakeChain(100_000_000n);
    const awaited: string[] = [];
    const queue = createChainedSubmitQueue<Utxo>(
      options({ awaitConfirmation: blockThenCheck(chain, awaited) })
    );

    const first = await queue.submit("a", anchorBuilder(chain, "a"));
    // Blockfrost relayed the tx to the node, then answered 5xx or a non-JSON body.
    const second = await queue.submit(
      "b",
      failingSubmit(anchorBuilder(chain, "b"), new Error("Could not submit transaction."), true)
    );
    const seen: Array<Utxo[] | undefined> = [];
    const third = await queue.submit("c", watched(anchorBuilder(chain, "c"), seen));
    const repost = vi.fn(anchorBuilder(chain, "repost"));

    expect(second).toEqual({ txHash: chain.txs[1]!.txHash, chainPosition: 2, deduplicated: false });
    expect(awaited).toEqual([second.txHash]);
    expect(seen).toEqual([undefined]);
    expect(third.chainPosition).toBe(1);
    expect(chain.txs.map((t) => t.inputs)).toEqual([
      ["genesis#0"],
      [`${first.txHash}#0`],
      [`${second.txHash}#0`],
    ]);
    await expect(queue.submit("b", repost)).resolves.toEqual({ ...second, deduplicated: true });
    await expect(queue.submit("a", repost)).resolves.toEqual({ ...first, deduplicated: true });
    expect(repost).not.toHaveBeenCalled();
  });

  it("fails a submission whose outcome is unknown once it is seen not to land, then waits on the tip before it", async () => {
    const chain = new FakeChain(100_000_000n);
    const awaited: string[] = [];
    const queue = createChainedSubmitQueue<Utxo>(
      options({ awaitConfirmation: blockThenCheck(chain, awaited) })
    );

    const first = await queue.submit("a", anchorBuilder(chain, "a"));
    let lostHash = "";
    const lost = failingSubmit(anchorBuilder(chain, "b"), new Error("fetch failed"), false);
    await expect(
      queue.submit("b", async (walletUtxos) => {
        const tx = await lost(walletUtxos);
        lostHash = tx.txHash;
        return tx;
      })
    ).rejects.toThrow("fetch failed");
    const seen: Array<Utxo[] | undefined> = [];
    const retry = await queue.submit("b", watched(anchorBuilder(chain, "b"), seen));

    expect(awaited).toEqual([lostHash, first.txHash]);
    expect(seen).toEqual([undefined]);
    expect(retry.deduplicated).toBe(false);
    expect(chain.txs.map((t) => t.inputs)).toEqual([["genesis#0"], [`${first.txHash}#0`]]);
  });

  it("forgets the least recently landed key beyond the dedupe bound", async () => {
    const queue = createChainedSubmitQueue<Utxo>(
      options({ dedupeMaxEntries: 2, maxChainLength: 1 })
    );
    const build = counterBuild();

    await queue.submit("a", build);
    await queue.submit("b", build);
    await queue.submit("c", build);
    await queue.submit("c", build);
    await queue.submit("a", build);

    expect(build).toHaveBeenCalledTimes(4);
  });

  it("does not remember a failed key", async () => {
    const queue = createChainedSubmitQueue<Utxo>(options());
    const build = vi
      .fn<[Utxo[] | undefined], Promise<ChainedTx<Utxo>>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ txHash: "tx-ok", walletUtxos: [], submit: async () => undefined });

    await expect(queue.submit("k", build)).rejects.toThrow("boom");
    await expect(queue.submit("k", build)).resolves.toMatchObject({ txHash: "tx-ok" });
  });

  it("rejects new keys fast once maxPending submissions are waiting, but still coalesces duplicates", async () => {
    const chain = new FakeChain(100_000_000n);
    const queue = createChainedSubmitQueue<Utxo>(options({ maxPending: 2 }));
    const held = gate();
    const slow: ChainedBuild<Utxo> = async (walletUtxos) => {
      await held.opened;
      return anchorBuilder(chain, "slow")(walletUtxos);
    };

    const a = queue.submit("a", slow);
    const b = queue.submit("b", slow);
    const full = queue.submit("c", slow);
    const duplicate = queue.submit("a", slow);

    await expect(full).rejects.toBeInstanceOf(SubmitQueueFullError);
    await expect(full).rejects.toMatchObject({ pending: 2 });
    held.open();
    const [ra, , rd] = await Promise.all([a, b, duplicate]);
    expect(rd.txHash).toBe(ra.txHash);
    await expect(queue.submit("c", anchorBuilder(chain, "c"))).resolves.toMatchObject({
      deduplicated: false,
    });
  });
});

describe("isSpentInputError", () => {
  it.each([
    ["Blockfrost / cardano-node Conway mempool", BLOCKFROST_SPENT],
    ["cardano-node ledger rule", "ShelleyTxValidationError ... (BadInputsUTxO (fromList [TxIn ...]))"],
    ["Ogmios 3117", '{"code":3117,"message":"...","data":{"unknownOutputReferences":[...]}}'],
    [
      "lucid-evolution Emulator",
      'Could not spend UTxO: {"txHash":"ab","outputIndex":0}\nIt does not exist or was already spent.',
    ],
  ])("recognises %s", (_source, message) => {
    expect(isSpentInputError(new Error(message))).toBe(true);
  });

  it("recognises a spent-input error carried as the cause", () => {
    expect(isSpentInputError(new Error("TxSubmitError", { cause: new Error(BLOCKFROST_SPENT) }))).toBe(
      true
    );
  });

  it.each([
    "Could not submit transaction.",
    "Insufficient input in transaction",
    "fetch failed",
  ])("ignores %s", (message) => {
    expect(isSpentInputError(new Error(message))).toBe(false);
  });
});
