// The mainnet scripts over an offline mainnet (test/offline.ts in place of the submit package),
// for the preflight suite and the runner's, which drive them in a pseudo-terminal.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as L from "@midnight-ntwrk/ledger-v8";
import { createAuthorKeyFile, createSaltKeyFile, readAuthorSecret, registryInitialState } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { registryDeployer } from "../src/deployer.js";
import { chain, fresh, hex, wallet } from "./fakes.js";
import type { OfflineChain } from "./offline.js";
import { prover } from "./prover.js";

// What a person's shell passes a script: no Claude Code or Codex environment.
export const humanEnvironment = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, MIDNIGHT_PP: process.env.MIDNIGHT_PP });
export const quoted = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;
const PROMPT = /Type exactly "((?:DEPLOY|ANCHOR) [0-9a-f]{16})"/g;
const PACKAGE = new URL("..", import.meta.url).pathname;

// `script` itself (deploy-mainnet unless named), copied with the module it shares beside a
// src/index.ts that is test/offline.ts, so it runs every gate in a pseudo-terminal and sends
// through the submit package over an offline mainnet, with the flags `flags` names beside it and
// a HOME of its own (`root`/home), where the paths no flag names default to. At
// each confirmation prompt, `answer` types its reply to the token the script asks for, and
// `watch` sees the output so far whenever more arrives.
export function offlineMainnet(script = "deploy-mainnet", flags: (root: string) => string[] = () => []) {
  const root = fresh(script);
  mkdirSync(`${root}/scripts`, { recursive: true });
  mkdirSync(`${root}/src`);
  for (const file of [`${script}.ts`, "mainnet-session.ts"]) copyFileSync(`${PACKAGE}scripts/${file}`, `${root}/scripts/${file}`);
  symlinkSync(`${PACKAGE}test/offline.ts`, `${root}/src/index.ts`);
  symlinkSync(`${PACKAGE}node_modules`, `${root}/node_modules`);
  writeFileSync(`${root}/package.json`, JSON.stringify({ type: "module" }));
  const chainFile = `${root}/chain.json`;
  writeFileSync(chainFile, JSON.stringify({ network: "mainnet", aheadMs: 0, sent: [], landed: {}, discarded: [] } satisfies OfflineChain));
  // The recorded wallet the next run opens, named `name`.
  const walletRecord = (name: string) => writeFileSync(`${root}/wallet.json`, JSON.stringify({ addresses: { unshielded: `mn_addr1${name}`, shielded: `mn_shield-addr1${name}`, dust: `mn_dust1${name}` } }));
  walletRecord("offline");
  const journalPath = `${root}/state/${script === "deploy-mainnet" ? "deploy" : "anchors"}.sqlite`;
  // The offline wallet, prover and endpoints never open the mnemonic, ZK or Blockfrost paths.
  const inputs = ["--mnemonic", "/nonexistent/mnemonic.txt", "--wallet-record", "wallet.json", "--blockfrost", "/nonexistent/blockfrost.project_id", "--zk", "/nonexistent/zk"];
  const command = [process.execPath, "--import", "tsx", `scripts/${script}.ts`, ...inputs, "--journal", journalPath, "--dust-floor", "1", ...flags(root)];
  const chain = (): OfflineChain => JSON.parse(readFileSync(chainFile, "utf8"));
  // Renamed over the chain file whole, as test/offline.ts writes it, since the script reads it at any moment.
  const save = (change: Partial<OfflineChain>) => {
    writeFileSync(`${chainFile}.test`, JSON.stringify({ ...chain(), ...change }));
    renameSync(`${chainFile}.test`, chainFile);
  };
  // The environment the script runs in, its faults `fault`.
  const env = (fault = "") => ({ ...humanEnvironment(), HOME: `${root}/home`, OFFLINE_CHAIN: chainFile, OFFLINE_FAULT: fault });
  return {
    async run(answer: (token: string) => string | Promise<string>, fault = "", watch: (output: string) => void = () => undefined) {
      const child = spawn("script", ["-qec", command.map(quoted).join(" "), "/dev/null"], { cwd: root, env: env(fault), timeout: 120_000 });
      let output = "";
      const tokens: string[] = [];
      child.stdout.on("data", (chunk) => {
        output += chunk;
        for (const [, token] of [...output.matchAll(PROMPT)].slice(tokens.length)) {
          tokens.push(token!);
          void Promise.resolve(answer(token!)).then((reply) => child.stdin.write(`${reply}\n`));
        }
        watch(output);
      });
      const [status] = await once(child, "close");
      return { status: status as number | null, output: output.replaceAll("\r\n", "\n"), token: tokens[0], tokens };
    },
    floor: (value: string) => { command[command.indexOf("--dust-floor") + 1] = value; },
    command,
    env,
    root,
    chain,
    update: save,
    journalPath,
    walletRecord,
    advance: (millis: number) => save({ aheadMs: chain().aheadMs + millis }),
    lagNode: (nodeLags: boolean) => save({ nodeLags }),
    // How many times the runs so far closed the wallet, and whether one left the journal open:
    // SQLite removes the write-ahead log when the last connection to the database closes.
    closes: () => ({ wallet: chain().walletCloses ?? 0, journalLeftOpen: existsSync(`${journalPath}-wal`) }),
    journal() {
      const db = new DatabaseSync(journalPath, { readOnly: true });
      const rows = db.prepare("select tx_hash, state from attempts order by id").all();
      db.close();
      return rows;
    },
  };
}

export const randomHash = () => randomBytes(32).toString("hex");
export const planEntries = () => [
  { label: "git-head", kind: 1, rootHash: randomHash(), manifestHash: randomHash(), merkleRoot: randomHash() },
  { label: "hidden-suite", kind: 2, rootHash: randomHash(), manifestHash: randomHash(), merkleRoot: randomHash(), attribute: randomHash() },
];
// FPS's mainnet registry as deploy-mainnet leaves its journal: deployed through registryDeployer,
// sent and landed. Every anchor test copies that journal as its deploy journal.
export const FPS_DEPLOY = await (async () => {
  const net = chain({ network: "mainnet" });
  const journalPath = fresh("mainnet-deploy.sqlite");
  const deployer = registryDeployer({ network: "mainnet", wallet: wallet(net, () => journalPath), source: net.source, prover, journalPath, pollMillis: 1 });
  const { address } = await deployer.submit(await deployer.prepare());
  deployer.close();
  return { journalPath, address };
})();
export const REGISTRY = FPS_DEPLOY.address;
export type PlanEntry = ReturnType<typeof planEntries>[number] & { attribute?: string };

// anchor-mainnet over an offline mainnet whose node holds `state` at REGISTRY (none when null),
// deployed before the run as FPS's deploy journal records, with throwaway author and salt keys it
// pins as the FPS mainnet keys and a plan of `entries` for `registry`.
export function offlineAnchors({ state = registryInitialState(), entries = planEntries() as unknown[], registry = REGISTRY }: { state?: L.ContractState | null; entries?: unknown[]; registry?: string } = {}) {
  const m = offlineMainnet("anchor-mainnet", (root) => [
    "--plan",
    `${root}/plan.json`,
    "--deploy-journal",
    `${root}/state/deploy.sqlite`,
    "--author-key",
    `${root}/author.key`,
    "--salt-key",
    `${root}/salt.key`,
    "--results",
    `${root}/state/results.json`,
  ]);
  const deployJournal = `${m.root}/state/deploy.sqlite`;
  mkdirSync(`${m.root}/state`, { mode: 0o700 });
  copyFileSync(FPS_DEPLOY.journalPath, deployJournal);
  chmodSync(deployJournal, 0o600);
  const author = createAuthorKeyFile(`${m.root}/author.key`);
  const saltKeyId = createSaltKeyFile(`${m.root}/salt.key`);
  const deployed = state === null ? {} : { ["d0".repeat(32)]: { raw: "", height: 500, address: REGISTRY, state: hex(state.serialize()) } };
  m.update({ landed: deployed, fpsKeys: { authorKeys: [author], saltKeyIds: [saltKeyId] } });
  writeFileSync(`${m.root}/plan.json`, JSON.stringify({ registry, entries }));
  const resultsPath = `${m.root}/state/results.json`;
  return {
    ...m,
    entries: entries as PlanEntry[],
    deployJournal,
    author,
    saltKeyId,
    saltKey: readAuthorSecret(`${m.root}/salt.key`),
    resultsPath,
    results: () => (existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : null),
    // The transactions the node was handed, past the registry's deploy.
    sent: () => m.chain().sent,
  };
}

