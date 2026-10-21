import { describe, it } from "vitest";
import { chmodSync, copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fresh } from "../../test/fakes.js";
import { FPS_DEPLOY, REGISTRY, offlineAnchors, offlineMainnet } from "../../test/offline-mainnet.js";
import { deployIntent } from "../confirm.js";
import { LIMITS } from "../limits.js";
import { runIntent } from "../run.js";
import { readAudit, readStatus, type RunnerPaths } from "../state.js";
import { PLACEHOLDER, stateRoot } from "./helpers.js";

// The runner over the real deploy-mainnet and anchor-mainnet, run against an offline mainnet
// (test/offline.ts in place of the submit package), with the recorded wallet the payer limits.json
// allows. Each attempt takes the next line of `faults` as its OFFLINE_FAULT.
const PAYER_NAME = LIMITS.payer.slice("mn_addr1".length);
type Offline = ReturnType<typeof offlineMainnet>;
function runner(m: Offline, paths: Partial<RunnerPaths>, faults: string[], command = m.command) {
  const r = stateRoot({ paths });
  m.walletRecord(PAYER_NAME);
  const faultFile = fresh("faults");
  writeFileSync(faultFile, faults.map((f) => `${f}\n`).join(""));
  const each = 'f=$(head -n 1 "$0"); sed -i 1d "$0"; OFFLINE_FAULT="$f" exec "$@"';
  return {
    ...r,
    run: (id: string) =>
      runIntent({ paths: r.paths, id, cwd: m.root, env: m.env(), tool: (_, plan) => ["sh", "-c", each, faultFile, ...command, ...(plan ? ["--plan", plan] : [])], backoffMs: [100], pollMs: 100 }),
  };
}

describe.concurrent("runIntent over the real mainnet tools on an offline mainnet", () => {
  it("retries deploy-mainnet after its wallet sync stalled, then confirms the deploy, which the node lands once", async ({ expect }) => {
    const m = offlineMainnet();
    const r = runner(m, { deployJournal: m.journalPath }, ["stall-sync", ""]);
    const id = r.approve(deployIntent(LIMITS.payer, "0.01"));
    const status = await r.run(id);
    expect(status, readFileSync(r.files.log(id), "utf8")).toMatchObject({ state: "done", attempt: 2 });
    const [sent] = m.chain().sent;
    expect(m.chain().sent).toEqual([sent]);
    expect(status.transactions).toEqual([expect.objectContaining({ item: "deploy", tx_hash: sent, fee_dust: "0" })]);
    expect(m.journal()).toEqual([{ tx_hash: sent, state: "landed" }]);
    expect(readAudit(r.paths.root).find((e) => e.event === "retry")?.reason).toBe("deploy-mainnet: the mainnet wallet did not sync within 10800 s; its sync state is saved, and a rerun resumes from it");
    expect(readFileSync(r.files.log(id), "utf8")).toContain("deployed and read back from the node");
  });

  it("after a run that failed past its broadcast, confirms the deploy the journal resumes and sends nothing again", async ({ expect }) => {
    const m = offlineMainnet();
    const r = runner(m, { deployJournal: m.journalPath }, ["lose-read", ""]);
    const id = r.approve(deployIntent(LIMITS.payer, "0.01"));
    const status = await r.run(id);
    expect(status, readFileSync(r.files.log(id), "utf8")).toMatchObject({ state: "done", attempt: 2 });
    const [sent] = m.chain().sent;
    expect(m.chain()).toMatchObject({ sent: [sent], discarded: [] });
    expect(readFileSync(r.files.log(id), "utf8")).toContain("journal          resumed: these bytes landed; confirming sends nothing and reads the deploy back");
    expect(readAudit(r.paths.root).filter((e) => e.event === "confirm").map((e) => [e.tx_hash, e.resumed])).toEqual([
      [sent, false],
      [sent, true],
    ]);
    expect(m.journal()).toEqual([{ tx_hash: sent, state: "landed" }]);
  });

  it("answers NO to a deploy paid from another wallet, and the tool discards its bytes and sends nothing", async ({ expect }) => {
    const m = offlineMainnet();
    const r = runner(m, { deployJournal: m.journalPath }, [""]);
    m.walletRecord("offline");
    const id = r.approve(deployIntent(LIMITS.payer, "0.01"));
    const status = await r.run(id);
    expect(status).toMatchObject({ state: "refused", attempt: 1, transactions: [] });
    expect(status.refusals[0]!.reason).toBe('deploy: payer is "mn_addr1offline"');
    expect(m.chain()).toMatchObject({ sent: [], discarded: [expect.any(String)] });
    expect(readFileSync(r.files.log(id), "utf8")).toContain("deploy-mainnet: not confirmed; the prepared bytes were discarded and nothing was sent");
  });

  it("waits for deploy-mainnet's journal to land the registry, writes the plan, and confirms each anchor anchor-mainnet shows", async ({ expect }) => {
    const m = offlineAnchors();
    // anchor-mainnet over the offline mainnet writes under a throwaway author key it pins as FPS's.
    const pinned = [...LIMITS.anchors.authorKeys];
    LIMITS.anchors.authorKeys.splice(0, pinned.length, m.author);
    try {
      rmSync(m.deployJournal);
      rmSync(`${m.root}/plan.json`);
      const command = m.command.filter((arg, i, all) => arg !== "--plan" && all[i - 1] !== "--plan");
      const r = runner(m, { deployJournal: m.deployJournal, planOut: `${m.root}/plan.json`, anchorsJournal: m.journalPath }, [""], command);
      writeFileSync(r.template, JSON.stringify({ registry: PLACEHOLDER, entries: m.entries }));
      const id = r.approve(r.anchors());
      const running = r.run(id);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(readStatus(r.paths.root, id)).toMatchObject({ state: "waiting-for-deploy" });
      copyFileSync(FPS_DEPLOY.journalPath, m.deployJournal);
      chmodSync(m.deployJournal, 0o600);
      const status = await running;
      expect(status, readFileSync(r.files.log(id), "utf8")).toMatchObject({ state: "done", attempt: 1 });
      expect(JSON.parse(readFileSync(`${m.root}/plan.json`, "utf8"))).toEqual({ registry: REGISTRY, entries: m.entries });
      expect(m.sent()).toHaveLength(2);
      expect(status.transactions.map((t) => [t.item, t.tx_hash])).toEqual(m.entries.map((e, i) => [e.label, m.sent()[i]]));
      expect(m.results().map((row: { label: string }) => row.label)).toEqual(m.entries.map((e) => e.label));
    } finally {
      LIMITS.anchors.authorKeys.splice(0, 1, ...pinned);
    }
  });
});
