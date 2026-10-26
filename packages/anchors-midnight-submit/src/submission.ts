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
  settleTimeoutMillis?: number;
}

// Sends through the write-ahead journal, which records the wallet as the payer, and returns the
// key's live row as the journal answered, unsettled. A caller whose `prepare` returns bytes it
// holds already passes their `txHash`, so another attempt's row comes back unsent and the wallet
// never broadcasts bytes that caller did not prepare.
export function journalOnce(journalling: Journalling, key: AnchorKey, prepare: () => Promise<Submission>, txHash?: string): Promise<JournalRow> {
  const { journal, chain, wallet } = journalling;
  const payer = wallet.addresses.unshielded;
  return journal.submitOnce(key, {
    prepare: async () => ({ ...(await prepare()), payer }),
    broadcast: async bytes => {
      // Recheck at the last send boundary, after preparation/journal awaits. Host time and a
      // stale confirmation-time check cannot authorize expired or unknown-time bytes.
      const final = finalTransaction(bytes);
      const head = await chain.indexedThrough();
      if (!head) throw new Error("Finalized chain time is unknown; journalled bytes were retained and nothing was sent");
      const ttls = [...(final.intents?.values() ?? [])].map(intent => intent.ttl.getTime());
      if (!ttls.length || ttls.some(ttl => !Number.isFinite(ttl) || Math.max(Date.now(), head.time.getTime()) > ttl)) {
        throw new Error("Finalized chain time passed the transaction TTL; journalled bytes were retained and nothing was sent");
      }
      await wallet.submit(final);
    },
    chain,
    ...(txHash === undefined ? {} : { txHash }),
  });
}

// Sends through the write-ahead journal (journalOnce) and returns the transaction once it landed
// (landedRow).
export async function submitJournalled(journalling: Journalling, key: AnchorKey, prepare: () => Promise<Submission>): Promise<JournalRow & { height: number; blockHash: string }> {
  return landedRow(journalling, key, await journalOnce(journalling, key, prepare));
}

// Final bytes as a human confirms them before they leave: their transaction hash, the TTL their
// intent carries, the DUST they declare as their fee, all of it burned, and the unshielded address
// of the wallet whose DUST paid it (none for journalled bytes whose journal did not record it).
// Bytes that come from the journal carry how it holds them, expired once chain time is past their
// TTL, after which no node includes them.
export interface PreparedBytes {
  network: MidnightNetwork;
  txHash: string;
  bytes: Uint8Array;
  ttl: Date;
  declaredFee: bigint;
  payer?: string;
  journal?: Pick<JournalRow, "state" | "broadcasts"> & { expired: boolean | null };
}

// Refuses bytes that do not hash to the transaction the human confirmed.
export function assertConfirmedHash(prepared: PreparedBytes): void {
  const txHash = finalTransaction(prepared.bytes).transactionHash();
  if (txHash !== prepared.txHash) throw new Error(`the bytes hash to ${txHash}, not the confirmed ${prepared.txHash}; nothing was sent`);
}

// Sends confirmed bytes through the write-ahead journal under `key`, at most once. `what` names
// them in errors ("deploy"), `holder` the attempt another set of bytes holds the key as ("a
// registry deploy"). The caller checks the bytes are the ones the human confirmed first.
export function confirmedSends(journalling: Journalling, key: AnchorKey, what: string, holder: string) {
  const { journal, chain, wallet, network } = journalling;
  // Whether chain time, as the journal reads it, is past `ttl`; null while the node lacks the
  // indexer's newest block, so that chain time is unknown.
  const pastTtl = async (ttl: Date) => {
    const head = await chain.indexedThrough();
    return head && head.time.getTime() > ttl.getTime();
  };
  // A row fails only once the chain has carried it past its TTL plus the margin unseen.
  const EXPIRED = `the journalled ${what} expired without landing; rerun to prepare new bytes`;
  const failure = (txHash: string) => {
    const row = journal.history(key).find(candidate => candidate.txHash === txHash && candidate.state === "failed");
    return row?.height === undefined ? EXPIRED : `the journalled ${what} failed in block ${row.height}${row.blockHash ? ` (${row.blockHash})` : ""}; rerun to prepare new bytes`;
  };
  const unknownTime = (which: string) => `the ${network} node does not hold the indexer's newest block, so chain time is unknown and the ${which} bytes may be past their TTL`;
  const retired = (txHash: string) => journal.history(key).some((row) => row.txHash === txHash && row.state === "failed");

  return {
    // The key's live attempt, with its exact bytes, once the journal is settled from the chain,
    // marked expired when chain time is past its TTL; null when none is live.
    reconcile: () => journal.reconcile(chain),
    async held({ reconcile = true }: { reconcile?: boolean } = {}): Promise<(JournalRow & { bytes: Uint8Array; expired: boolean | null }) | null> {
      if (reconcile) await journal.reconcile(chain);
      const row = journal.live(key);
      if (!row) return null;
      return { ...row, expired: row.state === "pending" ? await pastTtl(row.ttl) : false };
    },

    async submit(prepared: PreparedBytes): Promise<JournalRow & { height: number; blockHash: string }> {
      // Bytes the journal does not hold never leave, and their DUST is freed.
      const discarding = async (reason: string): Promise<never> => {
        await wallet.discard(finalTransaction(prepared.bytes));
        throw new Error(reason);
      };
      const refuse = (other: JournalRow) => discarding(`${holder} is already journalled on ${network}: ${other.txHash} (${other.state}); the prepared bytes were discarded`);
      // An attempt journalled earlier is settled from the chain first: one that the chain has
      // carried past its TTL unseen no longer holds the key, and is never sent again.
      await journal.reconcile(chain);
      if (retired(prepared.txHash)) throw new Error(failure(prepared.txHash));
      const live = journal.live(key);
      if (live && live.txHash !== prepared.txHash) await refuse(live);
      // New bytes leave only while chain time is known and short of their TTL, however long the
      // human took to confirm them.
      if (!live) {
        const late = await pastTtl(prepared.ttl);
        if (late === null) await discarding(`${unknownTime("prepared")}; they were discarded and nothing was sent`);
        if (late) await discarding(`chain time passed the prepared ${what}'s TTL ${prepared.ttl.toISOString()} while it awaited confirmation; its bytes were discarded and nothing was sent; rerun to prepare new bytes`);
      }
      // Journalled bytes the human confirmed as expired, or that chain time has carried past their
      // TTL, are not sent again, since no node includes them: the chain lands or retires them.
      // While chain time is unknown nothing is sent: bytes no send of which returned are refused.
      const past = live?.state === "pending" ? (prepared.journal?.expired === true ? true : await pastTtl(live.ttl)) : false;
      if (past === null && live?.broadcasts === 0) throw new Error(`${unknownTime("journalled")}; nothing was sent`);
      try {
        const journalled = live && past !== false ? live : await journalOnce(journalling, key, async () => ({ bytes: prepared.bytes, ttl: prepared.ttl }), prepared.txHash);
        // An attempt confirmed at the same moment wrote its row first, and the journal answered
        // with it, unsent.
        if (journalled.txHash !== prepared.txHash) await refuse(journalled);
        return await landedRow(journalling, key, journalled);
      } catch (error) {
        throw retired(prepared.txHash) ? new Error(failure(prepared.txHash)) : error;
      }
    },
  };
}

// Waits, by txHash, until the journal settles `row`, sending nothing, and returns it landed with
// its block as the indexer lists it; a transaction the chain reports failed, or that outlives its
// TTL unseen, is an error.
export async function landedRow({ journal, chain, network, pollMillis, settleTimeoutMillis = 120_000 }: Journalling, key: AnchorKey, row: JournalRow): Promise<JournalRow & { height: number; blockHash: string }> {
  if (!Number.isFinite(settleTimeoutMillis) || settleTimeoutMillis <= 0 || settleTimeoutMillis > 60 * 60_000) throw new Error("Invalid journal settlement deadline");
  const deadline = performance.now() + settleTimeoutMillis;
  while (row.state === "pending") {
    const left = deadline - performance.now();
    if (left <= 0) throw new Error(`Timed out waiting for transaction ${row.txHash} on ${network}; its journalled bytes and claim were retained`);
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMillis, left)));
    const settled = await journal.reconcile(chain);
    row = settled.find((r) => r.txHash === row.txHash) ?? journal.history(key).find((r) => r.txHash === row.txHash)!;
  }
  if (row.state !== "landed") throw new Error(`transaction ${row.txHash} failed on ${network}${row.height === undefined ? " after its finalized TTL window" : ` in block ${row.height}${row.blockHash ? ` (${row.blockHash})` : ""}`}`);
  if (row.height !== undefined && row.blockHash !== undefined) return { ...row, height: row.height, blockHash: row.blockHash };
  // Landed on the node's word, which names no block: the indexer names it once it lists the transaction.
  const seen = await chain.lookup(row.txHash);
  if (seen && seen.status !== "SUCCESS" && seen.status !== "PARTIAL_SUCCESS") throw new Error(`transaction ${row.txHash} took effect on ${network} in another or unsupported indexed transaction; indexer reports a terminal non-success result`);
  if (!seen) throw new Error(`transaction ${row.txHash} took effect on ${network}, as the node's state shows, but the indexer does not list it yet`);
  return { ...row, height: seen.height, blockHash: seen.blockHash };
}
