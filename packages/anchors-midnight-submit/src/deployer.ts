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
import { assertKnownRuntime, declaredFee, finalTransaction, finalizeChecked, submitJournalled, type FeeWallet, type Prover } from "./submission.js";

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
  // The deploy as the journal holds it, when these bytes come from the journal
  journal?: Pick<JournalRow, "state" | "broadcasts">;
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

  const describe = (bytes: Uint8Array, ttl: Date, runtime: number, journal?: PreparedDeploy["journal"]): PreparedDeploy => {
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
      ...(journal ? { journal } : {}),
    };
  };

  return {
    async prepare(): Promise<PreparedDeploy> {
      const runtime = await assertKnownRuntime(source, network);
      const ttl = new Date(Date.now() + ttlMillis);
      const { tx } = buildRegistryDeploy({ networkId: network, ttl });
      const { bytes } = await finalizeChecked(wallet, prover, tx, ttl, (b) => void assertRegistryDeployBytes(b, "final"));
      return describe(bytes, ttl, runtime);
    },

    // The deploy the journal still holds live once settled from the chain, rebuilt from its
    // journalled bytes and marked with how the journal holds it, or null when none is. Submitting
    // it resumes that deploy; submit refuses any other bytes until the chain has ruled it out.
    async journalled(): Promise<PreparedDeploy | null> {
      await journal.reconcile(chain);
      const row = journal.live(key);
      return row ? describe(row.bytes, row.ttl, await assertKnownRuntime(source, network), { state: row.state, broadcasts: row.broadcasts }) : null;
    },

    async submit(prepared: PreparedDeploy): Promise<Deployment> {
      // Only bytes that deploy exactly the registry leave, and only the ones the human confirmed:
      // the confirmation token names their transaction hash, the summary their address.
      const deploys = assertRegistryDeployBytes(prepared.bytes, "final");
      const txHash = finalTransaction(prepared.bytes).transactionHash();
      if (txHash !== prepared.txHash) throw new Error(`the bytes hash to ${txHash}, not the confirmed ${prepared.txHash}; nothing was sent`);
      if (deploys !== prepared.address) throw new Error(`the bytes deploy ${deploys}, not the confirmed ${prepared.address}; nothing was sent`);
      await assertKnownRuntime(source, network);
      // A deploy journalled earlier is settled from the chain first: one that the chain has
      // carried past its TTL unseen no longer holds the registry's key.
      await journal.reconcile(chain);
      const live = journal.live(key);
      if (live && live.txHash !== prepared.txHash) {
        await wallet.discard(finalTransaction(prepared.bytes));
        throw new Error(`a registry deploy is already journalled on ${network}: ${live.txHash} (${live.state}); the prepared bytes were discarded`);
      }
      const row = await submitJournalled({ journal, chain, wallet, network, pollMillis: options.pollMillis ?? 3_000 }, key, async () => ({ bytes: prepared.bytes, ttl: prepared.ttl }));
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
