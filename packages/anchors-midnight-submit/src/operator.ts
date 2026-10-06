import {
  authorKey,
  decodeAnchorTransaction,
  deriveSalt,
  entryCommitment,
  hash32,
  hiddenDigest,
  hidingCommitment,
  readAuthorSecret,
  readPrivateFile,
  saltKeyId,
  unprovenRegistryCall,
  type EntryHashes,
  type Hash32,
  type MidnightNetwork,
  type MidnightSource,
  type RegistryCallArgs,
  type RegistryWitnesses,
} from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { chainView, openJournal, type AnchorKey, type JournalRow } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { MAINNET_AUTHOR_KEYS, MAINNET_SALT_KEY_IDS, agentDriven, refuseMainnetSecretsPath } from "./custody.js";
import { assertKnownRuntime, finalizeChecked, registryStateOnNode, submitJournalled, type FeeWallet, type Prover } from "./submission.js";

export interface AnchorReceipt {
  network: MidnightNetwork;
  registry: string;
  txHash: string;
  blockHeight: number;
  blockHash: string;
  kind: 1 | 2;
  commitment: string;
  attribute: string;
  author: string;
}

// What opens a kind-2 commitment: for its author only, never published.
export interface HiddenOpening {
  rootHash: string;
  manifestHash: string;
  merkleRoot: string;
  salt: string;
}

export interface OperatorOptions {
  network: MidnightNetwork;
  wallet: FeeWallet;
  source: MidnightSource;
  prover: Prover;
  journalPath: string;
  // The author secret's file, which only its owner may read; the key itself is never an argument.
  authorKeyFile: string;
  // The 32-byte key kind-2 salts derive from, so every opening can be recovered from it.
  saltKeyFile?: string | undefined;
  // The registry anchors are written to.
  registry: string;
  ttlMinutes?: number;
  pollMillis?: number;
}

export interface RegistryOperator {
  readonly authorKey: string;
  anchor(entry: EntryHashes): Promise<AnchorReceipt>;
  anchorHiding(entry: EntryHashes, attribute: Hash32): Promise<AnchorReceipt & { opening: HiddenOpening }>;
  // Settles every journalled submission by its txHash, as after a restart.
  reconcile(): Promise<JournalRow[]>;
  close(): void;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const ZERO = "00".repeat(32);

// Writes registry anchors under the FPS author key: every submission goes through the
// write-ahead journal, and every transaction is checked, from its final balanced bytes, to be
// exactly what was meant before those bytes reach the node.
export function registryOperator(options: OperatorOptions): RegistryOperator {
  const { network, wallet, source, prover } = options;
  if (network === "mainnet" && agentDriven()) throw new Error("registryOperator refuses to load a mainnet author key in a process that carries Claude Code's environment");
  for (const file of [options.authorKeyFile, options.saltKeyFile]) if (file !== undefined) refuseMainnetSecretsPath(network, file);
  const authorSecret = readAuthorSecret(options.authorKeyFile);
  const author = hex(authorKey(authorSecret));
  if (network !== "mainnet" && MAINNET_AUTHOR_KEYS.includes(author)) throw new Error(`${options.authorKeyFile} holds the FPS mainnet author key ${author}; a ${network} operator never loads it`);
  const journal = openJournal(options.journalPath);
  const chain = chainView(source, network);
  const ttlMillis = (options.ttlMinutes ?? 15) * 60_000;
  const pollMillis = options.pollMillis ?? 3_000;

  const write = async (kind: 1 | 2, commitment: string, attribute: string, call: RegistryCallArgs, witnesses: RegistryWitnesses): Promise<AnchorReceipt> => {
    await assertKnownRuntime(source, network);
    const { registry } = options;
    const key: AnchorKey = { network, registry, author, kind, commitment, attribute };
    const row = await submitJournalled({ journal, chain, wallet, network, pollMillis }, key, async () => {
      const state = await registryStateOnNode(source, registry);
      if (!state) throw new Error(`the ${network} node holds no contract at ${registry}`);
      const ttl = new Date(Date.now() + ttlMillis);
      const built = unprovenRegistryCall({ networkId: network, address: registry, state, call, witnesses, ttl });
      if (kind === 2 && hex(built.after.last_commitment) !== commitment) throw new Error("the circuit computed a different kind-2 commitment than the opening");
      const { bytes } = await finalizeChecked(wallet, prover, built.tx, ttl, (bytes) => {
        const { calls, touches } = decodeAnchorTransaction(bytes, [registry]);
        const [call] = calls;
        const exact =
          touches.length === 0 &&
          calls.length === 1 &&
          call!.address === registry &&
          call!.entryPoint === (kind === 1 ? "anchor" : "anchor_hiding") &&
          call!.kind === kind &&
          call!.commitment === commitment &&
          call!.attribute === attribute &&
          call!.author === author;
        if (!exact) {
          throw new Error("the final bytes do not carry exactly the intended anchor; nothing was submitted");
        }
      });
      return { bytes, ttl };
    });
    return { network, registry, txHash: row.txHash, blockHeight: row.height, blockHash: row.blockHash, kind, commitment, attribute, author };
  };

  return {
    authorKey: author,
    anchor(entry) {
      const commitment = entryCommitment(entry);
      return write(1, hex(commitment), ZERO, { circuit: "anchor", args: [commitment, 1n] }, { authorSecret });
    },
    async anchorHiding(entry, attribute) {
      if (!options.saltKeyFile) throw new Error("anchorHiding needs a salt key file");
      const saltKey = hash32(readPrivateFile(options.saltKeyFile), options.saltKeyFile);
      const id = hex(saltKeyId(saltKey));
      if (network !== "mainnet" && MAINNET_SALT_KEY_IDS.includes(id)) throw new Error(`${options.saltKeyFile} holds the FPS mainnet salt key ${id}; a ${network} operator never uses it`);
      const attr = hash32(attribute, "attribute");
      const digest = hiddenDigest(entry, attr);
      const salt = deriveSalt(saltKey, digest);
      const hidden = { root_hash: hash32(entry.rootHash, "rootHash"), manifest_hash: hash32(entry.manifestHash, "manifestHash"), merkle_root: entry.merkleRoot === undefined ? new Uint8Array(32) : hash32(entry.merkleRoot, "merkleRoot"), salt };
      const receipt = await write(2, hex(hidingCommitment(digest, salt)), hex(attr), { circuit: "anchor_hiding", args: [attr] }, { authorSecret, hiddenEntry: hidden });
      return { ...receipt, opening: { rootHash: hex(hidden.root_hash), manifestHash: hex(hidden.manifest_hash), merkleRoot: hex(hidden.merkle_root), salt: hex(salt) } };
    },
    reconcile: () => journal.reconcile(chain),
    close: () => journal.close(),
  };
}
