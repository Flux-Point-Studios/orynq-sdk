import { createHash } from "node:crypto";
import * as L from "@midnight-ntwrk/ledger-v8";
import {
  REGISTRY_CIRCUITS,
  assertRegistryDeployBytes,
  buildRegistryDeploy,
  registryInitialState,
  type MidnightNetwork,
  type MidnightSource,
  type RegistryCircuit,
} from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { chainView, openJournal, type AnchorKey, type JournalRow } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { assertKnownRuntime, declaredFee, finalTransaction, finalizeChecked, landedRow, submitJournalled, type FeeWallet, type Prover } from "./submission.js";

// A registry deploy as it will be sent: the exact final bytes and what they do, for a human to
// read before anything leaves.
export interface PreparedDeploy {
  network: MidnightNetwork;
  address: string;
  txHash: string;
  bytes: Uint8Array;
  ttl: Date;
  runtime: number;
  // committee size, threshold and counter of the deployed maintenance authority
  authority: { committee: number; threshold: number; counter: string };
  verifierKeys: Record<RegistryCircuit, string>;
  // DUST (SPECK) the bytes declare as their fee, all of it burned
  declaredFee: bigint;
  // The unshielded address of the wallet whose DUST paid that fee; none for a journalled deploy
  // whose journal did not record it
  payer?: string;
  // The deploy as the journal holds it, when these bytes come from the journal; expired once chain
  // time is past their TTL, after which no node includes them
  journal?: Pick<JournalRow, "state" | "broadcasts"> & { expired: boolean };
}

export interface Deployment {
  network: MidnightNetwork;
  address: string;
  txHash: string;
  blockHeight: number;
  blockHash: string;
}

export interface DeployerOptions {
  network: MidnightNetwork;
  wallet: FeeWallet;
  source: MidnightSource;
  prover: Prover;
  journalPath: string;
  ttlMinutes?: number;
  pollMillis?: number;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Deploys the immutable registry in two steps, so a human can approve the exact bytes: prepare
// builds, proves, pays and binds them, and refuses unless they deploy exactly the registry's
// initial state; submit sends those bytes through the write-ahead journal, at most once per
// network and registry state, and reads the address back from the landed transaction.
export function registryDeployer(options: DeployerOptions) {
  const { network, wallet, source, prover } = options;
  const journal = openJournal(options.journalPath);
  const chain = chainView(source, network);
  const ttlMillis = (options.ttlMinutes ?? 15) * 60_000;
  const key: AnchorKey = { network, registry: "registry-deploy", author: "", kind: 0, commitment: sha256(registryInitialState().serialize()), attribute: "" };

  const describe = (bytes: Uint8Array, ttl: Date, runtime: number, payer: string | undefined, journal?: PreparedDeploy["journal"]): PreparedDeploy => {
    const address = assertRegistryDeployBytes(bytes, "final");
    const final = finalTransaction(bytes);
    const deploy = [...final.intents!.values()].flatMap((intent) => intent.actions).find((a): a is L.ContractDeploy => a instanceof L.ContractDeploy)!;
    const { committee, threshold, counter } = deploy.initialState.maintenanceAuthority;
    const verifierKeys = Object.fromEntries(
      REGISTRY_CIRCUITS.map((name) => {
        const op = deploy.initialState.operation(name)!;
        return [name, sha256(op.verifierKey)];
      }),
    ) as Record<RegistryCircuit, string>;
    return {
      network,
      address,
      txHash: final.transactionHash(),
      bytes,
      ttl,
      runtime,
      authority: { committee: committee.length, threshold, counter: String(counter) },
      verifierKeys,
      declaredFee: declaredFee(final),
      ...(payer === undefined ? {} : { payer }),
      ...(journal ? { journal } : {}),
    };
  };

  // Whether chain time, as the journal reads it, is past `ttl`.
  const pastTtl = async (ttl: Date) => ((await chain.indexedThrough())?.time.getTime() ?? 0) > ttl.getTime();
  const journalling = { journal, chain, wallet, network, pollMillis: options.pollMillis ?? 3_000 };
  // A deploy row fails only when the chain has carried it past its TTL plus the margin unseen,
  // with no contract at its address.
  const EXPIRED = "the journalled deploy expired without landing; rerun to prepare new bytes";
  const retired = (txHash: string) => journal.history(key).some((row) => row.txHash === txHash && row.state === "failed");

  return {
    async prepare(): Promise<PreparedDeploy> {
      const runtime = await assertKnownRuntime(source, network);
      const ttl = new Date(Date.now() + ttlMillis);
      const { tx } = buildRegistryDeploy({ networkId: network, ttl });
      const { bytes } = await finalizeChecked(wallet, prover, tx, ttl, (b) => void assertRegistryDeployBytes(b, "final"));
      return describe(bytes, ttl, runtime, wallet.addresses.unshielded);
    },

    // The deploy the journal still holds live once settled from the chain, rebuilt from its
    // journalled bytes and marked with how the journal holds it and the wallet that paid it, or
    // null when none is. Submitting it resumes that deploy; submit refuses any other bytes until
    // the chain has ruled it out.
    async journalled(): Promise<PreparedDeploy | null> {
      await journal.reconcile(chain);
      const row = journal.live(key);
      if (!row) return null;
      const expired = row.state === "pending" && (await pastTtl(row.ttl));
      return describe(row.bytes, row.ttl, await assertKnownRuntime(source, network), row.payer, { state: row.state, broadcasts: row.broadcasts, expired });
    },

    async submit(prepared: PreparedDeploy): Promise<Deployment> {
      // Only bytes that deploy exactly the registry leave, and only the ones the human confirmed:
      // the confirmation token names their transaction hash, the summary their address.
      const deploys = assertRegistryDeployBytes(prepared.bytes, "final");
      const txHash = finalTransaction(prepared.bytes).transactionHash();
      if (txHash !== prepared.txHash) throw new Error(`the bytes hash to ${txHash}, not the confirmed ${prepared.txHash}; nothing was sent`);
      if (deploys !== prepared.address) throw new Error(`the bytes deploy ${deploys}, not the confirmed ${prepared.address}; nothing was sent`);
      await assertKnownRuntime(source, network);
      // Another deploy holds the registry's key: these bytes never leave, and their DUST is freed.
      const refuse = async (other: JournalRow) => {
        await wallet.discard(finalTransaction(prepared.bytes));
        throw new Error(`a registry deploy is already journalled on ${network}: ${other.txHash} (${other.state}); the prepared bytes were discarded`);
      };
      // A deploy journalled earlier is settled from the chain first: one that the chain has
      // carried past its TTL unseen no longer holds the registry's key, and is never sent again.
      await journal.reconcile(chain);
      if (retired(prepared.txHash)) throw new Error(EXPIRED);
      const live = journal.live(key);
      if (live && live.txHash !== prepared.txHash) await refuse(live);
      // Bytes past their TTL are not sent again, since no node includes them: the chain lands or
      // retires them.
      const settled = live?.state === "pending" && (await pastTtl(live.ttl)) ? landedRow(journalling, key, live) : submitJournalled(journalling, key, async () => ({ bytes: prepared.bytes, ttl: prepared.ttl }));
      const row = await settled.catch((error: unknown) => {
        throw retired(prepared.txHash) ? new Error(EXPIRED) : error;
      });
      // A deployer confirmed at the same moment wrote its row first, and the journal answered with it.
      if (row.txHash !== prepared.txHash) await refuse(row);
      const [landed] = (await source.indexer.transactions(row.txHash)).filter((t) => t.hash === row.txHash);
      if (!landed) throw new Error(`the indexer lost deploy transaction ${row.txHash}`);
      const address = assertRegistryDeployBytes(new Uint8Array(Buffer.from(landed.raw, "hex")), "final");
      return { network, address, txHash: row.txHash, blockHeight: row.height, blockHash: row.blockHash };
    },

    discard: (prepared: PreparedDeploy) => wallet.discard(finalTransaction(prepared.bytes)),
    close: () => journal.close(),
  };
}

export type RegistryDeployer = ReturnType<typeof registryDeployer>;
