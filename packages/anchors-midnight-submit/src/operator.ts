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
import { batchAnchorCommitment, type BatchAnchorData } from "./batch-plan.js";
import { chainView, openJournal, type AnchorKey, type ChainView, type JournalRow, type Submission } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { MAINNET_AUTHOR_KEYS, MAINNET_BATCH_AUTHOR_KEYS, RETIRED_AUTHOR_KEYS, MAINNET_SALT_KEY_IDS, agentDriven, refuseMainnetSecretsPath } from "./custody.js";
import {
  assertConfirmedHash,
  assertKnownRuntime,
  confirmedSends,
  declaredFee,
  finalTransaction,
  finalizeChecked,
  registryStateOnNode,
  submitJournalled,
  type FeeWallet,
  type PreparedBytes,
  type Prover,
} from "./submission.js";

export interface AnchorReceipt {
  network: MidnightNetwork;
  registry: string;
  txHash: string;
  blockHeight: number;
  blockHash: string;
  kind: 1 | 2 | 3;
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

export type AnchorRequest = { kind: 1; entry: EntryHashes } | { kind: 2; entry: EntryHashes; attribute: Hash32 } | ({ kind: 3 } & BatchAnchorData);

// An anchor as it will be sent: the exact final bytes and what they write, for a human to read
// before anything leaves.
export interface PreparedAnchor extends PreparedBytes {
  registry: string;
  author: string;
  kind: 1 | 2 | 3;
  commitment: string;
  attribute: string;
}

export interface OperatorOptions {
  network: MidnightNetwork;
  wallet: FeeWallet;
  source: MidnightSource;
  prover: Prover;
  journalPath: string;
  chain?: ChainView;
  // The author secret's file, which only its owner may read; the key itself is never an argument.
  authorKeyFile: string;
  authorRole?: "relay" | "batch";
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
  anchorBatch(batch: BatchAnchorData): Promise<AnchorReceipt>;
  anchorHiding(entry: EntryHashes, attribute: Hash32): Promise<AnchorReceipt & { opening: HiddenOpening }>;
  // The attempt the journal still holds live for `request` once settled from the chain, rebuilt
  // from its journalled bytes and marked with how the journal holds it, or null when none is.
  journalled(request: AnchorRequest): Promise<PreparedAnchor | null>;
  // New final bytes for `request`, checked to carry exactly that anchor; nothing is journalled or sent.
  prepare(request: AnchorRequest): Promise<PreparedAnchor>;
  // Sends the bytes a human confirmed, journalled or new, through the journal at most once, and
  // returns the anchor once it landed; bytes past their TTL are never sent again.
  submit(prepared: PreparedAnchor): Promise<AnchorReceipt>;
  // Settles the confirmed anchor afresh once the node's finalized chain holds another block at
  // the height its journal row names, and returns it as submit does: where it landed since, or an
  // error once the chain carried it past its TTL unseen.
  relocate(prepared: PreparedAnchor): Promise<AnchorReceipt>;
  // Releases the DUST of prepared bytes nobody confirmed.
  discard(prepared: PreparedAnchor): Promise<void>;
  // Settles every journalled submission by its txHash, as after a restart.
  reconcile(): Promise<JournalRow[]>;
  close(): void;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const ZERO = "00".repeat(32);

// Writes registry anchors under the FPS author key: every submission goes through the
// write-ahead journal, and every transaction is checked, from its final balanced bytes, to be
// exactly what was meant before those bytes reach the node. anchor and anchorHiding send at once;
// prepare (or journalled) and submit let a human confirm the exact bytes in between.
export function registryOperator(options: OperatorOptions): RegistryOperator {
  const { network, wallet, source, prover } = options;
  if (options.chain && options.chain.network !== network) throw new Error(`The ${options.chain.network} chain view cannot settle the ${network} operator`);
  const role = options.authorRole ?? "relay";
  if (role !== "relay" && role !== "batch") throw new Error("Author role must be relay or batch");
  if (network === "mainnet" && agentDriven()) throw new Error("registryOperator refuses to load a mainnet author key in a process that carries Claude Code or Codex environment");
  for (const file of [options.authorKeyFile, options.saltKeyFile]) if (file !== undefined) refuseMainnetSecretsPath(network, file);
  // A mainnet operator writes FPS anchors, so it loads only the FPS mainnet keys, and an operator
  // anywhere else never loads one of them: each key is told by what it is, wherever its file lives.
  const authorSecret = readAuthorSecret(options.authorKeyFile);
  const author = hex(authorKey(authorSecret));
  if (RETIRED_AUTHOR_KEYS.includes(author)) throw new Error("The file holds a retired author key; it cannot write on any network");
  const mainnetAuthors = role === "batch" ? MAINNET_BATCH_AUTHOR_KEYS : MAINNET_AUTHOR_KEYS;
  if (network === "mainnet" && !mainnetAuthors.includes(author)) {
    throw new Error(`${options.authorKeyFile} holds author key ${author}, not an FPS mainnet author key (${mainnetAuthors.join(", ")}); a mainnet operator writes under no other`);
  }
  if (network !== "mainnet" && [...MAINNET_AUTHOR_KEYS, ...MAINNET_BATCH_AUTHOR_KEYS].includes(author)) throw new Error(`${options.authorKeyFile} holds the FPS mainnet author key ${author}; a ${network} operator never loads it`);
  const saltKey = options.saltKeyFile === undefined ? undefined : hash32(readPrivateFile(options.saltKeyFile), options.saltKeyFile);
  if (saltKey) {
    const id = hex(saltKeyId(saltKey));
    if (network === "mainnet" && !MAINNET_SALT_KEY_IDS.includes(id)) {
      throw new Error(`${options.saltKeyFile} holds salt key ${id}, not an FPS mainnet salt key (${MAINNET_SALT_KEY_IDS.join(", ")}); a mainnet operator derives no kind-2 salt from any other`);
    }
    if (network !== "mainnet" && MAINNET_SALT_KEY_IDS.includes(id)) throw new Error(`${options.saltKeyFile} holds the FPS mainnet salt key ${id}; a ${network} operator never uses it`);
  }
  const journal = openJournal(options.journalPath);
  const chain = options.chain ?? chainView(source, network);
  const ttlMillis = (options.ttlMinutes ?? 15) * 60_000;
  const journalling = { journal, chain, wallet, network, pollMillis: options.pollMillis ?? 3_000 };
  const assertKindRole = (kind: number) => {
    if (![1, 2, 3].includes(kind)) throw new Error("Unknown anchor kind");
    if (role === "batch" && kind !== 3) throw new Error("A batch author writes kind 3 only");
    if (role === "relay" && kind === 3) throw new Error("A relay author writes only kind 1 or kind 2");
  };
  const keyOf = (kind: 1 | 2 | 3, commitment: string, attribute: string): AnchorKey => {
    assertKindRole(kind);
    return { network, registry: options.registry, author, kind, commitment, attribute };
  };

  // What `request` writes and how its circuit is called; for kind 2 also what opens it.
  const intent = (request: AnchorRequest): { key: AnchorKey; call: RegistryCallArgs; witnesses: RegistryWitnesses; opening?: HiddenOpening } => {
    assertKindRole(request.kind);
    if (request.kind === 1) {
      const commitment = entryCommitment(request.entry);
      return { key: keyOf(1, hex(commitment), ZERO), call: { circuit: "anchor", args: [commitment, 1n] }, witnesses: { authorSecret } };
    }
    if (request.kind === 3) {
      const commitment = batchAnchorCommitment(request);
      return { key: keyOf(3, hex(commitment), ZERO), call: { circuit: "anchor", args: [commitment, 3n] }, witnesses: { authorSecret } };
    }
    if (!saltKey) throw new Error("anchorHiding needs a salt key file");
    const { entry } = request;
    const attr = hash32(request.attribute, "attribute");
    const digest = hiddenDigest(entry, attr);
    const salt = deriveSalt(saltKey, digest);
    const hidden = { root_hash: hash32(entry.rootHash, "rootHash"), manifest_hash: hash32(entry.manifestHash, "manifestHash"), merkle_root: entry.merkleRoot === undefined ? new Uint8Array(32) : hash32(entry.merkleRoot, "merkleRoot"), salt };
    return {
      key: keyOf(2, hex(hidingCommitment(digest, salt)), hex(attr)),
      call: { circuit: "anchor_hiding", args: [attr] },
      witnesses: { authorSecret, hiddenEntry: hidden },
      opening: { rootHash: hex(hidden.root_hash), manifestHash: hex(hidden.manifest_hash), merkleRoot: hex(hidden.merkle_root), salt: hex(salt) },
    };
  };

  // Refuses final bytes that carry anything but exactly the anchor `key` names.
  const assertExact = (bytes: Uint8Array, key: AnchorKey) => {
    const transaction = finalTransaction(bytes);
    const intents = [...(transaction.intents?.values() ?? [])];
    if (transaction.rewards !== undefined || transaction.guaranteedOffer !== undefined || (transaction.fallibleOffer?.size ?? 0) !== 0 ||
      intents.some(intent => intent.guaranteedUnshieldedOffer !== undefined || intent.fallibleUnshieldedOffer !== undefined) ||
      intents.reduce((count, intent) => count + intent.actions.length, 0) !== 1) {
      throw new Error("the final bytes do not carry exactly the intended anchor; nothing was submitted");
    }
    const { calls, touches } = decodeAnchorTransaction(bytes, [key.registry]);
    const [call] = calls;
    const exact =
      touches.length === 0 &&
      calls.length === 1 &&
      call!.address === key.registry &&
      call!.entryPoint === (key.kind === 2 ? "anchor_hiding" : "anchor") &&
      call!.kind === key.kind &&
      call!.commitment === key.commitment &&
      call!.attribute === key.attribute &&
      call!.author === key.author;
    if (!exact) throw new Error("the final bytes do not carry exactly the intended anchor; nothing was submitted");
  };

  // Builds, proves, pays and binds the call against the registry's state on the node; bytes that
  // do not carry exactly the anchor never leave, and their DUST is released.
  const build = async ({ key, call, witnesses }: ReturnType<typeof intent>): Promise<Submission> => {
    const state = await registryStateOnNode(source, key.registry);
    if (!state) throw new Error(`the ${network} node holds no contract at ${key.registry}`);
    const ttl = new Date(Date.now() + ttlMillis);
    const built = unprovenRegistryCall({ networkId: network, address: key.registry, state, call, witnesses, ttl });
    if (key.kind === 2 && hex(built.after.last_commitment) !== key.commitment) throw new Error("the circuit computed a different kind-2 commitment than the opening");
    const { bytes } = await finalizeChecked(wallet, prover, built.tx, ttl, (b) => assertExact(b, key));
    return { bytes, ttl };
  };

  const receipt = (key: AnchorKey, row: JournalRow & { height: number; blockHash: string }): AnchorReceipt => ({
    network,
    registry: key.registry,
    txHash: row.txHash,
    blockHeight: row.height,
    blockHash: row.blockHash,
    kind: key.kind as 1 | 2 | 3,
    commitment: key.commitment,
    attribute: key.attribute,
    author,
  });

  const write = async (request: AnchorRequest) => {
    await assertKnownRuntime(source, network);
    const planned = intent(request);
    return { receipt: receipt(planned.key, await submitJournalled(journalling, planned.key, () => build(planned))), opening: planned.opening };
  };

  const describe = (key: AnchorKey, bytes: Uint8Array, ttl: Date, payer: string | undefined, held?: PreparedAnchor["journal"]): PreparedAnchor => {
    assertExact(bytes, key);
    const final = finalTransaction(bytes);
    return {
      network,
      registry: key.registry,
      author,
      kind: key.kind as 1 | 2 | 3,
      commitment: key.commitment,
      attribute: key.attribute,
      txHash: final.transactionHash(),
      bytes,
      ttl,
      declaredFee: declaredFee(final),
      ...(payer === undefined ? {} : { payer }),
      ...(held ? { journal: held } : {}),
    };
  };
  const confirmed = (key: AnchorKey) => confirmedSends(journalling, key, "anchor", "this anchor");
  const submit = async (prepared: PreparedAnchor) => {
    const { bytes, ttl, journal: held, ...fields } = prepared;
    const snapshot: PreparedAnchor = { ...fields, bytes: new Uint8Array(bytes), ttl: new Date(ttl.getTime()), ...(held === undefined ? {} : { journal: { ...held } }) };
    const key = keyOf(snapshot.kind, snapshot.commitment, snapshot.attribute);
    assertExact(snapshot.bytes, key);
    assertConfirmedHash(snapshot);
    await assertKnownRuntime(source, network);
    return receipt(key, await confirmed(key).submit(snapshot));
  };

  return {
    authorKey: author,
    anchor: async (entry) => (await write({ kind: 1, entry })).receipt,
    anchorBatch: async (batch) => (await write({ ...batch, kind: 3 })).receipt,
    async anchorHiding(entry, attribute) {
      const { receipt: written, opening } = await write({ kind: 2, entry, attribute });
      return { ...written, opening: opening! };
    },
    async journalled(request) {
      const { key } = intent(request);
      const row = await confirmed(key).held();
      return row && describe(key, row.bytes, row.ttl, row.payer, { state: row.state, broadcasts: row.broadcasts, expired: row.expired });
    },
    async prepare(request) {
      await assertKnownRuntime(source, network);
      const planned = intent(request);
      const { bytes, ttl } = await build(planned);
      return describe(planned.key, bytes, ttl, wallet.addresses.unshielded);
    },
    submit,
    async relocate(prepared) {
      await journal.relocate(prepared.txHash, chain);
      return submit(prepared);
    },
    discard: (prepared) => wallet.discard(finalTransaction(prepared.bytes)),
    reconcile: () => journal.reconcile(chain),
    close: () => journal.close(),
  };
}
