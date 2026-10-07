import * as L from "@midnight-ntwrk/ledger-v8";
import type { ProvingService, UnboundTransaction } from "@midnight-ntwrk/wallet-sdk-capabilities/proving";
import { KNOWN_RUNTIME_SPEC_VERSIONS, assertRegistryState, contractStateOnNode, type MidnightNetwork, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import type { AnchorKey, ChainView, Journal, JournalRow, Submission } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import type { OperatorWallet } from "./wallet.js";

export type FeeWallet = Pick<OperatorWallet, "addresses" | "payFee" | "submit" | "discard">;
export type Prover = Pick<ProvingService<UnboundTransaction>, "prove">;

export const finalTransaction = (bytes: Uint8Array) => L.Transaction.deserialize("signature", "proof", "binding", bytes) as L.FinalizedTransaction;

// Refuses to build anything for a runtime whose extrinsic layout the decoder does not pin:
// checked before every submission, so a runtime upgrade stops the submitter instead of
// producing transactions no verifier can place.
export async function assertKnownRuntime(source: MidnightSource, network: MidnightNetwork): Promise<number> {
  const { specVersion } = await source.node.call<{ specVersion: number }>("state_getRuntimeVersion");
  if (!(KNOWN_RUNTIME_SPEC_VERSIONS as readonly number[]).includes(specVersion)) {
    throw new Error(`the ${network} node runs runtime ${specVersion}, which is not one this submitter knows (${KNOWN_RUNTIME_SPEC_VERSIONS.join(", ")})`);
  }
  return specVersion;
}

// The registry's state as the node holds it at `address` in its best block, or null when no
// contract is there. A contract there that is not the immutable registry is refused.
export async function registryStateOnNode(source: MidnightSource, address: string): Promise<L.ContractState | null> {
  const raw = await contractStateOnNode(source, address);
  if (raw === null) return null;
  const state = L.ContractState.deserialize(Buffer.from(raw.replace(/^0x/, ""), "hex"));
  assertRegistryState(state);
  return state;
}

// Proves, pays the fee from DUST and binds; the final bytes leave only if `check` accepts them,
// and the DUST of bytes it refuses is released.
export async function finalizeChecked(wallet: FeeWallet, prover: Prover, tx: L.UnprovenTransaction, ttl: Date, check: (bytes: Uint8Array) => void) {
  const final = await wallet.payFee(await prover.prove(tx), ttl);
  const bytes = final.serialize();
  try {
    check(bytes);
  } catch (error) {
    await wallet.discard(final);
    throw error;
  }
  return { final, bytes, ttl };
}

// The DUST the final bytes declare as their fee, all of which is burned.
export function declaredFee(tx: L.FinalizedTransaction): bigint {
  return [...(tx.intents?.values() ?? [])].flatMap((intent) => intent.dustActions?.spends ?? []).reduce((sum, spend) => sum + spend.vFee, 0n);
}

interface Journalling {
  journal: Journal;
  chain: ChainView;
  wallet: FeeWallet;
  network: MidnightNetwork;
  pollMillis: number;
}

// Submits through the write-ahead journal, which records the wallet as the payer, and returns the
// transaction once it landed (landedRow).
export async function submitJournalled(journalling: Journalling, key: AnchorKey, prepare: () => Promise<Submission>): Promise<JournalRow & { height: number; blockHash: string }> {
  const { journal, chain, wallet } = journalling;
  const payer = wallet.addresses.unshielded;
  const row = await journal.submitOnce(key, { prepare: async () => ({ ...(await prepare()), payer }), broadcast: (bytes) => wallet.submit(finalTransaction(bytes)), chain });
  return landedRow(journalling, key, row);
}

// Waits, by txHash, until the journal settles `row`, sending nothing, and returns it landed with
// its block as the indexer lists it; a transaction the chain reports failed, or that outlives its
// TTL unseen, is an error.
export async function landedRow({ journal, chain, network, pollMillis }: Journalling, key: AnchorKey, row: JournalRow): Promise<JournalRow & { height: number; blockHash: string }> {
  while (row.state === "pending") {
    await new Promise((resolve) => setTimeout(resolve, pollMillis));
    const settled = await journal.reconcile(chain);
    row = settled.find((r) => r.txHash === row.txHash) ?? journal.history(key).find((r) => r.txHash === row.txHash)!;
  }
  if (row.state !== "landed") throw new Error(`transaction ${row.txHash} failed on ${network}`);
  if (row.height !== undefined && row.blockHash !== undefined) return { ...row, height: row.height, blockHash: row.blockHash };
  // Landed on the node's word, which names no block: the indexer names it once it lists the transaction.
  const seen = await chain.lookup(row.txHash);
  if (seen?.status !== "SUCCESS") throw new Error(`transaction ${row.txHash} took effect on ${network}, as the node's state shows, but the indexer does not list it yet`);
  return { ...row, height: seen.height, blockHash: seen.blockHash };
}
