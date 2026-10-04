import { createInterface } from "node:readline";
import { REGISTRY_CIRCUITS, type MidnightNetwork, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { agentDriven } from "./custody.js";
import type { PreparedDeploy } from "./deployer.js";
import { assertKnownRuntime } from "./submission.js";

// The chain each network name must be: its node's system_chain and genesis block hash.
export const NETWORK_IDENTITY: Readonly<Record<MidnightNetwork, { chain: string; genesis: string }>> = {
  mainnet: { chain: "Midnight Mainnet", genesis: "1941ca8e2bb88146c14dea084d3be7eb6e96ca7135429c543848b628124f2854" },
  preprod: { chain: "Midnight Preprod", genesis: "df831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b" },
};

export interface ChainFacts {
  chain: string;
  genesis: string;
  specVersion: number;
  ledgerVersion: string;
}

// Refuses a node that is not `network`'s chain or runs a runtime the decoder does not know, and
// returns what it read.
export async function assertChainIdentity(source: MidnightSource, network: MidnightNetwork): Promise<ChainFacts> {
  const want = NETWORK_IDENTITY[network];
  const chain = await source.node.call<string>("system_chain");
  if (chain !== want.chain) throw new Error(`the node serves ${chain}, not ${want.chain}`);
  const genesis = (await source.node.call<string>("chain_getBlockHash", [0])).replace(/^0x/, "");
  if (genesis !== want.genesis) throw new Error(`genesis ${genesis} is not ${want.chain}'s ${want.genesis}`);
  const specVersion = await assertKnownRuntime(source, network);
  const ledgerVersion = await source.node.call<string>("midnight_ledgerVersion");
  return { chain, genesis, specVersion, ledgerVersion };
}

// DUST from SPECK (10^-15 DUST), exactly, without trailing zeros.
export function formatDust(speck: bigint): string {
  const whole = speck / 10n ** 15n;
  const fraction = (speck % 10n ** 15n).toString().padStart(15, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function deploySummary({ chain, wallet, dust, prepared }: { chain: ChainFacts; wallet: { unshielded: string; dust: string }; dust: bigint; prepared: PreparedDeploy }): string {
  const { authority } = prepared;
  const rows = [
    `network          ${prepared.network} (${chain.chain}, genesis ${chain.genesis})`,
    `runtime          ${chain.specVersion}, ledger ${chain.ledgerVersion}`,
    `contract address ${prepared.address}`,
    `deploy tx hash   ${prepared.txHash}`,
    ...REGISTRY_CIRCUITS.map((name) => `${name.padEnd(16)} vk sha256 ${prepared.verifierKeys[name]}`),
    `authority        committee [] (${authority.committee} members), threshold ${authority.threshold}, counter ${authority.counter}: no maintenance update can ever apply`,
    `fee (declared)   ${formatDust(prepared.declaredFee)} DUST, all of it burned`,
    `DUST balance     ${formatDust(dust)} DUST at ${wallet.dust}`,
    `paid from        ${wallet.unshielded}`,
    `valid until      ${prepared.ttl.toISOString()}`,
    `final bytes      ${prepared.bytes.length}`,
  ];
  return rows.join("\n");
}

// Binds the confirmation to these exact final bytes: a token typed for other bytes never matches.
export const confirmationToken = (prepared: PreparedDeploy) => `DEPLOY ${prepared.txHash.slice(0, 16)}`;

// Asks the human at the terminal to type `token`. Only an interactive terminal in a process no
// agent drives may confirm: a flag, a pipe, a file or an environment variable never can.
export async function confirmOnTerminal({
  input,
  output,
  token,
  env = process.env,
}: {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream & { isTTY?: boolean };
  token: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  if (agentDriven(env)) throw new Error("an agent drives this process; only deci, at his own terminal, confirms a mainnet deploy");
  if (!input.isTTY || !output.isTTY) throw new Error("needs deci at an interactive terminal; a pipe or a file cannot confirm a mainnet deploy");
  const lines = createInterface({ input, output, terminal: false });
  output.write(`\nType exactly "${token}" to send these bytes to mainnet, anything else to discard them: `);
  try {
    for await (const line of lines) return line.trim() === token;
    return false;
  } finally {
    lines.close();
  }
}
