// What deploy-mainnet and anchor-mainnet share. Before anything is read, the process must carry no
// Claude Code environment and its input and output must be a terminal; then the flags, every one
// of them known; then a node that is Midnight Mainnet, the wallet the mnemonic derives only if it
// is the recorded one, and the DUST floor whenever confirming may send bytes. Each set of final
// bytes is sent only after the token naming its transaction hash is typed at that terminal, and
// every way out closes the wallet before the process exits.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { midnightSource, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import {
  assertChainIdentity,
  assertHumanTerminal,
  confirmOnTerminal,
  confirmationToken,
  formatDust,
  networkEndpoints,
  openWallet,
  type ChainFacts,
  type OperatorWallet,
  type PreparedAnchor,
  type PreparedDeploy,
} from "../src/index.js";

export const home = homedir();

export interface Mainnet {
  source: MidnightSource;
  chain: ChainFacts;
  // Opens the wallet the mnemonic derives, refusing one that is not the recorded wallet, and
  // waits until it has synced.
  syncWallet(): Promise<OperatorWallet>;
}

const DUST = /^(\d+)(?:\.(\d{1,15}))?$/;

// The script `name` sends `a mainnet ${noun}`, which deci `does` himself at his own terminal.
// `flags` are its own flags with their defaults beside the shared ones; one without a default is
// required.
export function mainnetScript<F extends string>({ name, noun, does, flags }: { name: string; noun: "deploy" | "anchor"; does: string; flags: Record<F, string | undefined> }) {
  const fail = (message: string): never => {
    process.stderr.write(`${name}: ${message}\n`);
    process.exit(1);
  };
  const what = `a mainnet ${noun}`;
  try {
    assertHumanTerminal({ input: process.stdin, output: process.stdout, does, what });
  } catch (error) {
    fail((error as Error).message);
  }

  type Flag = F | "mnemonic" | "wallet-record" | "blockfrost" | "zk" | "dust-floor";
  const defaults: Record<string, string | undefined> = {
    mnemonic: `${home}/.secrets/orynq-midnight-mainnet/mnemonic.txt`,
    "wallet-record": `${home}/work/orynq-midnight-mainnet-wallet.json`,
    blockfrost: `${home}/.secrets/blockfrost-midnight-mainnet.project_id`,
    zk: process.env.MIDNIGHT_PP ?? `${home}/.cache/orynq-midnight/zk`,
    "dust-floor": "20",
    ...flags,
  };
  const given = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]!.startsWith("--") || argv[i + 1] === undefined) fail(`unexpected argument ${argv[i]}`);
    if (!Object.hasOwn(defaults, argv[i]!.slice(2))) fail(`unknown flag ${argv[i]}`);
    given.set(argv[i]!.slice(2), argv[i + 1]!);
  }
  for (const [flag, fallback] of Object.entries(defaults)) if (fallback === undefined && !given.has(flag)) fail(`--${flag} is required`);
  const option = (flag: Flag): string => given.get(flag) ?? defaults[flag]!;
  const floorText = DUST.exec(option("dust-floor"));
  if (!floorText) fail(`--dust-floor takes DUST as a decimal number with at most 15 places, not ${option("dust-floor")}`);
  const floor = BigInt(floorText![1]!) * 10n ** 15n + BigInt((floorText![2] ?? "").padEnd(15, "0"));

  return {
    option,

    // Runs `body`, which connects to mainnet when it is ready to, closes whatever wallet it synced
    // on every way out, and exits: 0 once `body` returned, 1 with its error. Every refusal in
    // `body` throws, since exiting from inside it would leave what it opened open.
    async run(body: (connect: () => Promise<Mainnet>) => Promise<void>): Promise<never> {
      const opened: OperatorWallet[] = [];
      try {
        try {
          await body(async () => {
            const endpoints = networkEndpoints("mainnet", { blockfrostProjectIdFile: option("blockfrost") });
            const source = midnightSource(endpoints);
            const chain = await assertChainIdentity(source, "mainnet");
            return {
              source,
              chain,
              async syncWallet() {
                const expectedAddresses = (JSON.parse(readFileSync(option("wallet-record"), "utf8")) as { addresses: { unshielded: string; shielded: string; dust: string } }).addresses;
                process.stdout.write(`${chain.chain}, runtime ${chain.specVersion}, ledger ${chain.ledgerVersion}. Syncing the deploy wallet...\n`);
                const wallet = await openWallet({ network: "mainnet", mnemonicFile: option("mnemonic"), endpoints, source, zkDir: option("zk"), expectedAddresses });
                opened.push(wallet);
                await wallet.waitForSync(3_600_000);
                return wallet;
              },
            };
          });
        } finally {
          for (const wallet of opened) await wallet.close();
        }
      } catch (error) {
        fail((error as Error).message);
      }
      process.exit(0);
    },

    // Confirming sends bytes only for new ones, or journalled ones no send of which ever returned
    // and whose TTL has not passed: journalled bytes that landed are finished whatever the balance.
    requireDustFloor(dust: bigint, resumed: PreparedDeploy | PreparedAnchor | null) {
      const sends = !resumed || (resumed.journal!.state === "pending" && resumed.journal!.broadcasts === 0 && !resumed.journal!.expired);
      if (sends && dust < floor) throw new Error(`the wallet holds ${formatDust(dust)} DUST, below the ${formatDust(floor)} DUST floor`);
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
