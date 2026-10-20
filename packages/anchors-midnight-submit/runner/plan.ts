// The plan an anchors intent authorized before the deploy landed runs with: its template's entries
// for the registry deploy-mainnet's journal holds landed and read back in its block.
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { writePrivateFile } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { readAnchorPlan } from "../src/anchor-plan.js";
import { landedRegistryDeploy } from "../src/deployer.js";
import { readJsonFile } from "../src/json-file.js";

const PLACEHOLDER = "0".repeat(64);

// FPS's mainnet registry deploy as the journal at `deployJournal` holds it landed and read back in
// its block, or null until it does.
export function landedDeploy(deployJournal: string): { address: string; txHash: string; height: number; blockHash: string } | null {
  const row = landedRegistryDeploy("mainnet", deployJournal);
  if (row?.height === undefined || row.blockHash === undefined) return null;
  return { address: row.address, txHash: row.txHash, height: row.height, blockHash: row.blockHash };
}

// Writes `template`'s plan for `registry` to `out`, owner-only, once anchor-mainnet's own parser
// accepts it; true when written, false when `out` already holds exactly that plan. A template
// whose registry is not the placeholder, and an `out` holding anything else, are refused.
export function fillPlan(template: string, registry: string, out: string): boolean {
  const refuse = (reason: string): never => {
    throw new Error(`${reason}; nothing was written`);
  };
  const json = readJsonFile(template) as { registry?: unknown };
  if (json.registry !== PLACEHOLDER) refuse(`${template} names registry ${String(json.registry)}, not the placeholder ${PLACEHOLDER}`);
  const plan = JSON.stringify({ ...json, registry }, null, 2);
  if (existsSync(out)) {
    if (readFileSync(out, "utf8") !== `${plan}\n`) refuse(`${out} already exists and differs from the plan for registry ${registry}`);
    return false;
  }
  const next = `${out}.${process.pid}.next`;
  writePrivateFile(next, plan);
  try {
    if (readAnchorPlan(next).registry !== registry) refuse(`anchor-mainnet's parser reads another registry from ${next}`);
  } catch (error) {
    rmSync(next);
    throw error;
  }
  renameSync(next, out);
  return true;
}
