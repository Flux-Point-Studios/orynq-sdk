// Deploys the immutable orynq-anchor-registry on Midnight MAINNET, for deci to run at his own
// terminal. Every check fails closed and comes before anything is sent:
//   the process is not driven by an agent and talks to an interactive terminal;
//   the node is Midnight Mainnet (system_chain, genesis) on runtime 1000300;
//   the mnemonic derives exactly the recorded wallet, which holds at least the DUST floor;
//   the final, balanced bytes deploy exactly the registry's initial state (committee [],
//   threshold 1, counter 0, the pinned verifier keys).
// It then prints the exact summary and sends those bytes only after deci types the token it
// shows, which names the bytes' transaction hash. Nothing else confirms: no flag, pipe or file.
//   node --import tsx scripts/deploy-mainnet.ts [--mnemonic F] [--wallet-record F] [--blockfrost F]
//        [--zk DIR] [--journal F] [--dust-floor DUST]
import { homedir } from "node:os";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertRegistryState, blockfrostEndpoints, midnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import * as L from "@midnight-ntwrk/ledger-v8";
import { agentDriven } from "../src/custody.js";
import { registryDeployer } from "../src/deployer.js";
import { assertChainIdentity, confirmOnTerminal, confirmationToken, deploySummary, formatDust } from "../src/preflight.js";
import { openWallet } from "../src/wallet.js";
import { provingService } from "../src/zk.js";

const fail = (message: string): never => {
  process.stderr.write(`deploy-mainnet: ${message}\n`);
  process.exit(1);
};

if (agentDriven()) fail("an agent drives this process; only deci, at his own terminal, deploys to mainnet");
if (!process.stdin.isTTY || !process.stdout.isTTY) fail("needs deci at an interactive terminal; a pipe or a file cannot confirm a mainnet deploy");

const flags = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i]!.startsWith("--") || argv[i + 1] === undefined) fail(`unexpected argument ${argv[i]}`);
  flags.set(argv[i]!.slice(2), argv[i + 1]!);
}
const home = homedir();
const option = (name: string, fallback: string) => flags.get(name) ?? fallback;
const mnemonicFile = option("mnemonic", `${home}/.secrets/orynq-midnight-mainnet/mnemonic.txt`);
const walletRecord = option("wallet-record", `${home}/work/orynq-midnight-mainnet-wallet.json`);
const blockfrost = option("blockfrost", `${home}/.secrets/blockfrost-midnight-mainnet.project_id`);
const zkDir = option("zk", process.env.MIDNIGHT_PP ?? `${home}/.cache/orynq-midnight/zk`);
const journalPath = option("journal", `${home}/.local/state/orynq-midnight/mainnet-deploy.sqlite`);
const floor = BigInt(Math.round(Number(option("dust-floor", "20")) * 1e6)) * 10n ** 9n;

try {
  const endpoints = blockfrostEndpoints("mainnet", blockfrost);
  const source = midnightSource(endpoints);
  const chain = await assertChainIdentity(source, "mainnet");
  const expectedAddresses = (JSON.parse(readFileSync(walletRecord, "utf8")) as { addresses: { unshielded: string; shielded: string; dust: string } }).addresses;
  process.stdout.write(`${chain.chain}, runtime ${chain.specVersion}, ledger ${chain.ledgerVersion}. Syncing the deploy wallet...\n`);
  const wallet = await openWallet({ network: "mainnet", mnemonicFile, endpoints, source, zkDir, expectedAddresses });
  try {
    await wallet.waitForSync(3_600_000);
    const { dust } = await wallet.balances();
    if (dust < floor) fail(`the wallet holds ${formatDust(dust)} DUST, below the ${formatDust(floor)} DUST floor`);
    mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
    const deployer = registryDeployer({ network: "mainnet", wallet, source, prover: provingService(zkDir), journalPath });
    try {
      const prepared = await deployer.prepare();
      process.stdout.write(`\n${deploySummary({ chain, wallet: wallet.addresses, dust, prepared })}\n`);
      const token = confirmationToken(prepared);
      if (!(await confirmOnTerminal({ input: process.stdin, output: process.stdout, token }))) {
        await deployer.discard(prepared);
        fail("not confirmed; the prepared bytes were discarded and nothing was sent");
      }
      const deployment = await deployer.submit(prepared);
      const state = await source.node.call<string | null>("midnight_contractState", [deployment.address]);
      if (state === null) fail(`the node holds no contract at ${deployment.address}`);
      assertRegistryState(L.ContractState.deserialize(Buffer.from(state!.replace(/^0x/, ""), "hex")));
      process.stdout.write(`\ndeployed and read back from the node: ${JSON.stringify(deployment, null, 1)}\n`);
    } finally {
      deployer.close();
    }
  } finally {
    await wallet.close();
  }
  process.exit(0);
} catch (error) {
  fail((error as Error).message);
}
