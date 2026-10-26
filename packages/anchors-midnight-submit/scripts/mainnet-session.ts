// What deploy-mainnet and anchor-mainnet share. Before anything is read, the process must carry no
// Claude Code or Codex environment and its input and output must be a terminal; then the flags, every one
// of them known; then a node that is Midnight Mainnet, the wallet the mnemonic derives only if it
// is the recorded one, and the DUST floor before preparing new bytes. The wallet syncs from
// the state file both scripts share, saving it as it goes, so a sync that fails or runs out of time
// is resumed by the next run. Each set of final bytes is sent only after the token naming its
// transaction hash is typed at that terminal, and every way out closes the wallet before the
// process exits.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { midnightSource, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import {
  assertChainIdentity,
  assertHumanTerminal,
  confirmOnTerminal,
  confirmationToken,
  ensurePrivateDir,
  formatDust,
  parseDust,
  readJsonFile,
  networkEndpoints,
  openWallet,
  syncWithCheckpoints,
  type ChainFacts,
  type OperatorWallet,
  type PreparedAnchor,
  type PreparedDeploy,
} from "../src/index.js";

// Provider errors and flags are untrusted terminal text. Keep diagnostics on one physical
// line so they cannot manufacture a confirmation summary/prompt in a driving PTY.
export function terminalDiagnostic(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, character => {
    const common: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };
    return common[character] ?? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

// Capture before announcing: a slow or blocked terminal write consumes the same timeout.
export function deadlineBeforeAnnouncement(timeoutMillis: number, announce: () => void, now = Date.now): number {
  const until = now() + timeoutMillis;
  announce();
  return until;
}

export const home = homedir();
// Where the FPS mainnet keys and the deploy wallet's mnemonic live.
export const SECRETS = `${home}/.secrets/orynq-midnight-mainnet`;
// Where the mainnet scripts keep their journals, results and wallet state: deploy-mainnet journals
// the deploy at DEPLOY_JOURNAL, where anchor-mainnet reads which registry FPS deployed, and
// anchor-mainnet its anchors at ANCHORS_JOURNAL.
export const STATE = `${home}/.local/state/orynq-midnight`;
export const DEPLOY_JOURNAL = `${STATE}/mainnet-deploy.sqlite`;
export const ANCHORS_JOURNAL = `${STATE}/mainnet-anchors.sqlite`;

const MINUTE = 60_000;
// A from-genesis sync of the mainnet wallet can take more than an hour.
const SYNC_TIMEOUT_MS = 180 * MINUTE;

export interface Mainnet {
  source: MidnightSource;
  chain: ChainFacts;
  // Opens the wallet the mnemonic derives, refusing one that is not the recorded wallet, and
  // waits until it has synced, resuming from and saving to the shared wallet state file.
  syncWallet(): Promise<OperatorWallet>;
}

// The script `name` sends `a mainnet ${noun}`, which deci `does` himself at his own terminal.
// `flags` are its own flags with their defaults beside the shared ones; one without a default is
// required.
export function mainnetScript<F extends string>({ name, noun, does, flags }: { name: string; noun: "deploy" | "anchor"; does: string; flags: Record<F, string | undefined> }) {
  const fail = (message: string): never => {
    process.stderr.write(`${name}: ${terminalDiagnostic(message)}\n`);
    process.exit(1);
  };
  const what = `a mainnet ${noun}`;
  try {
    assertHumanTerminal({ input: process.stdin, output: process.stdout, does, what });
  } catch (error) {
    fail((error as Error).message);
  }

  type Flag = F | "mnemonic" | "wallet-record" | "wallet-state" | "blockfrost" | "zk" | "dust-floor";
  const defaults: Record<string, string | undefined> = {
    mnemonic: `${SECRETS}/mnemonic.txt`,
    "wallet-record": `${home}/work/orynq-midnight-mainnet-wallet.json`,
    "wallet-state": `${STATE}/mainnet-wallet.state.json`,
    blockfrost: `${home}/.secrets/blockfrost-midnight-mainnet.project_id`,
    zk: process.env.MIDNIGHT_PP ?? `${home}/.cache/orynq-midnight/zk`,
    "dust-floor": "20",
    ...flags,
  };
  const given = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i]!, argv[i + 1]];
    if (!flag.startsWith("--")) fail(`unexpected argument ${flag}`);
    const name = flag.slice(2);
    if (!Object.hasOwn(defaults, name)) fail(`unknown flag ${flag}`);
    if (value === undefined) fail(`${flag} needs a value`);
    if (value!.startsWith("--")) fail(`${flag} needs a value, not the flag ${value}`);
    if (given.has(name)) fail(`${flag} is given twice`);
    given.set(name, value!);
  }
  for (const [flag, fallback] of Object.entries(defaults)) if (fallback === undefined && !given.has(flag)) fail(`--${flag} is required`);
  const option = (flag: Flag): string => given.get(flag) ?? defaults[flag]!;
  const floor = parseDust(option("dust-floor")) ?? fail(`--dust-floor takes DUST as a decimal number with at most 15 places, not ${option("dust-floor")}`);

  return {
    option,

    // Runs `body`, which connects to mainnet when it is ready to, closes whatever wallet it synced
    // on every way out, and exits: 0 once `body` returned and every wallet closed, 1 with `body`'s
    // error followed by any wallet's failure to close. Every refusal in `body` throws, since
    // exiting from inside it would leave what it opened open.
    async run(body: (connect: () => Promise<Mainnet>) => Promise<void>): Promise<never> {
      const opened: OperatorWallet[] = [];
      const failures: string[] = [];
      try {
        await body(async () => {
          const endpoints = networkEndpoints("mainnet", { blockfrostProjectIdFile: option("blockfrost") });
          const source = midnightSource(endpoints);
          const chain = await assertChainIdentity(source, "mainnet");
          return {
            source,
            chain,
            async syncWallet() {
              const expectedAddresses = (readJsonFile(option("wallet-record")) as { addresses: { unshielded: string; shielded: string; dust: string } }).addresses;
              const stateFile = option("wallet-state");
              mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
              ensurePrivateDir(dirname(stateFile));
              process.stdout.write(`${chain.chain}, runtime ${chain.specVersion}, ledger ${chain.ledgerVersion}. Syncing the wallet...\n`);
              const wallet = await openWallet({ network: "mainnet", mnemonicFile: option("mnemonic"), endpoints, source, zkDir: option("zk"), expectedAddresses, stateFile });
              opened.push(wallet);
              await syncWithCheckpoints(wallet, { timeoutMs: SYNC_TIMEOUT_MS, progressMs: MINUTE, checkpointMs: 5 * MINUTE, write: (line) => process.stdout.write(`${line}\n`) });
              return wallet;
            },
          };
        });
      } catch (error) {
        failures.push((error as Error).message);
      }
      for (const wallet of opened) {
        try {
          await wallet.close();
        } catch (error) {
          failures.push(`closing the wallet failed: ${(error as Error).message}`);
        }
      }
      if (failures.length > 0) fail(failures.join("; "));
      process.exit(0);
    },

    // Journalled bytes already carry their fee, whose held coin is excluded from this balance.
    requireDustFloor(dust: bigint, resumed: PreparedDeploy | PreparedAnchor | null) {
      if (!resumed?.journal && dust < floor) throw new Error(`the wallet holds ${formatDust(dust)} DUST, below the ${formatDust(floor)} DUST floor in available coins; DUST held by journalled bytes becomes available after the wallet syncs past the spend's ctime plus the ledger DUST grace period (3 hours on mainnet), if the coin remains unspent`);
    },

    // Shows `summary` and returns only once the token of `prepared` is typed at the terminal.
    // Anything else sends nothing: new bytes are discarded, while journalled ones keep their DUST,
    // since they may already be with the node.
    async confirm(prepared: PreparedDeploy | PreparedAnchor, summary: string, discard: () => Promise<void>) {
      process.stdout.write(`\n${summary}\n`);
      if (await confirmOnTerminal({ input: process.stdin, output: process.stdout, token: confirmationToken(prepared), what })) return;
      if (prepared.journal) throw new Error(`not confirmed; nothing was sent, and the journalled ${noun} stays in the journal`);
      await discard();
      throw new Error("not confirmed; the prepared bytes were discarded and nothing was sent");
    },
  };
}
