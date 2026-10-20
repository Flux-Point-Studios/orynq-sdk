// A stand-in for deploy-mainnet and anchor-mainnet that prints their exact summaries and prompts
// (deploySummary, anchorSummary, confirmOnTerminal) for bytes it makes up, so a test can change
// any fact the runner checks. FAKE_TOOL (JSON) says how: `kind`, the facts to change, how many
// runs fail their wallet sync first or fail after a confirmation (counted in the file `runs`),
// how long each run takes to sync and to read a confirmed transaction back, and the file
// `record`, to which every run appends a line per prompt with what was typed.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { entryCommitment } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { readAnchorPlan } from "../../src/anchor-plan.js";
import type { PreparedDeploy } from "../../src/deployer.js";
import type { PreparedAnchor } from "../../src/operator.js";
import { NETWORK_IDENTITY, anchorSummary, confirmOnTerminal, confirmationToken, deploySummary, type ChainFacts } from "../../src/preflight.js";
import type { PreparedBytes } from "../../src/submission.js";

export interface FakeTool {
  kind: "deploy" | "anchor";
  runs: string;
  record: string;
  syncFailures?: number;
  failsAfterConfirm?: number;
  syncMs?: number;
  afterConfirmMs?: number;
  // Facts every summary shows.
  chain?: Partial<ChainFacts>;
  payer?: string;
  fee?: string;
  // The deploy's transaction in each run, the last one for every run after.
  txHashes?: string[];
  journal?: PreparedBytes["journal"];
  // A deploy's own facts.
  committee?: number;
  verifierKeys?: Record<string, string>;
  // Each anchor's own facts, by label.
  anchors?: Record<string, Partial<Pick<PreparedAnchor, "registry" | "author" | "kind" | "commitment" | "attribute" | "txHash">> & { rootHash?: string }>;
}

const fake: FakeTool = JSON.parse(process.env.FAKE_TOOL!);
const name = fake.kind === "deploy" ? "deploy-mainnet" : "anchor-mainnet";
const run = existsSync(fake.runs) ? Number(readFileSync(fake.runs, "utf8")) + 1 : 1;
writeFileSync(fake.runs, String(run));
const chain: ChainFacts = { ...NETWORK_IDENTITY.mainnet, specVersion: 1000300, ledgerVersion: "8.1.1", ...fake.chain };
process.stdout.write(`${chain.chain}, runtime ${chain.specVersion}, ledger ${chain.ledgerVersion}. Syncing the wallet...\n`);
await new Promise((resolve) => setTimeout(resolve, fake.syncMs ?? 0));
if (run <= (fake.syncFailures ?? 0)) {
  process.stderr.write(`${name}: the mainnet wallet did not sync within 10800 s; its sync state is saved, and a rerun resumes from it\n`);
  process.exit(1);
}

const bytes: Omit<PreparedBytes, "txHash"> = {
  network: "mainnet",
  bytes: new Uint8Array(8142),
  ttl: new Date(Date.now() + 15 * 60_000),
  declaredFee: BigInt(fake.fee ?? "2"),
  payer: fake.payer ?? "mn_addr1hdg7gg557cwmd9v67jv37z38zvprt7d46xqhk7c4a7hfask6jwrs7qesvq",
  ...(fake.journal ? { journal: fake.journal } : {}),
};
const wallet = { dust: "mn_dust1fake" };
const dust = 3_931_823_675_000_000_000n;
const hex = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

// After a confirmation, a run waits `afterConfirmMs`, as a readback does; one among the first
// `failsAfterConfirm` then fails as a readback that lost the indexer does.
async function afterConfirm() {
  await new Promise((resolve) => setTimeout(resolve, fake.afterConfirmMs ?? 0));
  if (run > (fake.failsAfterConfirm ?? 0)) return;
  process.stderr.write(`${name}: offline indexer: HTTP 502: Bad Gateway\n`);
  process.exit(1);
}

// Prints `summary` and asks for the token of `prepared` as the tool does; records what was typed.
async function prompt(item: string, prepared: PreparedDeploy | PreparedAnchor, summary: string): Promise<boolean> {
  process.stdout.write(`\n${summary}\n`);
  let typed = "";
  const tap = (chunk: Buffer) => void (typed += chunk.toString("utf8"));
  process.stdin.on("data", tap);
  const confirmed = await confirmOnTerminal({ input: process.stdin, output: process.stdout, token: confirmationToken(prepared), what: `a mainnet ${fake.kind}` });
  process.stdin.off("data", tap);
  appendFileSync(fake.record, `${JSON.stringify({ run, item, typed: typed.split(/\r?\n/)[0], confirmed })}\n`);
  return confirmed;
}

if (fake.kind === "deploy") {
  const prepared: PreparedDeploy = {
    ...bytes,
    txHash: fake.txHashes?.[Math.min(run, fake.txHashes.length) - 1] ?? hex(0xaa),
    address: hex(0xcd),
    runtime: chain.specVersion,
    authority: { committee: fake.committee ?? 0, threshold: 1, counter: "0" },
    verifierKeys: { anchor: "85dc57a4269dd3aceb82867ecc6c145ef5f679c6f51767f200250e7c075777c5", anchor_hiding: "081384ce20f2a726e1dd79c0bbfbaabb0fe756ffa15ae429be4cee30b47e790f", ...fake.verifierKeys },
  };
  if (!(await prompt("deploy", prepared, deploySummary({ chain, wallet, dust, prepared })))) {
    process.stderr.write(`${name}: not confirmed; the prepared bytes were discarded and nothing was sent\n`);
    process.exit(1);
  }
  await afterConfirm();
  process.stdout.write(`\ndeployed and read back from the node: ${JSON.stringify({ network: "mainnet", address: prepared.address, txHash: prepared.txHash })}\n`);
  process.exit(0);
}

const plan = readAnchorPlan(process.argv[process.argv.indexOf("--plan") + 1]!);
let n = 0;
for (const planned of plan.entries) {
  const change = fake.anchors?.[planned.label] ?? {};
  const entry = change.rootHash ? { ...planned.entry, rootHash: change.rootHash } : planned.entry;
  const prepared: PreparedAnchor = {
    ...bytes,
    txHash: change.txHash ?? hex(0xa0 + n++),
    registry: change.registry ?? plan.registry,
    author: change.author ?? "6a140f2346ec16bc587b506e3d447f05ddcc9bdd72778bee578767571b061f08",
    kind: change.kind ?? planned.kind,
    commitment: change.commitment ?? (planned.kind === 1 ? Buffer.from(entryCommitment(entry)).toString("hex") : hex(0x99)),
    attribute: change.attribute ?? (planned.kind === 2 ? String(planned.attribute) : "00".repeat(32)),
  };
  if (!(await prompt(planned.label, prepared, anchorSummary({ entry, chain, wallet, dust, label: planned.label, prepared })))) {
    process.stderr.write(`${name}: not confirmed; the prepared bytes were discarded and nothing was sent\n`);
    process.exit(1);
  }
  await afterConfirm();
  process.stdout.write(`${planned.label}: final on the node, carrying exactly the confirmed bytes; recorded\n`);
}
process.exit(0);
