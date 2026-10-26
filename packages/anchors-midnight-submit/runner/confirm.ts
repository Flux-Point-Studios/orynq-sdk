// What an unattended confirmation of a mainnet tool's prompt rests on: the intent deci approved,
// in the shape the terminal wrappers have shown him since 2026-10-16, checked fact by fact against
// the summary deploy-mainnet or anchor-mainnet prints for the final bytes, and the pseudo-terminal
// that runs the reviewed tool and types its token only when every fact matches. The runner
// confirms through this module, and the terminal wrappers can call it in place of their own
// checks (README.md).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { entryCommitment, hash32 } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { readAnchorPlan, type AnchorPlan } from "../src/anchor-plan.js";
import { parseDust } from "../src/preflight.js";
import { LIMITS } from "./limits.js";
import { PromptSegments, summaryBlock } from "./output.js";

export interface DeployIntent {
  action: string;
  network: string;
  authority: string;
  verifierKeys: Record<string, string>;
  payer: string;
  maxFeeDust: string;
}

export interface IntentEntry {
  label: string;
  kind: 1 | 2;
  rootHash: string;
  manifestHash: string;
  merkleRoot: string;
  attribute?: string;
}

export interface AnchorsIntent {
  action: string;
  network: string;
  plan: string;
  planSha256: string;
  registry: string;
  entries: IntentEntry[];
  authorKeys: string[];
  payer: string;
  maxFeeDustPerAnchor: string;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

// An intent's identity: the sha256 of its compact JSON, keys in the order written. Its first 8
// hex characters are the id deci approves it by.
export const intentSha256 = (intent: DeployIntent | AnchorsIntent) => sha256(JSON.stringify(intent));

export function deployIntent(payer: string, maxFeeDust: string): DeployIntent {
  const { action, authority, verifierKeys } = LIMITS.deploy;
  return { action, network: LIMITS.network, authority, verifierKeys, payer, maxFeeDust };
}

// The plan's entries as an intent lists them: each hash as the plan writes it, a missing Merkle
// root as 32 zero bytes.
export const intentEntries = (plan: AnchorPlan): IntentEntry[] =>
  plan.entries.map((e) => {
    if (e.kind === 3) throw new Error("Batch plans require a standing intent, not a legacy per-intent approval");
    return {
      label: e.label,
      kind: e.kind,
      rootHash: String(e.entry.rootHash),
      manifestHash: String(e.entry.manifestHash),
      merkleRoot: e.entry.merkleRoot === undefined ? "00".repeat(32) : String(e.entry.merkleRoot),
      ...(e.kind === 2 ? { attribute: String(e.attribute) } : {}),
    };
  });

// The instant an ISO 8601 time names, or NaN unless it ends in Z or a ±hh:mm offset: Date.parse
// reads a time without one in the process's time zone, so the instant would move with TZ.
export const instant = (time: unknown) => (typeof time === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(time) ? Date.parse(time) : NaN);

// The registry of an anchors intent authorized before the deploy landed: the one deploy-mainnet's
// journal at `deployJournal` holds landed, written into the plan at `planOut`.
export const afterDeployRegistry = (deployJournal: string, planOut: string) => `the registry ${deployJournal} records as landed and read back, written into ${planOut} by fill-registry.mjs`;

export function anchorsIntent({ plan, registry, payer, maxFeeDustPerAnchor }: { plan: string; registry: string; payer: string; maxFeeDustPerAnchor: string }): AnchorsIntent {
  return {
    action: LIMITS.anchors.action,
    network: LIMITS.network,
    plan,
    planSha256: sha256(readFileSync(plan)),
    registry,
    entries: intentEntries(readAnchorPlan(plan)),
    authorKeys: LIMITS.anchors.authorKeys,
    payer,
    maxFeeDustPerAnchor,
  };
}

// What a summary check finds: the transaction (the deploy, or an anchor's label) it is about, the
// transaction hash and declared fee it shows, and every fact that does not match the intent.
export interface Decision {
  item?: string;
  problems: string[];
  txHash?: string;
  fee?: bigint;
  validUntil?: string;
}

// The value of the summary row `label`: the text after its column, from the row's last occurrence.
const rows = (summary: string) => (label: string) =>
  summary
    .split("\n")
    .reverse()
    .find((line) => line.startsWith(`${label} `))
    ?.slice(label.length)
    .trim();
const shown = (value: string | undefined) => `"${value ?? "(none)"}"`;
const hex32 = (value: string) => Buffer.from(hash32(value, "hash")).toString("hex");

const networkProblems = (row: ReturnType<typeof rows>, network: string) => (row("network") === network ? [] : [`network is ${shown(row("network"))}`]);

// What every summary shows after the rows of what the bytes do: the paying wallet, the fee
// against the cap, and the transaction the token must name.
function paymentProblems(row: ReturnType<typeof rows>, payer: string, maxFeeDust: string, txRow: string, token: string) {
  const problems: string[] = [];
  if (row("paid from") !== payer) problems.push(`payer is ${shown(row("paid from"))}`);
  const fee = parseDust(/^(\S+) DUST/.exec(row("fee (declared)") ?? "")?.[1] ?? "");
  if (fee === null || fee > parseDust(maxFeeDust)!) problems.push(`fee is ${shown(row("fee (declared)"))}, cap ${maxFeeDust} DUST`);
  const validUntil = row("valid until");
  if (Number.isNaN(instant(validUntil))) problems.push(`valid until is ${shown(validUntil)}`);
  const txHash = row(txRow);
  if (!txHash || !/^[0-9a-f]{64}$/.test(txHash) || !txHash.startsWith(token)) problems.push(`the token ${token} does not name the summarized transaction ${txHash ?? "(none)"}`);
  return { problems, ...(txHash ? { txHash } : {}), ...(fee === null ? {} : { fee }), ...(validUntil ? { validUntil } : {}) };
}

// Checks the summary deploy-mainnet printed before asking for the DEPLOY token `token` (its 16 hex
// characters) against the deploy intent.
export function checkDeploySummary(intent: DeployIntent, summary: string, token: string): Decision {
  const row = rows(summary);
  const problems = networkProblems(row, intent.network);
  if (!row("authority")?.startsWith(`${intent.authority}:`)) problems.push(`authority is ${shown(row("authority"))}`);
  for (const [circuit, vk] of Object.entries(intent.verifierKeys)) {
    if (row(circuit.padEnd(16)) !== `vk sha256 ${vk}`) problems.push(`${circuit} verifier key is ${shown(row(circuit.padEnd(16)))}`);
  }
  const payment = paymentProblems(row, intent.payer, intent.maxFeeDust, "deploy tx hash", token);
  return { ...payment, item: "deploy", problems: [...problems, ...payment.problems] };
}

// Checks the summary anchor-mainnet printed before asking for the ANCHOR token `token` against the
// anchors intent and the registry its plan names: the label must be a planned entry's, and the
// summary must show that entry's kind and hashes (kind 1), its commitment as the entry derives it
// (kind 1), or its attribute (kind 2, whose commitment only the salt key derives).
export function checkAnchorSummary(intent: AnchorsIntent, registry: string, summary: string, token: string): Decision {
  const row = rows(summary);
  const label = row("label");
  const entry = intent.entries.find((e) => e.label === label);
  if (!entry) return { ...(label ? { item: label } : {}), problems: [`label ${shown(label)} is not in the authorized plan`] };
  const problems = networkProblems(row, intent.network);
  if (row("registry") !== registry) problems.push(`registry is ${shown(row("registry"))}`);
  if (!row("kind")?.startsWith(`${entry.kind}:`)) problems.push(`kind is ${shown(row("kind"))}, the plan says ${entry.kind}`);
  if (entry.kind === 1) {
    for (const [name, value] of [
      ["root hash", entry.rootHash],
      ["manifest hash", entry.manifestHash],
      ["merkle root", entry.merkleRoot],
    ] as const) {
      if (row(name) !== hex32(value)) problems.push(`${name} is ${shown(row(name))}`);
    }
    const derived = Buffer.from(entryCommitment(entry)).toString("hex");
    if (row("commitment") !== derived) problems.push(`commitment is ${shown(row("commitment"))}, the plan's entry derives ${derived}`);
  } else if (row("attribute") !== hex32(entry.attribute!)) problems.push(`attribute is ${shown(row("attribute"))}`);
  if (!intent.authorKeys.includes(row("author key") ?? "")) problems.push(`author key is ${shown(row("author key"))}`);
  const payment = paymentProblems(row, intent.payer, intent.maxFeeDustPerAnchor, "anchor tx hash", token);
  return { ...payment, item: entry.label, problems: [...problems, ...payment.problems] };
}

const quoted = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

export interface Answer {
  token: string;
  confirmed: boolean;
  problems: string[];
}

// Runs `command` in `cwd` under util-linux script, so the tool's input and output are a terminal,
// and answers each of its prompts: the token when `decide`, given the output since the previous
// prompt and the token's 16 hex characters, finds no problem, and "NO", which sends nothing,
// otherwise or when the prompt is for another `verb`. `onNo` sees each NO's decision before the
// tool is sent it; `onText` sees the output as it arrives. The exit code is the tool's, as the
// shell reports it on descriptor 3 once the tool exits, or null when nothing reported it: script
// exits 0 when a signal ends it, having killed the shell and the tool, so its own exit code
// cannot say that the tool finished. The tool runs with descriptor 3 closed, so it cannot report.
export function driveTool({
  command,
  cwd,
  env,
  verb,
  decide,
  onNo = () => undefined,
  onText = () => undefined,
}: {
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  verb: "DEPLOY" | "ANCHOR";
  decide: (summary: string, token: string) => Decision;
  onNo?: (decision: Decision) => void;
  onText?: (text: string) => void;
}) {
  const child = spawn("script", ["-qfc", `${command.map(quoted).join(" ")} 3>&-; printf %d $? >&3`, "/dev/null"], { cwd, env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const answers: Answer[] = [];
  const segments = new PromptSegments();
  let reported = "";
  child.stdio[3]!.on("data", (chunk: Buffer) => void (reported = (reported + chunk.toString("utf8")).slice(0, 16)));
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").replaceAll("\r", "");
    onText(text);
    for (const segment of segments.push(text)) {
      const { verb: kind, token: hex } = segment;
      const block = summaryBlock(segment);
      const decision = answers.length >= 128
        ? { problems: ["too many confirmation prompts in one attempt"] }
        : kind !== verb
          ? { problems: [`the tool asks for "${kind} ${hex}", not ${verb === "ANCHOR" ? "an" : "a"} ${verb} token`] }
          : block.problem ? { problems: [block.problem] } : decide(block.summary, hex);
      const confirmed = decision.problems.length === 0;
      if (!confirmed) onNo(decision);
      if (answers.length < 128) answers.push({ token: `${kind} ${hex}`, confirmed, problems: decision.problems });
      child.stdin.write(confirmed ? `${kind} ${hex}\n` : "NO\n");
      if (answers.length >= 128) { child.kill("SIGTERM"); break; }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => onText(chunk.toString("utf8")));
  // A tool that exits as an answer is written leaves it unread; its exit says what happened.
  child.stdin.on("error", (error) => onText(`\nthe answer did not reach the tool: ${error.message}\n`));
  const exited = new Promise<{ code: number | null; answers: Answer[] }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve({ code: /^\d+$/.test(reported) ? Number(reported) : null, answers }));
  });
  return { exited, stop: () => void child.kill("SIGTERM") };
}
