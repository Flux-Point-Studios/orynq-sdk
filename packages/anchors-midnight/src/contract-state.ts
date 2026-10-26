import { NodeError, type MidnightSource } from "./source.js";

// The state the node holds at `address` in block `at` (its best block when none is named), or
// null when it holds no contract there. midnight-node 1.0 answers for an address holding no
// contract with an empty string, 2.x with JSON-RPC error -32602, its answer too in a block whose
// ledger it cannot read, such as one it does not hold. So the contract is read in one request
// behind the ledger's zswap root in the same block: a batch is refused at its first failed
// request, so the observed -32602 missing-contract answer, after a valid root, means the node
// read that ledger and found no contract. Other -32602 messages and unknown ledger-9 errors
// remain errors; only the exact observed RPC error is classified as contract-not-present.
// This assumes one backend answers the entire batch, not a load balancer dispatching each
// method to a different node. A caller supplying a custom source must preserve prior results
// on NodeError, as midnightSource does; a failed/unknown root never proves absence.
export async function contractStateOnNode(source: Pick<MidnightSource, "node" | "operator">, address: string, at?: string): Promise<string | null> {
  const block = at === undefined ? [] : [`0x${at}`];
  try {
    const [root, state] = await source.node.batch<unknown>([
      ["midnight_zswapStateRoot", block],
      ["midnight_contractState", [address, ...block]],
    ]);
    assertLedgerRoot(root, source.operator);
    if (typeof state !== "string") throw new Error(`${source.operator} node: midnight_contractState answered something other than a string`);
    return state === "" ? null : state;
  } catch (error) {
    const refused = error as Partial<NodeError> | undefined;
    if (refused?.method === "midnight_contractState" && refused.code === -32602 && refused.reason === "contract-not-present") {
      assertLedgerRoot(refused.completedResults?.[0], source.operator);
      return null;
    }
    throw error;
  }
}


// The ledger root is a tagged 32-byte commitment, represented by the node as 33 octets.
function assertLedgerRoot(root: unknown, operator: string): void {
  if (!Array.isArray(root) || root.length !== 33 || root.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`${operator} node: midnight_zswapStateRoot answered something other than a 33-byte root`);
  }
}
