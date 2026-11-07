import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type * as L8 from "@midnightntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";
import { InMemoryTransactionHistoryStorage, ProtocolVersion, WalletTransaction, type FinalizedTx } from "@midnightntwrk/wallet-sdk-abstractions";
import { DustAddress, MidnightBech32m } from "@midnightntwrk/wallet-sdk-address-format";
import { Lifecycle, type TransactionLifecycleService } from "@midnightntwrk/wallet-sdk-capabilities";
import { makeIndexerChainVersionProbe } from "@midnightntwrk/wallet-sdk-capabilities/chainVersion";
import { CustomForkingDustWallet, dustVariantConfigurations, type DefaultDustConfiguration, type DustWalletClass } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { V1Builder } from "@midnightntwrk/wallet-sdk-dust-wallet/v1";
import { CoinsAndBalances, V2Builder } from "@midnightntwrk/wallet-sdk-dust-wallet/v2";
import { WalletEntrySchema, WalletFacade, mergeWalletEntries, type BalancingRecipe, type DefaultConfiguration, type FacadeState, type LifecycleTx } from "@midnightntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import { PublicKey, UnshieldedWallet } from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { Either } from "effect";
import { Observable, filter, firstValueFrom, map, of, take, takeUntil, timeout } from "rxjs";
import { TTL_MARGIN_MILLIS, openJournal, type JournalRow } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { decodeTransaction, readPrivateFile, writePrivateFile, type FinalTransaction, type MidnightNetwork, type MidnightSource, type SourceEndpoints } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { broadcast, nodeRefusal } from "./broadcast.js";
import { refuseMainnetSecretsPath } from "./custody.js";
import { addressesOf, walletSecrets, type WalletAddresses } from "./keys.js";
import { credentialRelay } from "./relay.js";
import type { UnboundTransaction } from "./submission.js";
import { provingBackends } from "./zk.js";

export interface WalletBalances {
  // Unshielded NIGHT, in its smallest unit (STAR).
  night: bigint;
  // DUST available now, in SPECK (10^-15 DUST).
  dust: bigint;
  nightUtxos: number;
  registeredNightUtxos: number;
}

// How far each part of the wallet has applied the indexer's events, of how many it knows.
export interface SyncProgress {
  shielded: { applied: bigint; highest: bigint; connected: boolean };
  unshielded: { applied: bigint; highest: bigint; connected: boolean };
  dust: { applied: bigint; highest: bigint; connected: boolean };
  synced: boolean;
}

export interface CostParameters {
  // DUST (in SPECK, at least 1) declared on top of the computed fee; the whole declared fee is burned.
  additionalFeeOverhead: bigint;
  // Blocks of fee-price movement the computed fee absorbs.
  feeBlocksMargin: number;
}

export const DEFAULT_COST_PARAMETERS: CostParameters = { additionalFeeOverhead: 1n, feeBlocksMargin: 5 };

// Ledger 9 from the protocol version midnight-node 2.x reports: mainnet runtime 2001100 and after.
// Below it, as on a chain still running runtime 1000300, the wallets read the chain with ledger 8.
export const MIDNIGHT_FORKS: ProtocolVersion.ForkSchedule = ProtocolVersion.V9NativeForkSchedule;

// How long a fee waits for the DUST sync to apply every event the indexer announced.
const DUST_SYNC_WAIT_MS = 120_000;

// Upper bound on shielded/DUST sync groups. The SDK flushes partial groups after 1 ms;
// it does not wait for 1000 events. Historical review measurements under load found up to
// 5.5 s DUST and 5.2–6.9 s shielded event-loop stalls for a full group. These are observations,
// not latency guarantees. Larger groups did not materially improve throughput.
const SYNC_BATCH_SIZE = 1000;

// The DUST coin a fee spends next: the largest with any value. Every spend adds to the fee, and
// the SDK's default, smallest first, spends each coin too small to pay alone before a larger one.
export const largestCoinFirst: CoinsAndBalances.CoinSelection = (coins) =>
  coins.filter((coin) => coin.value > 0n).sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))[0];

// The SDK's DustWallet, both ledgers' variants taking coins largest first.
function operatorDustWallet(configuration: DefaultDustConfiguration): DustWalletClass {
  const { v1, v2, migration } = dustVariantConfigurations(configuration);
  return CustomForkingDustWallet(
    { ...configuration, chainVersionProbe: makeIndexerChainVersionProbe(configuration) },
    { builder: new V1Builder().withDefaults().withCoinSelection(() => largestCoinFirst), configuration: v1 },
    { builder: new V2Builder().withDefaults().withMigration(migration).withCoinSelection(() => largestCoinFirst), configuration: v2 },
  );
}

// How far the indexer's head may stand from the node's finalized head before a fee is refused:
// the bound wallet-sdk-capabilities 4.0.0's own liveness check applies.
const INDEXER_LIVENESS_BLOCKS = 10;

// The cost parameters a wallet runs with. An overhead of at least 1 SPECK keeps every computed fee
// above 0, so every fee is paid with a DUST spend: a fee computed as 0 is balanced with no DUST
// spend at all, which pays nothing once the node prices the transaction above 0.
export function costParametersOf(given: CostParameters | undefined): CostParameters {
  const parameters = given ?? DEFAULT_COST_PARAMETERS;
  if (parameters.additionalFeeOverhead < 1n) {
    throw new Error(`additionalFeeOverhead must be at least 1 SPECK, not ${parameters.additionalFeeOverhead}: a fee computed as 0 carries no DUST spend and pays nothing`);
  }
  return parameters;
}

export interface OperatorWallet {
  readonly network: MidnightNetwork;
  readonly addresses: WalletAddresses;
  // What its credential relay's URLs carry that grants use of the credential: never to be logged.
  readonly secrets: readonly string[];
  waitForSync(timeoutMs?: number, signal?: AbortSignal): Promise<void>;
  progress(): Promise<SyncProgress>;
  // Saves the sync state to the wallet's state file, so the next open resumes from here. It
  // installs only a state each sub-wallet reads back, and starts once the wallet's previous save
  // finished. A save that fails is returned and logged, never thrown, and leaves the file as it was.
  saveState(): Promise<StateSave>;
  balances(): Promise<WalletBalances>;
  // Registers every unregistered NIGHT UTXO to generate DUST for this wallet; null when none is.
  registerNightForDust(): Promise<string | null>;
  // Pays the transaction's fee from DUST (proving the DUST spend in-process) and binds it: the
  // final bytes, of the ledger the wallet is acting at, whose DUST the wallet holds as spent.
  payFee(tx: L8.Transaction<L8.SignatureEnabled, L8.Proof, L8.PreBinding>, ttl: Date): Promise<L8.FinalizedTransaction>;
  payFee(tx: L9.Transaction<L9.SignatureEnabled, L9.Proof, L9.PreBinding>, ttl: Date): Promise<L9.FinalizedTransaction>;
  payFee(tx: UnboundTransaction, ttl: Date): Promise<FinalTransaction>;
  // Hands final bytes to the node. The node's refusal of the first delivery of bytes this wallet
  // balanced frees the DUST they spend, and those bytes are never sent again; any other failure,
  // or a refusal of bytes some delivery may already have left with a node, keeps it held.
  submit(tx: FinalTransaction): Promise<void>;
  // Frees the DUST of final bytes this wallet balanced and never handed to a node, which are then
  // never sent; already freed bytes are a no-op, and other bytes are refused.
  discard(tx: FinalTransaction): Promise<void>;
  // Stops syncing; a synced wallet with a state file saves first, and returns what that save did.
  close(): Promise<StateSave | null>;
}

// The three sub-wallets' serialized sync state: their coins and how far they have read, which a
// restart restores instead of replaying every ledger event from genesis.
export interface WalletSnapshot {
  shielded: string;
  unshielded: string;
  dust: string;
}

// What a save did. One that failed wrote nothing: the state file keeps its last good save, which
// the next open resumes from, replaying the events since. Each failure names the sub-wallet whose
// state did not serialize, or "file" when the write did not complete.
export interface StateSaveFailure {
  part: keyof WalletSnapshot | "file";
  error: string;
}
export type StateSave = { saved: true } | { saved: false; failures: StateSaveFailure[] };

// What a state file is written as. wallet-sdk 1.x state files carry no format and are never
// restored: openWallet moves one aside and syncs from genesis (moveLegacyWalletState).
export const WALLET_STATE_FORMAT = "orynq-midnight-wallet-state/wallet-sdk-2";

const STATE_FILE_ERRNOS = new Set([
  "EACCES", "EBUSY", "EDQUOT", "EEXIST", "EFBIG", "EIO", "EISDIR", "ELOOP",
  "EMFILE", "ENAMETOOLONG", "ENFILE", "ENOENT", "ENOSPC", "ENOTDIR", "EPERM",
  "EROFS", "EXDEV",
]);

// A failed part's error by its name and, for a schema error from the wallet SDK, what each step
// that threw said and the underlying error's name, never its message (which can quote state).
// File failures retain only recognized errno codes; their messages can quote private paths.
function describeFailure(error: unknown): string {
  const thrown = (issue: unknown): string[] => {
    if (typeof issue !== "object" || issue === null) return [];
    const i = issue as { _tag?: string; message?: string; actual?: unknown; issue?: unknown; issues?: unknown };
    if (i._tag === "Unexpected") return [i.actual instanceof Error ? `${i.message}: ${i.actual.name}` : String(i.message)];
    return [i.issue, ...[i.issues].flat()].flatMap(thrown);
  };
  const e = error as { name?: string; _tag?: string; code?: unknown; issue?: unknown; cause?: unknown };
  if (e?.issue !== undefined) return [e.name, ...thrown(e.issue)].join(": ");
  // A wallet error wrapping a schema error quotes the state in its message.
  if (typeof e?.cause === "object" && e.cause !== null) return `${e._tag ?? e.name}: ${describeFailure(e.cause)}`;
  const code = typeof e?.code === "string" && STATE_FILE_ERRNOS.has(e.code) ? `: ${e.code}` : "";
  return `${e?._tag ?? e?.name ?? "Error"}${code}`;
}

// A sub-wallet's class, as far as it reads a serialized state back, as its restore() does.
type StateReader<W extends { stop(): Promise<void> } = { stop(): Promise<void> }> = { tryRestore(serialized: string): Either.Either<W, unknown> };

// Whether `Wallet` reads `serialized` back, or what the SDK said of it. A read-back wallet is
// built but never started, and stopped at once.
async function readsBack(Wallet: StateReader, serialized: string): Promise<Either.Either<true, string>> {
  const read = Wallet.tryRestore(serialized);
  if (Either.isLeft(read)) return Either.left(describeFailure(read.left));
  await read.right.stop();
  return Either.right(true);
}

// Moves a state file wallet-sdk 1.x saved aside, beside it as `<file>.wallet-sdk-1`, so the wallet
// syncs from genesis: wallet-sdk 2.x rebuilds the DUST state from the chain, and the 1.x state
// predates every ledger 9 event. Returns where it went, or null when the file is not a 1.x one.
// A sync from genesis offers again every coin a fee still in flight spent, so the file stays
// while any of `held`, the fees the wallet paid, may land: until its TTL plus the journal's margin.
export function moveLegacyWalletState(file: string, held: ReadonlyArray<Pick<JournalRow, "txHash" | "ttl">>): string | null {
  if (!savedByWalletSdk1(file)) return null;
  const inFlight = held.find((row) => row.ttl.getTime() + TTL_MARGIN_MILLIS > Date.now());
  if (inFlight) {
    throw new Error(`${file} was saved by wallet-sdk 1.x while the fee ${inFlight.txHash} the wallet paid may still land, until ${new Date(inFlight.ttl.getTime() + TTL_MARGIN_MILLIS).toISOString()}; a sync from genesis would spend its DUST again, so the state file stays until the journal settles it`);
  }
  const aside = `${file}.wallet-sdk-1`;
  if (existsSync(aside)) throw new Error(`${file} was saved by wallet-sdk 1.x and ${aside} already exists; move one of them before opening the wallet`);
  renameSync(file, aside);
  return aside;
}

// Whether `file` is a state file wallet-sdk 1.x saved: JSON with no format tag.
function savedByWalletSdk1(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    return (JSON.parse(readPrivateFile(file)) as { format?: unknown }).format === undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

// The pending rows of `journals` that `payer` paid, or that name no payer.
function feesPaidBy(journals: readonly string[], payer: string): JournalRow[] {
  return journals.filter((path) => existsSync(path)).flatMap((path) => {
    const journal = openJournal(path);
    try {
      return journal.pending().filter((row) => row.payer === undefined || row.payer === payer);
    } finally {
      journal.close();
    }
  });
}

// The wallet's saved state, or null before it first saves one. A state saved by another wallet,
// on another network or from another indexer (whose event ids its offsets do not name) is
// refused, as is a file group or others can read, and one wallet-sdk 1.x wrote.
export function readWalletState(file: string, network: MidnightNetwork, addresses: WalletAddresses, indexer: string): WalletSnapshot | null {
  if (!existsSync(file)) return null;
  let saved: { format?: unknown; network: string; addresses: WalletAddresses; indexer: string } & WalletSnapshot;
  try {
    saved = JSON.parse(readPrivateFile(file));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${file} is not JSON; move it aside to sync from genesis`);
    throw error;
  }
  if (saved.format !== WALLET_STATE_FORMAT) throw new Error(`${file} was not saved by this wallet's wallet-sdk 2.x state format; move it aside to sync from genesis`);
  if (saved.network !== network) throw new Error(`${file} was saved on another network`);
  if ((["unshielded", "shielded", "dust"] as const).some((role) => saved.addresses[role] !== addresses[role])) throw new Error(`${file} was saved by another wallet`);
  if (saved.indexer !== indexer) throw new Error(`${file} was synced from another indexer`);
  return { shielded: saved.shielded, unshielded: saved.unshielded, dust: saved.dust };
}

// Each save writes a file of its own beside the state file, named for the saving process and a
// random suffix (a dead process's pid can be reused), and renames it over the state file, so two
// processes saving one state file never install or remove each other's unfinished write.
const SAVE_IN_PROGRESS = /^(\d{1,9})\.[0-9a-f]{16}\.next$/;

// Replaces the saved state atomically with a file only its owner can read, leaving nothing
// beside it when it fails.
export function writeWalletState(file: string, network: MidnightNetwork, addresses: WalletAddresses, indexer: string, snapshot: WalletSnapshot): void {
  const next = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.next`;
  writePrivateFile(next, JSON.stringify({ format: WALLET_STATE_FORMAT, network, addresses, indexer, ...snapshot }));
  try {
    renameSync(next, file);
  } catch (error) {
    rmSync(next, { force: true });
    throw error;
  }
}

// Removes what saves of the state file left when their process died before renaming it into
// place. A save whose process still runs, or runs as another user, is left to finish.
function removeAbandonedSaves(file: string): void {
  const gone = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return true;
      if (code === "EPERM") return false;
      throw error;
    }
  };
  const dir = dirname(file);
  const prefix = `${basename(file)}.`;
  for (const name of readdirSync(dir)) {
    const pid = name.startsWith(prefix) ? SAVE_IN_PROGRESS.exec(name.slice(prefix.length))?.[1] : undefined;
    if (pid !== undefined && gone(Number(pid))) rmSync(join(dir, name), { force: true });
  }
}

// The facade's lifecycle record of each transaction it balances, never moved: so the facade never
// frees DUST on its own. wallet-sdk 2.x's default service records each transaction and frees its
// DUST once the transaction's TTL passes by this machine's clock with no inclusion the indexer
// shows, which an indexer behind the chain makes true of bytes already in a block. Here DUST is
// freed only where the write-ahead journal decides: a node's refusal of the first delivery, or a
// discard of bytes never handed to a node. Otherwise the DUST wallet holds the spend until the
// bytes land or the ledger's grace period ends.
export function journalCustodyLifecycle(): TransactionLifecycleService<LifecycleTx> {
  const none = async () => undefined;
  return {
    start: none,
    stop: none,
    state: () => of(Lifecycle.empty<LifecycleTx>()),
    balanced: none,
    finalized: none,
    submitted: none,
    reverted: none,
    orphanBeyond: none,
    included: none,
    serializeState: async () => "",
  };
}

// Refuses an indexer that stands more than INDEXER_LIVENESS_BLOCKS from the node's finalized head,
// or that holds another block at a finalized height. Both are read through `source`, the
// credentialed reads, never a connection of the wallet SDK's own.
export async function assertIndexerLive(source: Pick<MidnightSource, "indexer" | "node">, network: MidnightNetwork): Promise<void> {
  const indexed = await source.indexer.head();
  const finalizedHash = String(await source.node.call<string>("chain_getFinalizedHead")).replace(/^0x/, "");
  const finalized = await source.node.call<{ number: string }>("chain_getHeader", [`0x${finalizedHash}`]);
  const height = Number.parseInt(finalized.number, 16);
  if (!Number.isSafeInteger(height) || !Number.isSafeInteger(indexed.height)) throw new Error(`the ${network} node or indexer returned an invalid head`);
  if (Math.abs(indexed.height - height) > INDEXER_LIVENESS_BLOCKS) {
    throw new Error(`the ${network} indexer stands at block ${indexed.height} and the node's finalized head at ${height}, more than ${INDEXER_LIVENESS_BLOCKS} blocks apart; no fee was paid`);
  }
  // Compared at the lower of the two heads: the node's block at the indexer's head when the
  // indexer is behind, the indexer's block at the node's finalized head when it is ahead.
  if (indexed.height <= height) {
    const hash = String(await source.node.call<string>("chain_getBlockHash", [indexed.height])).replace(/^0x/, "");
    if (hash !== indexed.hash) throw new Error(`the ${network} indexer's block ${indexed.height} is not the node's finalized block there; no fee was paid`);
  } else {
    const block = await indexerBlockAt(source, height);
    if (!block) throw new Error(`the ${network} indexer holds no block at the node's finalized height ${height}; no fee was paid`);
    if (block.hash !== finalizedHash) throw new Error(`the ${network} indexer's block ${height} is not the node's finalized block there; no fee was paid`);
  }
}

const indexerBlockAt = (source: Pick<MidnightSource, "indexer">, height: number) => {
  if (!source.indexer.blockAt) throw new Error("the indexer source reads no block by height");
  return source.indexer.blockAt(height);
};

// Refuses an indexer whose genesis block is not the node's: the two serve different chains.
async function assertSameChain(source: Pick<MidnightSource, "indexer" | "node">, network: MidnightNetwork): Promise<void> {
  const [indexed, node] = await Promise.all([indexerBlockAt(source, 0), source.node.call<string>("chain_getBlockHash", [0])]);
  const genesis = String(node).replace(/^0x/, "");
  if (indexed?.hash !== genesis) throw new Error(`the ${network} indexer's genesis block ${indexed?.hash ?? "(none)"} is not the node's ${genesis}; the wallet was not opened`);
}

export interface WalletOptions {
  network: MidnightNetwork;
  mnemonicFile: string;
  endpoints: SourceEndpoints;
  source: MidnightSource;
  zkDir: string;
  // The wallet's recorded public addresses: opening refuses a mnemonic that derives others.
  expectedAddresses?: WalletAddresses;
  // A private file the wallet restores its sync state from and saves it to on close.
  stateFile?: string;
  // The journals of every fee this wallet may have paid; a state file wallet-sdk 1.x saved is
  // moved aside only once none of them holds a fee of this wallet that may still land.
  journals?: readonly string[];
  costParameters?: CostParameters;
}

const ledgerOf = (tx: UnboundTransaction) => (tx instanceof L9.Transaction ? 9 : 8);

// A Midnight wallet (HD account 0, index 0) over the network's indexer, reading the chain with
// ledger 8 below MIDNIGHT_FORKS.v9 and ledger 9 from it, proving in-process and submitting
// through the source's node. Every connection the wallet SDK opens goes to the credential relay,
// and no SDK liveness check dials a node: the wallet names no node to the SDK. The secret keys
// stay inside this closure.
export async function openWallet(options: WalletOptions): Promise<OperatorWallet> {
  const { network, mnemonicFile, endpoints, source, zkDir } = options;
  const costParameters = costParametersOf(options.costParameters);
  refuseMainnetSecretsPath(network, mnemonicFile);
  const secrets = walletSecrets(mnemonicFile, network);
  const addresses = addressesOf(secrets, network);
  if (options.expectedAddresses) {
    for (const role of ["unshielded", "shielded", "dust"] as const) {
      if (addresses[role] !== options.expectedAddresses[role]) {
        throw new Error(`${mnemonicFile} derives ${role} address ${addresses[role]}, not the recorded ${options.expectedAddresses[role]}`);
      }
    }
  }
  if (options.stateFile) {
    removeAbandonedSaves(options.stateFile);
    const legacy = savedByWalletSdk1(options.stateFile);
    if (legacy && !options.journals) throw new Error(`${options.stateFile} was saved by wallet-sdk 1.x, and no journal of the fees the wallet paid was named; the state file stays`);
    const aside = moveLegacyWalletState(options.stateFile, legacy ? feesPaidBy(options.journals!, addresses.unshielded) : []);
    if (aside) console.error(`${options.stateFile} was saved by wallet-sdk 1.x and moved to ${aside}; the ${network} wallet syncs from genesis`);
  }
  const saved = options.stateFile ? readWalletState(options.stateFile, network, addresses, endpoints.indexer) : null;
  // Each sub-wallet's class, which reads back the states that sub-wallet serializes.
  const readers = {} as Record<keyof WalletSnapshot, StateReader>;
  // The sub-wallet `part`, of class `Wallet`: restored from the saved state, refusing a state it
  // does not read back with what the SDK said of it, never the state; started afresh without one.
  const subWallet = <W extends { stop(): Promise<void> }>(part: keyof WalletSnapshot, Wallet: StateReader<W>, start: () => Promise<W>): Promise<W> | W => {
    readers[part] = Wallet;
    if (!saved) return start();
    const read = Wallet.tryRestore(saved[part]);
    if (Either.isLeft(read)) throw new Error(`${options.stateFile} does not restore (${part}: ${describeFailure(read.left)}); move it aside to sync from genesis`);
    return read.right;
  };
  await assertSameChain(source, network);
  const transport = await credentialRelay(endpoints);
  const submitTo = (tx: FinalTransaction) => broadcast(source, tx.serialize());
  const configuration = {
    networkId: network,
    indexerClientConnection: { indexerHttpUrl: transport.indexerHttpUrl, indexerWsUrl: transport.indexerWsUrl },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters,
    batchUpdates: { size: SYNC_BATCH_SIZE },
    forks: MIDNIGHT_FORKS,
    provers: provingBackends(zkDir),
  } as unknown as DefaultConfiguration;
  let facade: WalletFacade;
  try {
    facade = await WalletFacade.init({
      configuration,
      submissionService: () => ({
        submitTransaction: (async (handle: FinalizedTx) => {
          const tx = decodeTransaction(handle.serialize()).tx;
          await submitTo(tx);
          return { _tag: "Submitted", tx: handle, txHash: tx.transactionHash() };
        }) as never,
        close: async () => undefined,
      }),
      shielded: (c) => {
        const Shielded = ShieldedWallet(c);
        return subWallet("shielded", Shielded, () => Shielded.startWithSeed(secrets.seeds.shielded));
      },
      unshielded: (c) => {
        const Unshielded = UnshieldedWallet(c);
        return subWallet("unshielded", Unshielded, () => Unshielded.startWithPublicKey(PublicKey.fromKeyStore(secrets.night)));
      },
      dust: (c) => {
        const Dust = operatorDustWallet(c);
        return subWallet("dust", Dust, () => Dust.startWithSeed(secrets.seeds.dust));
      },
      transactionLifecycleService: () => journalCustodyLifecycle(),
    });
    await facade.start(secrets.seeds);
  } catch (error) {
    await transport.close();
    throw error;
  }

  // The first wallet state `ready` accepts, or after `timeoutMs` the error `late` writes from the
  // state then.
  const until = (ready: (s: FacadeState) => boolean, timeoutMs: number, late: (s: FacadeState) => string, signal?: AbortSignal) =>
    firstValueFrom(
      facade.state().pipe(
        filter(ready),
        timeout({
          first: timeoutMs,
          with: () =>
            facade.state().pipe(
              take(1),
              map((s) => {
                throw new Error(late(s));
              }),
            ),
        }),
        takeUntil(new Observable<never>(subscriber => {
          if (!signal) return;
          const abort = () => subscriber.error(new Error("Wallet sync interrupted"));
          if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
          return () => signal.removeEventListener("abort", abort);
        })),
      ),
    );
  const synced = (timeoutMs: number, signal?: AbortSignal) => until((s) => s.isSynced, timeoutMs, () => `the ${network} wallet did not sync within ${timeoutMs / 1000} s`, signal);
  const nightToken = L9.unshieldedToken().raw;
  // The handle of each final transaction this wallet balanced, by hash: what the facade frees.
  const handles = new Map<string, FinalizedTx>();
  // Bytes this wallet balanced and has not handed to a node, and bytes whose DUST it freed.
  const unsent = new Set<string>();
  const freed = new Set<string>();
  const finalize = async (recipe: BalancingRecipe) => {
    const handle = await facade.finalizeRecipe(recipe);
    const tx = decodeTransaction(handle.serialize()).tx;
    handles.set(tx.transactionHash(), handle);
    unsent.add(tx.transactionHash());
    return tx;
  };
  const free = async (tx: FinalTransaction) => {
    const txHash = tx.transactionHash();
    freed.add(txHash);
    await facade.revert(handles.get(txHash)!);
  };
  const submit = async (tx: FinalTransaction) => {
    const txHash = tx.transactionHash();
    if (freed.has(txHash)) throw new Error(`transaction ${txHash} was refused or discarded, and the DUST it spent freed; its bytes are never sent again`);
    const first = unsent.delete(txHash);
    try {
      await submitTo(tx);
    } catch (error) {
      // Only the node's answer to the first delivery shows that no node holds the bytes; anything
      // else, and any later delivery, may follow one that reached a node.
      if (first && nodeRefusal(error)) await free(tx);
      throw error;
    }
  };

  const saveTo = async (file: string): Promise<StateSave> => {
    const parts = ["shielded", "unshielded", "dust"] as const;
    const serialized = await Promise.allSettled(parts.map((part) => facade[part].serializeState()));
    const failures: StateSaveFailure[] = [];
    for (const [i, s] of serialized.entries()) {
      const part = parts[i]!;
      if (s.status === "rejected") failures.push({ part, error: describeFailure(s.reason) });
      else {
        const read = await readsBack(readers[part], s.value);
        if (Either.isLeft(read)) failures.push({ part, error: read.left });
      }
    }
    if (failures.length === 0) {
      const [shielded, unshielded, dust] = serialized.map((s) => (s as PromiseFulfilledResult<string>).value) as [string, string, string];
      try {
        writeWalletState(file, network, addresses, endpoints.indexer, { shielded, unshielded, dust });
        return { saved: true };
      } catch (error) {
        failures.push({ part: "file", error: describeFailure(error) });
      }
    }
    console.error(
      `${file}: the ${network} wallet's sync state was not saved (${failures.map((f) => `${f.part}: ${f.error}`).join("; ")}); the file keeps its last good save, and the next open resumes from it and replays the events since`,
    );
    return { saved: false, failures };
  };
  let previousSave: Promise<unknown> = Promise.resolve();
  const saveState = async (): Promise<StateSave> => {
    const file = options.stateFile;
    if (!file) throw new Error("the wallet was opened without a state file");
    const save = previousSave.then(() => saveTo(file));
    previousSave = save;
    return save;
  };

  return {
    network,
    addresses,
    secrets: transport.secrets,
    async waitForSync(timeoutMs = 600_000, signal?: AbortSignal) {
      await synced(timeoutMs, signal);
    },
    async progress() {
      const s = await firstValueFrom(facade.state());
      const indexed = (p: { appliedIndex: bigint; highestRelevantWalletIndex: bigint; isConnected: boolean }) => ({ applied: p.appliedIndex, highest: p.highestRelevantWalletIndex, connected: p.isConnected });
      const u = s.unshielded.progress;
      return {
        shielded: indexed(s.shielded.progress),
        dust: indexed(s.dust.progress),
        unshielded: { applied: u.appliedId, highest: u.highestTransactionId, connected: u.isConnected },
        synced: s.isSynced,
      };
    },
    async balances() {
      const s = await synced(600_000);
      const coins = s.unshielded.availableCoins;
      return {
        night: s.unshielded.balances[nightToken] ?? 0n,
        dust: s.dust.balance(new Date()),
        nightUtxos: coins.length,
        registeredNightUtxos: coins.filter((c) => c.meta.registeredForDustGeneration).length,
      };
    },
    async registerNightForDust() {
      const s = await synced(600_000);
      const unregistered = s.unshielded.availableCoins.filter((c) => !c.meta.registeredForDustGeneration);
      if (unregistered.length === 0) return null;
      const receiver = MidnightBech32m.parse(addresses.dust).decode(DustAddress, network);
      const recipe = await facade.registerNightUtxosForDustGeneration(unregistered, secrets.night.getPublicKey(), secrets.night.signDataAsync, receiver);
      const tx = await finalize(recipe);
      await submit(tx);
      return tx.transactionHash();
    },
    // The fee's DUST spend is dated at a block whose DUST trees the wallet holds, so the fee waits
    // until the wallet has applied every event the indexer's last message announced, and is paid
    // only while the indexer stands within reach of the node's finalized head.
    async payFee(tx: UnboundTransaction, ttl: Date): Promise<never> {
      const s = await until(
        (state) => state.dust.progress.isStrictlyComplete(),
        DUST_SYNC_WAIT_MS,
        ({ dust: { progress: p } }) => `the ${network} wallet's DUST sync had applied ${p.appliedIndex} of the ${p.highestRelevantWalletIndex} events the indexer announced after ${DUST_SYNC_WAIT_MS / 1000} s; no fee was paid`,
      );
      const version = s.activeProtocolVersion;
      const acting = version >= MIDNIGHT_FORKS.v9 ? 9 : 8;
      if (ledgerOf(tx) !== acting) throw new Error(`the ${network} wallet acts at protocol version ${version}, ledger ${acting}, and pays no fee for a ledger ${ledgerOf(tx)} transaction; no fee was paid`);
      await assertIndexerLive(source, network);
      return finalize(await facade.balanceUnboundTransaction(WalletTransaction.adopt("Unbound", tx, version), { ttl, tokenKindsToBalance: ["dust"] })) as Promise<never>;
    },
    submit,
    async discard(tx) {
      const txHash = tx.transactionHash();
      if (freed.has(txHash)) return;
      if (!unsent.delete(txHash)) throw new Error(`transaction ${txHash} was handed to a node, or not balanced by this wallet since it opened, so its DUST stays held until the chain settles it`);
      await free(tx);
    },
    saveState,
    async close() {
      try {
        const saved = options.stateFile && (await firstValueFrom(facade.state())).isSynced ? await saveState() : null;
        await facade.stop();
        return saved;
      } finally {
        await transport.close();
      }
    },
  };
}
