import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fresh } from "../../test/fakes.js";
import { deployIntent } from "../confirm.js";
import { LIMITS } from "../limits.js";
import { runIntent } from "../run.js";
import { readAudit, readStatus } from "../state.js";
import type { FakeTool } from "./fake-tool.js";
import { deployJournal, iso, journalled, stateRoot } from "./helpers.js";

const PACKAGE = new URL("../..", import.meta.url).pathname;
const DEPLOY = deployIntent(LIMITS.payer, "0.01");
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

// The runner over the fake tool, with a state root of its own: `fake` says what the tool shows,
// `backoffMs` how long the runner waits between attempts.
function runner(fake: Omit<FakeTool, "runs" | "record">, { backoffMs = [50], pollMs = 50 }: { backoffMs?: number[]; pollMs?: number } = {}) {
  const r = stateRoot();
  const files = { runs: fresh("runs"), record: fresh("record.jsonl") };
  return {
    ...r,
    run: (id: string) =>
      runIntent({
        paths: r.paths,
        id,
        cwd: PACKAGE,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_TOOL: JSON.stringify({ ...fake, ...files }) },
        tool: (_, plan) => [process.execPath, "--import", "tsx", "runner/test/fake-tool.ts", ...(plan ? ["--plan", plan] : [])],
        backoffMs,
        pollMs,
      }),
    // What the tool was typed at each prompt of each run.
    typed: (): { run: number; item: string; typed: string; confirmed: boolean }[] =>
      existsSync(files.record)
        ? readFileSync(files.record, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    runs: () => (existsSync(files.runs) ? Number(readFileSync(files.runs, "utf8")) : 0),
    events: (id: string) => readAudit(r.paths.root).filter((e) => e.intent === id).map((e) => e.event),
  };
}

describe("runIntent over the fake tool", () => {
  it("confirms a deploy whose every fact matches, records it, and spends the approval", async () => {
    const r = runner({ kind: "deploy" });
    const id = r.approve(DEPLOY);
    const status = await r.run(id);
    expect(status).toMatchObject({ intent_id: id, action: "deploy", state: "done", attempt: 1, refusals: [], transactions: [{ item: "deploy", tx_hash: TX(0xaa), fee_dust: "0.000000000000002" }] });
    expect(readStatus(r.paths.root, id)).toEqual(status);
    expect(r.typed()).toEqual([{ run: 1, item: "deploy", typed: `DEPLOY ${TX(0xaa).slice(0, 16)}`, confirmed: true }]);
    expect(JSON.parse(readFileSync(r.files.used(id), "utf8"))).toMatchObject({ outcome: "done" });
    expect(r.events(id)).toEqual(["approval-seen", "run-start", "confirm", "run-end", "done"]);
    expect(readFileSync(r.files.log(id), "utf8")).toContain("deployed and read back from the node");
    expect(status.last_progress).toMatch(/^deployed and read back from the node/);
  });

  it.each<[string, Partial<FakeTool>, RegExp]>([
    ["payer", { payer: "mn_addr1other" }, /payer is "mn_addr1other"/],
    ["fee", { fee: String(10n ** 13n + 1n) }, /fee is "0\.010000000000001 DUST, all of it burned", cap 0\.01 DUST/],
    ["committee", { committee: 1 }, /authority is "committee \[\] \(1 members\)/],
    ["verifier key", { verifierKeys: { anchor: "ee".repeat(32) } }, /anchor verifier key is "vk sha256 (ee){32}"/],
    ["network", { chain: { genesis: "11".repeat(32) } }, /network is "mainnet \(Midnight Mainnet, genesis (11){32}\)"/],
  ])("answers NO to a deploy whose %s does not match, does not retry, and spends the approval", async (_, change, problem) => {
    const r = runner({ kind: "deploy", ...change });
    const id = r.approve(DEPLOY);
    const status = await r.run(id);
    expect(status).toMatchObject({ state: "refused", attempt: 1, transactions: [] });
    expect(status.refusals).toEqual([{ at: expect.any(String), reason: expect.stringMatching(problem) }]);
    expect(r.typed()).toEqual([{ run: 1, item: "deploy", typed: "NO", confirmed: false }]);
    expect(JSON.parse(readFileSync(r.files.used(id), "utf8"))).toMatchObject({ outcome: "refused" });
    expect(r.events(id)).toEqual(["approval-seen", "run-start", "no", "run-end", "refused"]);
  });

  it("retries a wallet sync that failed, with backoff, until the tool confirms", async () => {
    const r = runner({ kind: "deploy", syncFailures: 2 }, { backoffMs: [50, 100] });
    const id = r.approve(DEPLOY);
    const status = await r.run(id);
    expect(status).toMatchObject({ state: "done", attempt: 3, refusals: [] });
    expect(r.typed()).toEqual([{ run: 3, item: "deploy", typed: `DEPLOY ${TX(0xaa).slice(0, 16)}`, confirmed: true }]);
    expect(r.events(id)).toEqual(["approval-seen", "run-start", "run-end", "retry", "run-start", "run-end", "retry", "run-start", "confirm", "run-end", "done"]);
    const retries = readAudit(r.paths.root).filter((e) => e.event === "retry");
    expect(retries.map((e) => [e.after_ms, e.reason])).toEqual([
      [50, "deploy-mainnet: the mainnet wallet did not sync within 10800 s; its sync state is saved, and a rerun resumes from it"],
      [100, "deploy-mainnet: the mainnet wallet did not sync within 10800 s; its sync state is saved, and a rerun resumes from it"],
    ]);
  });

  it("resumes the transaction it confirmed after a run failed past the confirmation, sending nothing new", async () => {
    const r = runner({ kind: "deploy", failsAfterConfirm: 1 });
    const id = r.approve(DEPLOY);
    journalled(r.paths.deployJournal, TX(0xaa), "pending");
    const status = await r.run(id);
    expect(status).toMatchObject({ state: "done", attempt: 2, transactions: [{ item: "deploy", tx_hash: TX(0xaa) }] });
    expect(r.typed().map((t) => [t.run, t.typed])).toEqual([
      [1, `DEPLOY ${TX(0xaa).slice(0, 16)}`],
      [2, `DEPLOY ${TX(0xaa).slice(0, 16)}`],
    ]);
    const confirms = readAudit(r.paths.root).filter((e) => e.event === "confirm");
    expect(confirms.map((e) => [e.tx_hash, e.resumed])).toEqual([
      [TX(0xaa), false],
      [TX(0xaa), true],
    ]);
  });

  it("answers NO to other bytes for a transaction it confirmed while the journal still holds that one", async () => {
    const r = runner({ kind: "deploy", failsAfterConfirm: 1, txHashes: [TX(0xaa), TX(0xbb)] });
    const id = r.approve(DEPLOY);
    journalled(r.paths.deployJournal, TX(0xaa), "pending");
    const status = await r.run(id);
    expect(status).toMatchObject({ state: "refused", attempt: 2, transactions: [{ item: "deploy", tx_hash: TX(0xaa) }] });
    expect(status.refusals[0]!.reason).toBe(`deploy: the journal holds ${TX(0xaa)}, confirmed for it earlier, pending; other bytes could land it twice`);
    expect(r.typed().map((t) => [t.run, t.typed])).toEqual([
      [1, `DEPLOY ${TX(0xaa).slice(0, 16)}`],
      [2, "NO"],
    ]);
  });

  it("confirms new bytes for a transaction whose earlier bytes the journal never held, so never sent", async () => {
    const r = runner({ kind: "deploy", failsAfterConfirm: 1, txHashes: [TX(0xa1), TX(0xa2)] });
    const id = r.approve(DEPLOY);
    const status = await r.run(id);
    expect(status).toMatchObject({ state: "done", attempt: 2 });
    expect(status.transactions.map((t) => t.tx_hash)).toEqual([TX(0xa1), TX(0xa2)]);
  });

  it("confirms new bytes once the journal retired the ones it confirmed, at most three times per transaction", async () => {
    const r = runner({ kind: "deploy", failsAfterConfirm: 3, txHashes: [TX(0xa1), TX(0xa2), TX(0xa3), TX(0xa4)] });
    const id = r.approve(DEPLOY);
    for (const n of [0xa1, 0xa2, 0xa3]) journalled(r.paths.deployJournal, TX(n), "failed");
    const status = await r.run(id);
    expect(status.transactions.map((t) => t.tx_hash)).toEqual([TX(0xa1), TX(0xa2), TX(0xa3)]);
    expect(status).toMatchObject({ state: "refused", attempt: 4 });
    expect(status.refusals[0]!.reason).toBe("deploy: confirmed 3 times under this approval, the most limits.json allows");
    expect(r.typed().map((t) => t.typed)).toEqual([TX(0xa1), TX(0xa2), TX(0xa3)].map((tx) => `DEPLOY ${tx.slice(0, 16)}`).concat("NO"));
  });

  it("counts every transaction it confirmed toward the daily cap, so bytes prepared anew cannot pass it", async () => {
    const r = runner({ kind: "deploy", fee: String(10n ** 13n), failsAfterConfirm: 1, txHashes: [TX(0xa1), TX(0xa2)] });
    const id = r.approve(DEPLOY);
    r.confirmed("34941c71", TX(0x01), "0.09");
    journalled(r.paths.deployJournal, TX(0xa1), "failed");
    const status = await r.run(id);
    expect(status).toMatchObject({ state: "refused", attempt: 2, transactions: [{ tx_hash: TX(0xa1), fee_dust: "0.01" }] });
    expect(status.refusals[0]!.reason).toBe("deploy: 0.1 DUST reserved for the rolling 24 h window and this transaction's 0.01 DUST come to more than the 0.1 DUST daily cap");
  });

  it("stops once the approval expires between attempts, and does not start another", async () => {
    const r = runner({ kind: "deploy", syncFailures: 100 }, { backoffMs: [2000] });
    const id = r.approve(DEPLOY);
    const running = r.run(id);
    // The approval's expiry passes while the runner waits to retry.
    while (!r.events(id).includes("retry")) await new Promise((resolve) => setTimeout(resolve, 50));
    const expiresAt = iso(Date.now());
    r.approve(DEPLOY, { approved_at: iso(Date.now() - 1000), expires_at: expiresAt });
    const status = await running;
    expect(status).toMatchObject({ state: "expired", attempt: 1 });
    expect(status.refusals.at(-1)!.reason).toBe(`the approval expired at ${expiresAt}`);
    expect([r.runs(), r.events(id)]).toEqual([1, ["approval-seen", "run-start", "run-end", "retry", "expired"]]);
    expect(r.typed()).toEqual([]);
    expect(existsSync(r.files.used(id))).toBe(false);
  });

  it("ends at once when the next attempt would start after the approval expires, rather than wait out the backoff", async () => {
    const r = runner({ kind: "deploy", syncFailures: 100 }, { backoffMs: [60_000] });
    const id = r.approve(DEPLOY, { approved_at: iso(Date.now() - 1000), expires_at: iso(Date.now() + 30_000) });
    const started = Date.now();
    const status = await r.run(id);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(status).toMatchObject({ state: "expired", attempt: 1 });
    expect(status.refusals.at(-1)!.reason).toMatch(/^the approval expires at \S+, before the next attempt at \S+$/);
  });

  it("stops the tool when the approval expires before it confirmed anything", async () => {
    const r = runner({ kind: "deploy", syncMs: 60_000 });
    const id = r.approve(DEPLOY, { approved_at: iso(Date.now() - 1000), expires_at: iso(Date.now() + 1500) });
    const started = Date.now();
    const status = await r.run(id);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(status).toMatchObject({ state: "expired", attempt: 1 });
    expect(r.typed()).toEqual([]);
  });

  it("answers NO when the approval is withdrawn while the tool syncs", async () => {
    const r = runner({ kind: "deploy", syncMs: 3000 });
    const id = r.approve(DEPLOY);
    const running = r.run(id);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    rmSync(r.files.approval(id));
    const status = await running;
    expect(status).toMatchObject({ state: "refused", attempt: 1, transactions: [] });
    expect(status.refusals[0]!.reason).toBe(`deploy: the approval no longer holds: no approval ${r.files.approval(id)}`);
    expect(r.typed()).toEqual([{ run: 1, item: "deploy", typed: "NO", confirmed: false }]);
  });

  it("leaves a tool that confirmed before the approval expired to finish", async () => {
    const r = runner({ kind: "deploy", afterConfirmMs: 22_000 });
    const id = r.approve(DEPLOY, { approved_at: iso(Date.now() - 1000), expires_at: iso(Date.now() + 20_000) });
    const status = await r.run(id);
    expect(Date.parse(status.updated_at)).toBeGreaterThan(Date.parse(status.expires_at!));
    expect(status).toMatchObject({ state: "done", attempt: 1, transactions: [{ tx_hash: TX(0xaa) }] });
  });

  it("refuses before running anything when the gate refuses, and leaves the approval unused", async () => {
    const r = runner({ kind: "deploy" });
    const id = r.approve(DEPLOY, { approver: "codex" });
    const status = await r.run(id);
    expect(status).toMatchObject({ state: "refused", attempt: 0 });
    expect(status.refusals[0]!.reason).toBe('the approval is not deci\'s in chat: approver "codex", approved_via "chat"');
    expect(r.runs()).toBe(0);
    expect(existsSync(r.files.used(id))).toBe(false);
    expect(r.events(id)).toEqual(["approval-seen", "refused"]);
  });

  it("waits for the deploy to land, writes the after-deploy plan for its registry, then confirms each matching anchor", async () => {
    const r = runner({ kind: "anchor" });
    const id = r.approve(r.anchors());
    const running = r.run(id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readStatus(r.paths.root, id)).toMatchObject({ state: "waiting-for-deploy", attempt: 0 });
    expect(r.runs()).toBe(0);
    const { address } = await deployJournal(r.paths.deployJournal);
    const status = await running;
    expect(status).toMatchObject({ state: "done", attempt: 1 });
    expect(status.transactions.map((t) => t.item)).toEqual(["proof-run-1", "proof-run-1-hidden"]);
    expect(JSON.parse(readFileSync(r.paths.planOut, "utf8")).registry).toBe(address);
    expect(r.typed().map((t) => [t.item, t.confirmed])).toEqual([
      ["proof-run-1", true],
      ["proof-run-1-hidden", true],
    ]);
    expect(r.events(id)).toEqual(["approval-seen", "deploy-landed", "plan", "run-start", "confirm", "confirm", "run-end", "done"]);
  });

  it("answers NO to an anchor whose attribute is not its plan entry's after confirming the one before it", async () => {
    const r = runner({ kind: "anchor", anchors: { "proof-run-1-hidden": { attribute: "45".repeat(32) } } });
    const id = r.approve(r.anchors());
    await deployJournal(r.paths.deployJournal);
    const status = await r.run(id);
    expect(status).toMatchObject({ state: "refused", attempt: 1 });
    expect(status.transactions.map((t) => t.item)).toEqual(["proof-run-1"]);
    expect(status.refusals[0]!.reason).toBe(`proof-run-1-hidden: attribute is "${"45".repeat(32)}"`);
  });

  it("stops waiting for the deploy when the approval expires", async () => {
    const r = runner({ kind: "anchor" });
    const id = r.approve(r.anchors(), { approved_at: iso(Date.now() - 1000), expires_at: iso(Date.now() + 800) });
    const status = await r.run(id);
    expect(status).toMatchObject({ state: "expired", attempt: 0 });
    expect(r.runs()).toBe(0);
    expect(existsSync(r.paths.planOut)).toBe(false);
  });
});
