// Shared terminal, chain, wallet and authorization gates for the mainnet tools.
import { homedir } from "node:os";
import { midnightSource, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import {
  assertChainIdentity,
  authorizationIntent,
  intentDigest,
  assertPreauthorizedBytes,
  mainnetBroadcast,
  broadcast,
  assertHumanTerminal,
  confirmOnTerminal,
  confirmationToken,
  formatDust,
  readJsonFile,
  networkEndpoints,
  openWallet,
  type ChainFacts,
  type OperatorWallet,
  type PreparedAnchor,
  type PreparedDeploy,
  type AnchorPlan,
} from "../src/index.js";

export const home = homedir();
// Where the FPS mainnet keys and the deploy wallet's mnemonic live.
export const SECRETS = `${home}/.secrets/orynq-midnight-mainnet`;
// Where the mainnet scripts keep their journals and results: deploy-mainnet journals the deploy at
// DEPLOY_JOURNAL, where anchor-mainnet reads which registry FPS deployed.
export const STATE = `${home}/.local/state/orynq-midnight`;
export const DEPLOY_JOURNAL = `${STATE}/mainnet-deploy.sqlite`;

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

  type Flag = F | "mnemonic" | "wallet-record" | "blockfrost" | "zk" | "dust-floor" | "max-fee-dust";
  const defaults: Record<string, string | undefined> = {
    mnemonic: `${SECRETS}/mnemonic.txt`,
    "wallet-record": `${home}/work/orynq-midnight-mainnet-wallet.json`,
    blockfrost: `${home}/.secrets/blockfrost-midnight-mainnet.project_id`,
    zk: process.env.MIDNIGHT_PP ?? `${home}/.cache/orynq-midnight/zk`,
    "dust-floor": "20",
    "max-fee-dust": "1",
    ...flags,
  };
  const given = new Map<string, string>();
  const argv = process.argv.slice(2);
  let preauthorize = false;
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i]!, argv[i + 1]];
    if (!flag.startsWith("--")) fail(`unexpected argument ${flag}`);
    const name = flag.slice(2);
    if (name === "pre-authorize") {
      if (preauthorize) fail("--pre-authorize is given twice");
      preauthorize = true;
      i--;
      continue;
    }
    if (!Object.hasOwn(defaults, name)) fail(`unknown flag ${flag}`);
    if (value === undefined) fail(`${flag} needs a value`);
    if (value!.startsWith("--")) fail(`${flag} needs a value, not the flag ${value}`);
    if (given.has(name)) fail(`${flag} is given twice`);
    given.set(name, value!);
  }
  for (const [flag, fallback] of Object.entries(defaults)) if (fallback === undefined && !given.has(flag)) fail(`--${flag} is required`);
  const option = (flag: Flag): string => given.get(flag) ?? defaults[flag]!;
  const floorText = DUST.exec(option("dust-floor"));
  if (!floorText) fail(`--dust-floor takes DUST as a decimal number with at most 15 places, not ${option("dust-floor")}`);
  const floor = BigInt(floorText![1]!) * 10n ** 15n + BigInt((floorText![2] ?? "").padEnd(15, "0"));
  const capText = DUST.exec(option("max-fee-dust"));
  if (!capText) fail("--max-fee-dust takes DUST as a decimal number with at most 15 places");
  const cap = BigInt(capText![1]!) * 10n ** 15n + BigInt((capText![2] ?? "").padEnd(15, "0"));
  let authorization: { digest: string; at: string; payer: string; plan?: { path: string; value: AnchorPlan } } | undefined;
  let active: Mainnet | undefined;

  return {
    option,
    async authorize(plan?: { path: string; value: AnchorPlan }) {
      if (!preauthorize) return;
      const payer = (readJsonFile(option("wallet-record")) as { addresses: { unshielded: string } }).addresses.unshielded;
      if (typeof payer !== "string" || !/^mn_addr1[a-z0-9]+$/.test(payer)) throw new Error("invalid recorded unshielded payer");
      const intent = authorizationIntent(payer, cap, plan);
      const digest = intentDigest(intent);
      process.stdout.write(`\nMainnet intent (fee cap ${formatDust(cap)} DUST per transaction):\n${JSON.stringify(intent, null, 2)}\nintent sha256 ${digest}\n`);
      const token = `PREAUTHORIZE ${noun === "deploy" ? "DEPLOY" : "ANCHORS"} ${digest.slice(0, 16)}`;
      if (!(await confirmOnTerminal({ input: process.stdin, output: process.stdout, token, what: `the mainnet ${noun} intent`, exact: true }))) throw new Error("not pre-authorized; nothing was sent");
      authorization = { digest, at: new Date().toISOString(), payer, ...(plan ? { plan } : {}) };
    },

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
          active = {
            source,
            chain,
            async syncWallet() {
              const expectedAddresses = (readJsonFile(option("wallet-record")) as { addresses: { unshielded: string; shielded: string; dust: string } }).addresses;
              process.stdout.write(`${chain.chain}, runtime ${chain.specVersion}, ledger ${chain.ledgerVersion}. Syncing the wallet...\n`);
              const wallet = await openWallet({
                network: "mainnet", mnemonicFile: option("mnemonic"), endpoints, source, zkDir: option("zk"), expectedAddresses,
                broadcast: (tx) => mainnetBroadcast(tx.serialize(), (bytes) => broadcast(source, bytes), Math.min(...[...(tx.intents?.values() ?? [])].map((intent) => intent.ttl.getTime()))),
              });
              opened.push(wallet);
              await wallet.waitForSync(3_600_000);
              return wallet;
            },
          };
          return active;
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
      if (preauthorize) {
        try {
          if (!authorization || !active) throw new Error("missing pre-authorization; nothing was sent");
          const { payer, plan, digest, at } = authorization;
          if (intentDigest(authorizationIntent(payer, cap, plan)) !== digest) throw new Error("pre-authorized intent changed; nothing was sent");
          assertPreauthorizedBytes(prepared, payer, cap, noun === "deploy");
          await assertChainIdentity(active.source, "mainnet");
          process.stdout.write(`pre-authorized at ${at} for intent ${digest}\n`);
          return;
        } catch (error) {
          if (!prepared.journal) await discard();
          throw error;
        }
      }
      if (await confirmOnTerminal({ input: process.stdin, output: process.stdout, token: confirmationToken(prepared), what })) return;
      if (prepared.journal) throw new Error(`not confirmed; nothing was sent, and the journalled ${noun} stays in the journal`);
      await discard();
      throw new Error("not confirmed; the prepared bytes were discarded and nothing was sent");
    },
  };
}
