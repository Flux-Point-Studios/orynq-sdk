import { createInterface } from "node:readline";
import { REGISTRY_CIRCUITS, type MidnightNetwork, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { agentDriven } from "./custody.js";
import type { PreparedDeploy } from "./deployer.js";
import type { PreparedAnchor } from "./operator.js";
import { assertKnownRuntime, type PreparedBytes } from "./submission.js";

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

// What the human confirms of any final bytes, around the rows that say what they do: bytes
// resumed from the journal say so first, with what confirming then does with them, `noun` naming
// what they are. The DUST balance is this run's wallet's; the payer is the wallet whose DUST paid
// the bytes.
function bytesSummary({ chain, wallet, dust, prepared, noun }: { chain: ChainFacts; wallet: { dust: string }; dust: bigint; prepared: PreparedBytes; noun: string }, rows: string[]): string {
  const { journal } = prepared;
  const resumed =
    journal &&
    (journal.state === "landed"
      ? `these bytes landed; confirming sends nothing and reads the ${noun} back`
      : journal.expired
        ? `these bytes expired at ${prepared.ttl.toISOString()} and the chain does not show them landed; confirming sends nothing and waits until the chain lands or retires them`
        : journal.broadcasts > 0
          ? `these bytes were sent ${journal.broadcasts} time${journal.broadcasts === 1 ? "" : "s"} and have not landed; confirming waits for them and sends nothing new`
          : "no send of these bytes ever returned; confirming sends them again");
  return [
    ...(resumed ? [`journal          resumed: ${resumed}`] : []),
    `network          ${prepared.network} (${chain.chain}, genesis ${chain.genesis})`,
    `runtime          ${chain.specVersion}, ledger ${chain.ledgerVersion}`,
    ...rows,
    `fee (declared)   ${formatDust(prepared.declaredFee)} DUST, all of it burned`,
    `DUST balance     ${formatDust(dust)} DUST at ${wallet.dust}`,
    `paid from        ${prepared.payer ?? "a wallet the journal did not record"}`,
    `valid until      ${prepared.ttl.toISOString()}`,
    `final bytes      ${prepared.bytes.length}`,
  ].join("\n");
}

type SummaryOf<P> = { chain: ChainFacts; wallet: { dust: string }; dust: bigint; prepared: P };

// What the human confirms of a registry deploy: its address, transaction, verifier keys and
// maintenance authority.
export function deploySummary({ prepared, ...facts }: SummaryOf<PreparedDeploy>): string {
  const { authority } = prepared;
  return bytesSummary({ ...facts, prepared, noun: "deploy" }, [
    `contract address ${prepared.address}`,
    `deploy tx hash   ${prepared.txHash}`,
    ...REGISTRY_CIRCUITS.map((name) => `${name.padEnd(16)} vk sha256 ${prepared.verifierKeys[name]}`),
    `authority        committee [] (${authority.committee} members), threshold ${authority.threshold}, counter ${authority.counter}: no maintenance update can ever apply`,
  ]);
}

const KIND = { 1: "1: anchor(), a public commitment to the entry", 2: "2: anchor_hiding(), a hiding commitment the attribute is bound to" } as const;

// What the human confirms of an anchor: its plan label, what it writes to which registry, under
// which author key, and its transaction. A kind-2 anchor shows the attribute it publishes; nothing
// that opens its commitment is shown.
export function anchorSummary({ prepared, label, ...facts }: SummaryOf<PreparedAnchor> & { label: string }): string {
  return bytesSummary({ ...facts, prepared, noun: "anchor" }, [
    `label            ${label}`,
    `kind             ${KIND[prepared.kind]}`,
    `registry         ${prepared.registry}`,
    `commitment       ${prepared.commitment}`,
    ...(prepared.kind === 2 ? [`attribute        ${prepared.attribute}`] : []),
    `author key       ${prepared.author}`,
    `anchor tx hash   ${prepared.txHash}`,
  ]);
}

// Binds the confirmation to these exact final bytes, and says what they are: a token typed for
// other bytes never matches.
export const confirmationToken = (prepared: PreparedDeploy | PreparedAnchor) => `${"kind" in prepared ? "ANCHOR" : "DEPLOY"} ${prepared.txHash.slice(0, 16)}`;

// Refuses unless `input` and `output` are an interactive terminal in a process without Claude
// Code's environment: what deci `does` himself there, and what a pipe or a file cannot confirm.
// A process running as deci that drives a pseudo-terminal passes, so this guards against
// accidents, not against code with deci's privileges.
export function assertHumanTerminal({
  input,
  output,
  env = process.env,
  does,
  what,
}: {
  input: { isTTY?: boolean };
  output: { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
  does: string;
  what: string;
}): void {
  if (agentDriven(env)) throw new Error(`this process carries Claude Code's environment; deci ${does} himself, at his own terminal`);
  if (!input.isTTY || !output.isTTY) throw new Error(`needs deci at an interactive terminal; a pipe or a file cannot confirm ${what}`);
}

// Asks the human at the terminal to type `token` to confirm `what`. Only an interactive terminal,
// in a process without Claude Code's environment, may confirm (assertHumanTerminal): a flag, a
// pipe, a file or an environment variable never can.
export async function confirmOnTerminal({
  input,
  output,
  token,
  env = process.env,
  what = "a mainnet deploy",
}: {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream & { isTTY?: boolean };
  token: string;
  env?: NodeJS.ProcessEnv;
  what?: string;
}): Promise<boolean> {
  assertHumanTerminal({ input, output, env, does: `confirms ${what}`, what });
  const lines = createInterface({ input, output, terminal: false });
  output.write(`\nType exactly "${token}" to confirm these bytes for mainnet, anything else to send nothing: `);
  try {
    for await (const line of lines) return line.trim() === token;
    return false;
  } finally {
    lines.close();
  }
}
