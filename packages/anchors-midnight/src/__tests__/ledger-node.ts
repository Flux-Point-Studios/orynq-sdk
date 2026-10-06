import { NodeError } from "../source.js";

export type NodeVersion = "1.0.400" | "2.1.0";
type Answer = { result: unknown } | { error: { code: number; message: string } };

const INVALID_PARAMS = -32602;
const refused = (message: string): Answer => ({ error: { code: INVALID_PARAMS, message } });

// A Midnight node's answers to the ledger reads contractStateOnNode batches, as midnight-node
// 1.0.400 and 2.1.0 gave them on preprod and mainnet. It reads its ledger in the blocks it holds,
// `blocks`, and in its best block, which a read naming no block reads; there `contracts` gives the
// state held at an address. A block it does not hold fails both reads with -32602; so does, on
// 2.1.0, an address that holds no contract, which 1.0.400 answers with an empty string.
export function ledgerNode({ blocks, contracts, version = "2.1.0" }: { blocks: string[]; contracts: (address: string) => string | undefined; version?: NodeVersion }) {
  const holds = (at: unknown[]) => at.length === 0 || blocks.some((block) => at[0] === `0x${block}`);
  const answer = (method: string, params: unknown[]): Answer => {
    if (method === "midnight_zswapStateRoot") return holds(params) ? { result: Array.from({ length: 33 }, (_, i) => i) } : refused("Unable to get requested zswap state root");
    const [address, ...at] = params as [string, ...unknown[]];
    if (!holds(at)) return refused("Unable to get requested contract state");
    const state = contracts(address);
    if (state !== undefined) return { result: state };
    return version === "1.0.400" ? { result: "" } : refused("Unable to get requested contract state");
  };
  return {
    // As the node puts it on the wire.
    answer,
    // As midnightSource's call returns or raises it, from the node of `operator`.
    call(operator: string, method: string, params: unknown[]) {
      const a = answer(method, params);
      if ("error" in a) throw new NodeError(`${operator} node: ${method} failed: ${JSON.stringify(a.error)}`, method, a.error.code);
      return a.result;
    },
  };
}

// A fake node's batch over its own call, as midnightSource's batch behaves: each request answered
// in request order, the batch refused at the first that fails.
export const batchOver =
  (call: (method: string, params: unknown[]) => Promise<unknown>) =>
  async (calls: Array<[string, unknown[]]>): Promise<unknown[]> => {
    const answers: unknown[] = [];
    for (const [method, params] of calls) answers.push(await call(method, params));
    return answers;
  };
