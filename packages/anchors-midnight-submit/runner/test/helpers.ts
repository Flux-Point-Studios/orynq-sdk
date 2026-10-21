import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { buildRegistryDeploy, registryInitialState } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { openJournal } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { fresh } from "../../test/fakes.js";
import { prover } from "../../test/prover.js";
import { afterDeployRegistry, anchorsIntent, intentSha256, type AnchorsIntent, type DeployIntent } from "../confirm.js";
import { admit } from "../gate.js";
import { LIMITS } from "../limits.js";
import { ensureRunnerRoot, runnerFiles, type RunnerPaths } from "../state.js";

export const HOUR = 3_600_000;
export const iso = (ms: number) => new Date(ms).toISOString();
export const PLACEHOLDER = "0".repeat(64);
export const ENTRIES = [
  { label: "proof-run-1", kind: 1, rootHash: "11".repeat(32), manifestHash: "22".repeat(32), merkleRoot: "33".repeat(32) },
  { label: "proof-run-1-hidden", kind: 2, rootHash: "11".repeat(32), manifestHash: "22".repeat(32), merkleRoot: "33".repeat(32), attribute: "44".repeat(32) },
];

// A runner state root of its own, beside a plan template of ENTRIES and a deploy journal, anchors
// journal and filled plan that do not exist yet, unless `paths` names others. Its approvals are
// given a minute before `now()`.
export function stateRoot({ now = () => Date.now(), paths: given = {} }: { now?: () => number; paths?: Partial<RunnerPaths> } = {}) {
  const dir = fresh("runner");
  mkdirSync(dir, { mode: 0o700 });
  const paths: RunnerPaths = { root: `${dir}/state`, deployJournal: `${dir}/mainnet-deploy.sqlite`, anchorsJournal: `${dir}/mainnet-anchors.sqlite`, planOut: `${dir}/plan.json`, ...given };
  const files = runnerFiles(paths.root);
  const template = `${dir}/plan.template.json`;
  writeFileSync(template, JSON.stringify({ registry: PLACEHOLDER, entries: ENTRIES }, null, 2));
  return {
    dir,
    paths,
    files,
    template,
    // The after-deploy anchors intent of the template, as auto-anchor --after-deploy builds it.
    anchors: (change: Partial<AnchorsIntent> = {}): AnchorsIntent => ({ ...anchorsIntent({ plan: template, registry: afterDeployRegistry(paths.deployJournal, paths.planOut), payer: LIMITS.payer, maxFeeDustPerAnchor: "0.01" }), ...change }),
    // Writes `intent` as intents/<id>.json and, unless `approval` is null, deci's chat approval of
    // it for 24 hours from a minute ago, with `approval`'s fields in its place; returns the id.
    approve(intent: DeployIntent | AnchorsIntent | Record<string, unknown>, approval: Record<string, unknown> | null = {}) {
      const sha = intentSha256(intent as DeployIntent);
      const id = sha.slice(0, 8);
      ensureRunnerRoot(paths.root);
      writeFileSync(files.intent(id), JSON.stringify(intent, null, 2));
      const approved = now() - 60_000;
      if (approval) writeFileSync(files.approval(id), JSON.stringify({ intent_id: id, intent_sha256: sha, approved_at: iso(approved), expires_at: iso(approved + 24 * HOUR), approved_via: "chat", approver: "deci", ...approval }));
      return id;
    },
    // The approval of intent `id` as the gate names it in used markers, statuses and the audit log.
    approvalSha256: (id: string) => admit(paths, id, now()).approvalSha256!,
    // Records in the audit log that intent `intent` confirmed `txHash` for `fee` DUST at `at`.
    confirmed(intent: string, txHash: string, fee: string, at = now() - HOUR) {
      ensureRunnerRoot(paths.root);
      appendFileSync(files.audit, `${JSON.stringify({ at: iso(at), intent, event: "confirm", item: "deploy", tx_hash: txHash, fee_dust: fee })}\n`);
    },
  };
}

export const deployKey = (network: string, state = createHash("sha256").update(registryInitialState().serialize()).digest("hex")) => [network, "registry-deploy", "", 0, state, ""].join("/");

// A deploy journal at `path` as deploy-mainnet leaves it, holding one registry deploy on `network`
// in `state` under `key`, read back in `block` when one is given: real final deploy bytes from the
// test prover, in the journal's own schema. Returns the address the deploy creates.
export async function deployJournal(path = fresh("mainnet-deploy.sqlite"), { network = "mainnet", state = "landed", block = { height: 2_048_321, hash: "ab".repeat(32) } as { height: number; hash: string } | null, key = deployKey(network) } = {}) {
  openJournal(path).close();
  const { tx, address } = buildRegistryDeploy({ networkId: network, ttl: new Date(Date.now() + 600e3) });
  const final = (await prover.prove(tx)).bind();
  const db = new DatabaseSync(path);
  db.prepare("insert into attempts (key, tx_hash, bytes, ttl_ms, state, height, block_hash) values (?, ?, ?, ?, ?, ?, ?)").run(key, final.transactionHash(), final.serialize(), Date.now() + 600e3, state, block?.height ?? null, block?.hash ?? null);
  db.close();
  return { path, address: String(address), txHash: final.transactionHash() };
}

// Journals `txHash` in `state` at `path` under a key of its own, as a tool journals bytes it sends.
export function journalled(path: string, txHash: string, state: "pending" | "landed" | "failed") {
  openJournal(path).close();
  const db = new DatabaseSync(path);
  db.prepare("insert into attempts (key, tx_hash, bytes, ttl_ms, state) values (?, ?, ?, ?, ?)").run(`mainnet/test/${txHash}`, txHash, new Uint8Array(1), Date.now(), state);
  db.close();
}

// The PID of the one `script` this test process runs a tool under, so a test signals it and
// nothing else.
export function scriptPid(): number {
  const proc = `/proc/${process.pid}/task`;
  const children = readdirSync(proc).flatMap((task) => readFileSync(`${proc}/${task}/children`, "utf8").split(" ").filter(Boolean));
  const scripts = children.filter((pid) => readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "script");
  if (scripts.length !== 1) throw new Error(`this process runs ${scripts.length} script processes, not one`);
  return Number(scripts[0]);
}
