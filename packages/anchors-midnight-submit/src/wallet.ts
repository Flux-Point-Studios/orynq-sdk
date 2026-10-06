import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as L from "@midnight-ntwrk/ledger-v8";
import { InMemoryTransactionHistoryStorage } from "@midnight-ntwrk/wallet-sdk-abstractions";
import { MidnightBech32m, DustAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import type { UnboundTransaction } from "@midnight-ntwrk/wallet-sdk-capabilities/proving";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { WalletEntrySchema, WalletFacade, mergeWalletEntries, type FacadeState } from "@midnight-ntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import { PublicKey, UnshieldedWallet } from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { filter, firstValueFrom, timeout } from "rxjs";
import { readPrivateFile, writePrivateFile, type MidnightNetwork, type MidnightSource, type SourceEndpoints } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { broadcast, nodeRefusal } from "./broadcast.js";
import { refuseMainnetSecretsPath } from "./custody.js";
import { addressesOf, walletSecrets, type WalletAddresses } from "./keys.js";
import { credentialRelay } from "./relay.js";
import { provingService } from "./zk.js";

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

// The cost parameters a wallet runs with. wallet-sdk-dust-wallet 4.2.0 pays a fee by selecting
// DUST until it covers the fee its dry run computes; for a transaction whose computed fee is 0
// (an anchor on a quiet chain, a maintenance update) it selects nothing, round after round, in a
// synchronous loop whose ledger allocations grow the wasm heap until the ledger traps
// (midnight-wallet#438, #700). An overhead of at least 1 SPECK keeps every computed fee above 0.
export function costParametersOf(given: CostParameters | undefined): CostParameters {
  const parameters = given ?? DEFAULT_COST_PARAMETERS;
  if (parameters.additionalFeeOverhead < 1n) {
    throw new Error(`additionalFeeOverhead must be at least 1 SPECK, not ${parameters.additionalFeeOverhead}: wallet-sdk-dust-wallet 4.2.0 never finishes paying a fee computed as 0`);
  }
  return parameters;
}

export interface OperatorWallet {
  readonly network: MidnightNetwork;
  readonly addresses: WalletAddresses;
  waitForSync(timeoutMs?: number): Promise<void>;
  progress(): Promise<SyncProgress>;
  // Saves the sync state to the wallet's state file, so the next open resumes from here. A save
  // that fails is returned and logged, never thrown, and leaves the file as it was.
  saveState(): Promise<StateSave>;
  balances(): Promise<WalletBalances>;
  // Registers every unregistered NIGHT UTXO to generate DUST for this wallet; null when none is.
  registerNightForDust(): Promise<string | null>;
  // Pays the transaction's fee from DUST (proving the DUST spend in-process) and binds it: the
  // final bytes, recorded by the wallet as pending.
  payFee(tx: UnboundTransaction, ttl: Date): Promise<L.FinalizedTransaction>;
  // Hands final bytes to the node. A refusal releases the DUST they spend.
  submit(tx: L.FinalizedTransaction): Promise<void>;
  // Releases the DUST of final bytes that will never be submitted.
  discard(tx: L.FinalizedTransaction): Promise<void>;
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

// A failed part's error by its name and, for a schema error from the wallet SDK, what each step
// that threw said and threw, never the state it was given.
function describeFailure(error: unknown): string {
  const thrown = (issue: unknown): string[] => {
    if (typeof issue !== "object" || issue === null) return [];
    const i = issue as { _tag?: string; message?: string; actual?: unknown; issue?: unknown; issues?: unknown };
    if (i._tag === "Unexpected") return [i.actual instanceof Error ? `${i.message}: ${i.actual.name}: ${i.actual.message}` : String(i.message)];
    return [i.issue, ...[i.issues].flat()].flatMap(thrown);
  };
  const e = error as { name?: string; message?: string; issue?: unknown };
  if (e?.issue === undefined) return `${e?.name ?? "Error"}: ${e?.message ?? String(error)}`;
  return [e.name, ...thrown(e.issue)].join(": ");
}

// The wallet's saved state, or null before it first saves one. A state saved by another wallet,
// on another network or from another indexer (whose event ids its offsets do not name) is
// refused, as is a file group or others can read.
export function readWalletState(file: string, network: MidnightNetwork, addresses: WalletAddresses, indexer: string): WalletSnapshot | null {
  if (!existsSync(file)) return null;
  const saved = JSON.parse(readPrivateFile(file)) as { network: string; addresses: WalletAddresses; indexer: string } & WalletSnapshot;
  if (saved.network !== network) throw new Error(`${file} was saved on ${saved.network}, not ${network}`);
  if ((["unshielded", "shielded", "dust"] as const).some((role) => saved.addresses[role] !== addresses[role])) throw new Error(`${file} was saved by another wallet`);
  if (saved.indexer !== indexer) throw new Error(`${file} was synced from ${saved.indexer}, not ${indexer}`);
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
  writePrivateFile(next, JSON.stringify({ network, addresses, indexer, ...snapshot }));
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
  costParameters?: CostParameters;
}

// A Midnight wallet (HD account 0, index 0) over the network's indexer, proving in-process and
// submitting through the source's node. The secret keys stay inside this closure.
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
  if (options.stateFile) removeAbandonedSaves(options.stateFile);
  const saved = options.stateFile ? readWalletState(options.stateFile, network, addresses, endpoints.indexer) : null;
  const transport = await credentialRelay(endpoints);
  const submitTo = (tx: L.FinalizedTransaction) => broadcast(source, tx.serialize());
  const configuration = {
    networkId: network,
    indexerClientConnection: { indexerHttpUrl: transport.indexerHttpUrl, indexerWsUrl: transport.indexerWsUrl },
    // Never dialled: submissionService below replaces the SDK's WebSocket submitter.
    relayURL: new URL(endpoints.node.replace(/^http/, "ws")),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters,
  };
  let facade: WalletFacade;
  try {
    facade = await WalletFacade.init({
      configuration,
      provingService: () => provingService(zkDir),
      submissionService: () => ({
        submitTransaction: (async (tx: L.FinalizedTransaction) => {
          await submitTo(tx);
          return { _tag: "Submitted", tx: tx.serialize(), txHash: tx.transactionHash() };
        }) as never,
        close: async () => undefined,
      }),
      shielded: (c) => (saved ? ShieldedWallet(c).restore(saved.shielded) : ShieldedWallet(c).startWithSecretKeys(secrets.zswap)),
      unshielded: (c) => (saved ? UnshieldedWallet(c).restore(saved.unshielded) : UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(secrets.night))),
      dust: (c) => (saved ? DustWallet(c).restore(saved.dust) : DustWallet(c).startWithSecretKey(secrets.dust, L.LedgerParameters.initialParameters().dust)),
    });
    await facade.start(secrets.zswap, secrets.dust);
  } catch (error) {
    await transport.close();
    throw error;
  }

  const synced = (timeoutMs: number) =>
    firstValueFrom(
      facade.state().pipe(
        filter((s: FacadeState) => s.isSynced),
        timeout({ first: timeoutMs, with: () => Promise.reject(new Error(`the ${network} wallet did not sync within ${timeoutMs / 1000} s`)) }),
      ),
    );
  const nightToken = L.unshieldedToken().raw;
  const keys = { shieldedSecretKeys: secrets.zswap, dustSecretKey: secrets.dust };
  const submit = async (tx: L.FinalizedTransaction) => {
    try {
      await submitTo(tx);
    } catch (error) {
      // An answer from the node is a refusal; anything else may have been delivered.
      if (nodeRefusal(error)) await facade.revert(tx);
      throw error;
    }
  };

  const saveState = async (): Promise<StateSave> => {
    const file = options.stateFile;
    if (!file) throw new Error("the wallet was opened without a state file");
    const parts = ["shielded", "unshielded", "dust"] as const;
    const serialized = await Promise.allSettled(parts.map((part) => facade[part].serializeState()));
    const failures: StateSaveFailure[] = serialized.flatMap((s, i) => (s.status === "rejected" ? [{ part: parts[i]!, error: describeFailure(s.reason) }] : []));
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

  return {
    network,
    addresses,
    async waitForSync(timeoutMs = 600_000) {
      await synced(timeoutMs);
    },
    async progress() {
      const s = await firstValueFrom(facade.state());
      const indexed = (p: { appliedIndex: bigint; highestIndex: bigint; isConnected: boolean }) => ({ applied: p.appliedIndex, highest: p.highestIndex, connected: p.isConnected });
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
      const recipe = await facade.registerNightUtxosForDustGeneration(
        unregistered,
        secrets.night.getPublicKey(),
        (payload) => secrets.night.signData(payload),
        receiver,
      );
      const tx = await facade.finalizeRecipe(recipe);
      await submit(tx);
      return tx.transactionHash();
    },
    async payFee(tx, ttl) {
      const recipe = await facade.balanceUnboundTransaction(tx, keys, { ttl, tokenKindsToBalance: ["dust"] });
      return facade.finalizeRecipe(recipe);
    },
    submit,
    discard: (tx) => facade.revert(tx),
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
