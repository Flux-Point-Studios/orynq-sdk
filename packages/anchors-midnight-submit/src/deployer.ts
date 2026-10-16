import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import {
  MIDNIGHT_REGISTRIES,
  REGISTRY_CIRCUITS,
  assertRegistryDeployBytes,
  buildRegistryDeploy,
  registryInitialState,
  type MidnightNetwork,
  type MidnightSource,
  type RegistryCircuit,
} from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { chainView, openJournal, type AnchorKey } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { assertConfirmedHash, assertKnownRuntime, confirmedSends, declaredFee, finalTransaction, finalizeChecked, type FeeWallet, type PreparedBytes, type Prover } from "./submission.js";

// A registry deploy as it will be sent: the exact final bytes and what they do, for a human to
// read before anything leaves.
export interface PreparedDeploy extends PreparedBytes {
  address: string;
  runtime: number;
  // committee size, threshold and counter of the deployed maintenance authority
  authority: { committee: number; threshold: number; counter: string };
  verifierKeys: Record<RegistryCircuit, string>;
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
  rebroadcastMillis?: number;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// The journal key of `network`'s registry deploy: one live deploy per network and registry state.
const deployKey = (network: MidnightNetwork): AnchorKey => ({ network, registry: "registry-deploy", author: "", kind: 0, commitment: sha256(registryInitialState().serialize()), attribute: "" });

// Refuses a registry that is not FPS's on `network`: one MIDNIGHT_REGISTRIES pins, or the one
// whose deploy the journal at `deployJournal` holds landed, read from the journalled bytes, which
// must deploy exactly the registry. The same immutable registry deployed by anyone else is
// refused. The journal is only read: where none is, none is created.
export function assertFpsRegistry(network: MidnightNetwork, address: string, deployJournal: string): void {
  if (MIDNIGHT_REGISTRIES[network].some((generation) => generation.address === address)) return;
  let deployed: string | null = null;
  if (existsSync(deployJournal)) {
    const journal = openJournal(deployJournal);
    try {
      const row = journal.live(deployKey(network));
      if (row?.state === "landed") deployed = assertRegistryDeployBytes(row.bytes, "final");
    } finally {
      journal.close();
    }
  }
  if (deployed === address) return;
  const journalled = deployed === null ? `holds no landed ${network} registry deploy` : `holds the landed deploy of ${deployed}`;
  throw new Error(`registry ${address} is not the FPS ${network} registry: MIDNIGHT_REGISTRIES pins no generation there, and ${deployJournal} ${journalled}`);
}

// Deploys the immutable registry in two steps, so a human can approve the exact bytes: prepare
// builds, proves, pays and binds them, and refuses unless they deploy exactly the registry's
// initial state; submit keeps one live attempt per network and registry state in the journal,
// and reads the address back from the landed transaction.
export function registryDeployer(options: DeployerOptions) {
  const { network, wallet, source, prover } = options;
  const journal = openJournal(options.journalPath);
  const chain = chainView(source, network);
  const ttlMillis = (options.ttlMinutes ?? 15) * 60_000;
  const key = deployKey(network);

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

  // A deploy row fails only when the chain has carried it past its TTL plus the margin unseen,
  // with no contract at its address.
  const confirmed = confirmedSends({ journal, chain, wallet, network, pollMillis: options.pollMillis ?? 3_000, rebroadcastMillis: options.rebroadcastMillis }, key, "deploy", "a registry deploy");

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
      const row = await confirmed.held();
      if (!row) return null;
      return describe(row.bytes, row.ttl, await assertKnownRuntime(source, network), row.payer, { state: row.state, broadcasts: row.broadcasts, expired: row.expired });
    },

    async submit(prepared: PreparedDeploy): Promise<Deployment> {
      // Only bytes that deploy exactly the registry leave, and only the ones the human confirmed:
      // the confirmation token names their transaction hash, the summary their address.
      const deploys = assertRegistryDeployBytes(prepared.bytes, "final");
      assertConfirmedHash(prepared);
      if (deploys !== prepared.address) throw new Error(`the bytes deploy ${deploys}, not the confirmed ${prepared.address}; nothing was sent`);
      await assertKnownRuntime(source, network);
      const row = await confirmed.submit(prepared);
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
