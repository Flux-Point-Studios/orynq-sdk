/**
 * The Midnight commands of the `orynq` CLI:
 *
 *   orynq verify midnight <txHash|bundle>   read-only; prints the assurance labels
 *   orynq keys init midnight --out <file>   creates the user's own key file
 *   orynq anchor midnight ...               plans an anchor with the user's own key; a dry run
 *                                           unless --submit is confirmed at a terminal
 *
 * Anchoring takes only a user key file (orynq-midnight-user-key/v1), never a bare service key
 * file, and refuses any author key KNOWN_AUTHORS lists: those are Flux Point Studios keys.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  MIDNIGHT_REGISTRIES,
  createUserKeyFile,
  deriveSalt,
  entryCommitment,
  hash32,
  hiddenDigest,
  hidingCommitment,
  knownAuthors,
  midnightSource,
  printable,
  readUserKey,
  sourceEndpoints,
  verifyMidnightAnchor,
  verifyReport,
  type EntryHashes,
  type Expectation,
  type KnownAuthors,
  type MidnightNetwork,
  type RegistryInfo,
  type UserKey,
  type VerifyReport,
} from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { verifyBundle, type TraceBundle } from "@fluxpointstudios/orynq-sdk-process-trace";

export interface CliIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown; isTTY?: boolean };
  env: Record<string, string | undefined>;
}

// What an anchor would write: everything here is public once it is on chain.
export interface AnchorPlan {
  network: MidnightNetwork;
  registry: { generation: number; address: string } | null;
  kind: 1 | 2;
  commitment: string;
  attribute: string;
  authorKey: string;
}

export interface MidnightDeps {
  registries: Readonly<Record<MidnightNetwork, readonly RegistryInfo[]>>;
  knownAuthors: KnownAuthors;
  // Sends a confirmed anchor with the user's key and returns its transaction hash.
  submit?: (plan: AnchorPlan, key: UserKey) => Promise<{ txHash: string }>;
}

const NETWORKS: readonly MidnightNetwork[] = ["mainnet", "preprod"];
const TX_HASH = /^(0x)?[0-9a-fA-F]{64}$/;
const ZERO32 = "00".repeat(32);
const KIND_LABEL = {
  1: "1, public: the commitment binds the bundle's rootHash, manifestHash and merkleRoot",
  2: "2, hidden: the commitment hides the bundle's hashes; only the attribute (its model manifest hash) is public",
} as const;

const fail = (message: string): never => {
  throw new Error(message);
};

function parse<O extends NonNullable<ParseArgsConfig["options"]>>(args: readonly string[], options: O, positionals = false) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: positionals, strict: true });
  } catch (error) {
    return fail((error as Error).message);
  }
}

const networkOf = (value: string | undefined): MidnightNetwork =>
  (NETWORKS as readonly (string | undefined)[]).includes(value) ? (value as MidnightNetwork) : fail("--network must be mainnet or preprod");

// A trace bundle whose events, spans and model manifest hash to its own rootHash and merkleRoot.
async function readBundle(path: string): Promise<TraceBundle> {
  let bundle: TraceBundle;
  try {
    bundle = JSON.parse(readFileSync(path, "utf8")) as TraceBundle;
  } catch (error) {
    return fail(`${path} is not a trace bundle: ${(error as Error).message}`);
  }
  const intact = await verifyBundle(bundle).catch((error: Error) => ({ valid: false, errors: [error.message] }));
  if (!intact.valid) fail(`${path} is not an intact trace bundle: ${intact.errors[0]}`);
  return bundle;
}

// The entry an anchor of the bundle commits to, as the Cardano anchor of the same bundle does.
function bundleEntry(path: string, bundle: TraceBundle): EntryHashes {
  if (!bundle.manifestHash) fail(`${path} has no manifestHash: anchor a bundle once its storage manifest is created`);
  return { rootHash: bundle.rootHash, manifestHash: bundle.manifestHash!, merkleRoot: bundle.merkleRoot };
}

const bundleAttribute = (path: string, bundle: TraceBundle) =>
  bundle.modelManifestHash ?? fail(`${path} pins no model manifest, so it has no attribute for a hidden anchor`);

function writeReport(io: CliIo, report: VerifyReport, bundleGiven: boolean) {
  const row = (label: string, value: string) => io.stdout.write(`  ${label.padEnd(11)} ${value}\n`);
  io.stdout.write(`Midnight anchor ${report.txHash} on ${report.network}\n`);
  row("status", report.status);
  row("assurance", report.assurance);
  const a = report.author;
  if (a) {
    if (a.status === "expected") row("author", `expected: ${a.key} (given with --author)`);
    else if (a.status === "unknown") row("author", `unknown: ${a.key} is not in KNOWN_AUTHORS serial ${report.knownAuthorsSerial}`);
    else row("author", `${a.status}: ${a.id} (${a.role}), blocks ${a.validFrom} to ${a.validTo ?? "open"}, key ${a.key}`);
  }
  row("matched", report.verifiedFields.length ? report.verifiedFields.join(", ") : bundleGiven ? "nothing" : "nothing: no bundle was given, so the commitment is reported, not checked");
  if (report.anchor) {
    row("anchor", `${report.anchor.entryPoint}(), kind ${report.anchor.kind}`);
    row("commitment", report.anchor.commitment);
    if (report.anchor.kind === 2) row("attribute", report.anchor.attribute);
  }
  if (report.block) row("block", `${report.block.height} ${report.block.hash}`);
  if (report.registry) row("registry", `generation ${report.registry.generation} at ${report.registry.address}`);
  row("source", report.operators.join(", "));
  for (const note of report.notes) row("note", note);
  io.stdout.write("checks\n");
  const width = Math.max(...report.checks.map((c) => c.name.length));
  for (const c of report.checks) io.stdout.write(`  ${(c.ok ? "ok" : "FAIL").padEnd(5)} ${c.name.padEnd(width)}  ${c.detail}\n`);
}

async function verify(args: readonly string[], io: CliIo, deps: MidnightDeps): Promise<number> {
  const { values, positionals } = parse(
    args,
    {
      tx: { type: "string" },
      bundle: { type: "string" },
      hidden: { type: "boolean" },
      author: { type: "string" },
      network: { type: "string" },
      "blockfrost-file": { type: "string" },
      indexer: { type: "string" },
      rpc: { type: "string" },
      json: { type: "boolean" },
    },
    true,
  );
  if (positionals.length !== 1) fail("verify midnight takes one transaction hash or bundle file");
  const network = networkOf(values.network ?? "mainnet");
  const target = positionals[0]!;
  let txHash: string;
  let bundlePath = values.bundle;
  if (TX_HASH.test(target)) {
    if (values.tx !== undefined) fail("give the transaction once");
    txHash = target;
  } else {
    if (bundlePath !== undefined) fail("give the bundle once");
    if (values.tx === undefined) fail("a bundle needs --tx <hash>, the transaction that anchored it");
    bundlePath = target;
    txHash = values.tx!;
  }
  if (values.hidden && bundlePath === undefined) fail("--hidden needs a bundle");

  let expect: Expectation = { kind: "any" };
  if (bundlePath !== undefined) {
    const bundle = await readBundle(bundlePath);
    expect = values.hidden ? { kind: 2, attribute: bundleAttribute(bundlePath, bundle) } : { kind: 1, entry: bundleEntry(bundlePath, bundle) };
  }
  const custom = values.indexer !== undefined || values.rpc !== undefined;
  const endpoints = sourceEndpoints(network, {
    blockfrostProjectIdFile: values["blockfrost-file"] ?? (custom ? undefined : io.env.ORYNQ_MIDNIGHT_BLOCKFROST_FILE || undefined),
    indexer: values.indexer,
    node: values.rpc,
  });
  if (!endpoints) fail("no Midnight source: pass --blockfrost-file <project id file> (or set ORYNQ_MIDNIGHT_BLOCKFROST_FILE), or --indexer <url> and --rpc <url>");
  const result = await verifyMidnightAnchor(
    { network, txHash, expect, ...(values.author === undefined ? {} : { expectedAuthor: values.author }) },
    { source: midnightSource(endpoints!), registries: deps.registries[network], knownAuthors: deps.knownAuthors },
  );
  const report = verifyReport(result);
  if (values.json) io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else writeReport(io, report, bundlePath !== undefined);
  return report.status === "valid" ? 0 : 1;
}

function initKey(args: readonly string[], io: CliIo): number {
  const { values } = parse(args, { out: { type: "string" } });
  if (values.out === undefined) fail("--out <file> is required: where to write your new key file");
  const authorKey = createUserKeyFile(values.out!);
  io.stdout.write(`Created ${values.out}, readable only by you. It is the only way to anchor as this author: keep it, and never share it.\n`);
  io.stdout.write(`  author key  ${authorKey}\n`);
  return 0;
}

// The KNOWN_AUTHORS entry, on any network, that holds `key`.
function fpsAuthor(authors: KnownAuthors, key: string) {
  for (const network of NETWORKS) {
    const entry = authors.authors(network).find((a) => a.key === key);
    if (entry) return { ...entry, network };
  }
  return null;
}

function plan(network: MidnightNetwork, registries: readonly RegistryInfo[], key: UserKey, entry: EntryHashes, attribute: string | null): AnchorPlan {
  const newest = registries.at(-1);
  const base = { network, registry: newest ? { generation: newest.generation, address: newest.address } : null, authorKey: key.authorKey };
  if (attribute === null) return { ...base, kind: 1, commitment: Buffer.from(entryCommitment(entry)).toString("hex"), attribute: ZERO32 };
  const digest = hiddenDigest(entry, attribute);
  const commitment = hidingCommitment(digest, deriveSalt(key.saltKey, digest));
  return { ...base, kind: 2, commitment: Buffer.from(commitment).toString("hex"), attribute: Buffer.from(hash32(attribute, "attribute")).toString("hex") };
}

function writePlan(out: CliIo["stdout"], p: AnchorPlan, heading: string) {
  const row = (label: string, value: string) => out.write(`  ${label.padEnd(11)} ${value}\n`);
  out.write(`${heading}\n`);
  row("network", p.network);
  row("registry", p.registry ? `generation ${p.registry.generation} at ${p.registry.address}` : `none deployed on ${p.network}`);
  row("kind", KIND_LABEL[p.kind]);
  row("commitment", p.commitment);
  if (p.kind === 2) row("attribute", p.attribute);
  row("author key", `${p.authorKey} (your key, not in KNOWN_AUTHORS)`);
}

// One line from the terminal, or null when input ends first.
function readLine(stdin: CliIo["stdin"]): Promise<string | null> {
  const lines = createInterface({ input: stdin, terminal: false });
  return new Promise((resolve) => {
    lines.once("line", (l) => {
      resolve(l);
      lines.close();
    });
    lines.once("close", () => resolve(null));
  });
}

async function anchor(args: readonly string[], io: CliIo, deps: MidnightDeps): Promise<number> {
  const { values } = parse(args, {
    network: { type: "string" },
    key: { type: "string" },
    bundle: { type: "string" },
    hidden: { type: "boolean" },
    submit: { type: "boolean" },
    json: { type: "boolean" },
  });
  // Checked first, so a submit from a pipe (a script, or a model) never reads a key.
  if (values.submit && !(io.stdin.isTTY && io.stderr.isTTY)) fail("--submit needs a person at a terminal (stdin and stderr must both be a TTY); nothing was read or sent");
  const network = networkOf(values.network);
  if (values.key === undefined) fail("--key <file> is required: your own key file, from `orynq keys init midnight --out <file>`");
  if (values.bundle === undefined) fail("--bundle <file> is required: the trace bundle to anchor");
  let key: UserKey;
  try {
    key = readUserKey(values.key!);
  } catch (error) {
    const message = (error as Error).message;
    return fail(message.endsWith("is not a user key file (orynq-midnight-user-key/v1)") ? `${message}; create your own with \`orynq keys init midnight --out <file>\`` : message);
  }
  const fps = fpsAuthor(deps.knownAuthors, key.authorKey);
  if (fps) fail(`${values.key} holds the author key of ${fps.id} (${fps.role} on ${fps.network}), a Flux Point Studios key in KNOWN_AUTHORS: orynq anchors only with your own key`);
  const bundlePath = values.bundle!;
  const bundle = await readBundle(bundlePath);
  const entry = bundleEntry(bundlePath, bundle);
  const p = plan(network, deps.registries[network], key, entry, values.hidden ? bundleAttribute(bundlePath, bundle) : null);

  if (!values.submit) {
    if (values.json) io.stdout.write(`${JSON.stringify({ sent: false, plan: p }, null, 2)}\n`);
    else {
      writePlan(io.stdout, p, `Midnight anchor of ${bundlePath}`);
      io.stdout.write("Dry run: nothing was sent. Add --submit, at a terminal, to send it.\n");
    }
    return 0;
  }
  if (!p.registry) fail(`no registry generation is deployed on ${network}, so there is nothing to send to`);
  if (!deps.submit) fail("this build of orynq cannot send Midnight anchors: it has no submitter");
  writePlan(io.stderr, p, `Midnight anchor of ${bundlePath}`);
  io.stderr.write(`This sends the anchor above to Midnight ${network} with your own key and spends your DUST. It cannot be undone.\n`);
  io.stderr.write("Type the first 8 characters of the commitment to send it, anything else to cancel: ");
  const typed = await readLine(io.stdin);
  if (typed?.trim().toLowerCase() !== p.commitment.slice(0, 8)) {
    io.stderr.write("\nCancelled: nothing was sent.\n");
    return 1;
  }
  const { txHash } = await deps.submit!(p, key);
  if (values.json) io.stdout.write(`${JSON.stringify({ sent: true, plan: p, txHash }, null, 2)}\n`);
  else {
    io.stdout.write(`  sent        ${txHash}\n`);
    io.stdout.write(`Verify it once final: orynq verify midnight ${txHash} --bundle ${bundlePath}${p.kind === 2 ? " --hidden" : ""} --network ${network} --author ${p.authorKey}\n`);
  }
  return 0;
}

// Runs `orynq verify|keys|anchor ... midnight ...`; returns the exit code. A refusal or a bad
// request prints one line to stderr and returns 1; a verification that is not valid returns 1.
export async function midnightCommand(argv: readonly string[], io: CliIo, deps: Partial<MidnightDeps> = {}): Promise<number> {
  const full: MidnightDeps = { registries: deps.registries ?? MIDNIGHT_REGISTRIES, knownAuthors: deps.knownAuthors ?? knownAuthors(), ...(deps.submit ? { submit: deps.submit } : {}) };
  const [verb, ...rest] = argv;
  try {
    if (verb === "verify" && rest[0] === "midnight") return await verify(rest.slice(1), io, full);
    if (verb === "anchor" && rest[0] === "midnight") return await anchor(rest.slice(1), io, full);
    if (verb === "keys" && rest[0] === "init" && rest[1] === "midnight") return initKey(rest.slice(2), io);
    return fail(`unknown command: orynq ${argv.slice(0, 3).join(" ")}; run \`orynq help\``);
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) throw error;
    io.stderr.write(`error ${printable(error.message, 2000)}\n`);
    return 1;
  }
}
