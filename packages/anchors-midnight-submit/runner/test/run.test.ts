import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fresh } from "../../test/fakes.js";
import { deployIntent } from "../confirm.js";
import { admit } from "../gate.js";
import { LIMITS } from "../limits.js";
import { runIntent } from "../run.js";
import { readAudit, readStatus } from "../state.js";
import type { FakeTool } from "./fake-tool.js";
import { HOUR, deployJournal, iso, journalled, scriptPid, stateRoot } from "./helpers.js";

const PACKAGE = new URL("../..", import.meta.url).pathname;
const DEPLOY = deployIntent(LIMITS.payer, "0.01");
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
afterEach(() => vi.unstubAllEnvs());

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
    expect(JSON.parse(readFileSync(r.files.used(id, status.approval_sha256), "utf8"))).toMatchObject({ outcome: "done", approval_sha256: status.approval_sha256 });
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
    expect(JSON.parse(readFileSync(r.files.used(id, status.approval_sha256), "utf8"))).toMatchObject({ outcome: "refused", approval_sha256: status.approval_sha256 });
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

  it.each(["pending", "landed"] as const)("answers NO to other bytes for a transaction it confirmed while the journal holds that one %s", async (held) => {
    const r = runner({ kind: "deploy", failsAfterConfirm: 1, txHashes: [TX(0xaa), TX(0xbb)] });
    const id = r.approve(DEPLOY);
    journalled(r.paths.deployJournal, TX(0xaa), held);
    const status = await r.run(id);
    expect(status).toMatchObject({ state: "refused", attempt: 2, transactions: [{ item: "deploy", tx_hash: TX(0xaa) }] });
    expect(status.refusals[0]!.reason).toBe(`deploy: the journal holds ${TX(0xaa)}, confirmed for it earlier, ${held}; other bytes could land it twice`);
    expect(r.typed().map((t) => [t.run, t.typed])).toEqual([
      [1, `DEPLOY ${TX(0xaa).slice(0, 16)}`],
      [2, "NO"],
    ]);
  });

  it("refuses new bytes when earlier confirmations have lost their journal evidence", async () => {
    const r = runner({ kind: "deploy", failsAfterConfirm: 1, txHashes: [TX(0xa1), TX(0xa2)] });
    const id = r.approve(DEPLOY);
    const status = await r.run(id);
    expect(status).toMatchObject({ state: "refused", attempt: 2 });
    expect(status.refusals[0]!.reason).toMatch(/journal.*missing.*recover/);
    expect(status.transactions.map((t) => t.tx_hash)).toEqual([TX(0xa1)]);
    expect(r.typed().map((t) => t.confirmed)).toEqual([true, false]);
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

  it("retries a run whose script a stray SIGTERM ended after a confirmation, resuming the anchor it confirmed, and finishes once the tool does", async () => {
    const r = runner({ kind: "anchor", afterConfirmMs: 1500 });
    const id = r.approve(r.anchors());
    await deployJournal(r.paths.deployJournal);
    const running = r.run(id);
    while (r.typed().length === 0) await sleep(25);
    process.kill(scriptPid(), "SIGTERM");
    const status = await running;
    expect(status).toMatchObject({ state: "done", attempt: 2 });
    expect(status.transactions.map((t) => [t.item, t.tx_hash])).toEqual([
      ["proof-run-1", TX(0xa0)],
      ["proof-run-1-hidden", TX(0xa1)],
    ]);
    expect(r.typed().map((t) => [t.run, t.item, t.typed])).toEqual([
      [1, "proof-run-1", `ANCHOR ${TX(0xa0).slice(0, 16)}`],
      [2, "proof-run-1", `ANCHOR ${TX(0xa0).slice(0, 16)}`],
      [2, "proof-run-1-hidden", `ANCHOR ${TX(0xa1).slice(0, 16)}`],
    ]);
    expect(readAudit(r.paths.root).filter((e) => e.event === "run-end").map((e) => e.code)).toEqual([null, 0]);
  });

  it("retries a run whose script a stray SIGINT ended during the wallet sync, rather than take it for finished", async () => {
    const r = runner({ kind: "deploy", syncMs: 1500 });
    const id = r.approve(DEPLOY);
    const running = r.run(id);
    while (!(existsSync(r.files.log(id)) && readFileSync(r.files.log(id), "utf8").includes("Syncing the wallet"))) await sleep(25);
    process.kill(scriptPid(), "SIGINT");
    const status = await running;
    expect(status).toMatchObject({ state: "done", attempt: 2, transactions: [{ item: "deploy", tx_hash: TX(0xaa) }] });
    expect(r.typed()).toEqual([{ run: 2, item: "deploy", typed: `DEPLOY ${TX(0xaa).slice(0, 16)}`, confirmed: true }]);
    expect(r.events(id)).toEqual(["approval-seen", "run-start", "run-end", "retry", "run-start", "confirm", "run-end", "done"]);
  });

  it("records the NO to a prompt for the other action before the tool reads it, so an interrupted run cannot use the approval again", async () => {
    const r = runner({ kind: "deploy", discardMs: 2000 });
    const id = r.approve(r.anchors());
    await deployJournal(r.paths.deployJournal);
    const running = r.run(id);
    while (r.typed().length === 0) await sleep(25);
    // The tool has read its NO and is still discarding the bytes.
    expect(admit(r.paths, id, Date.now())).toMatchObject({ ok: false, reason: `approval ${id} was already used` });
    const status = await running;
    expect(status).toMatchObject({ state: "refused", attempt: 1, transactions: [] });
    expect(status.refusals[0]!.reason).toBe(`the tool asks for "DEPLOY ${TX(0xaa).slice(0, 16)}", not an ANCHOR token`);
    expect(r.typed()).toEqual([{ run: 1, item: "deploy", typed: "NO", confirmed: false }]);
  });

  it("keeps an approval a NO used when its file is rewritten with the same values, and runs nothing more", async () => {
    const r = runner({ kind: "deploy", payer: "mn_addr1other" });
    const id = r.approve(DEPLOY);
    expect((await r.run(id)).state).toBe("refused");
    writeFileSync(r.files.approval(id), `${JSON.stringify(JSON.parse(readFileSync(r.files.approval(id), "utf8")), null, 2)}\n`);
    const again = await r.run(id);
    expect(again).toMatchObject({ state: "refused", attempt: 1 });
    expect(again.refusals.at(-1)!.reason).toBe(`approval ${id} was already used`);
    expect(r.runs()).toBe(1);
  });

  it("keeps an approval it finished used from its done record alone, once the used marker and status are lost", async () => {
    const r = runner({ kind: "deploy" });
    const id = r.approve(DEPLOY);
    const done = await r.run(id);
    expect(r.events(id)).toEqual(["approval-seen", "run-start", "confirm", "run-end", "done"]);
    rmSync(r.files.used(id, done.approval_sha256));
    rmSync(r.files.status(id));
    expect(admit(r.paths, id, Date.now())).toMatchObject({ ok: false, reason: `approval ${id} was already used` });
    expect(await r.run(id)).toMatchObject({ state: "refused", attempt: 0 });
    expect(r.runs()).toBe(1);
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

  it("runs nothing for an approval whose times name no offset, in the runner's zone or in UTC, and runs its corrected approval", async () => {
    const r = runner({ kind: "deploy" });
    vi.stubEnv("TZ", "America/Denver");
    // The local wall-clock time `ms` names in the runner's zone, as `date` without -u and Z prints it.
    const local = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
    const approvedAt = local(Date.now() - 60_000);
    const id = r.approve(DEPLOY, { approved_at: approvedAt, expires_at: local(Date.now() - 60_000 + 24 * HOUR) });
    for (const tz of ["America/Denver", "UTC"]) {
      vi.stubEnv("TZ", tz);
      const status = await r.run(id);
      expect(status).toMatchObject({ state: "refused", attempt: 0 });
      expect(status.refusals.at(-1)!.reason).toBe(`the approval's approved_at "${approvedAt}" is not an ISO 8601 time with Z or a ±hh:mm offset`);
    }
    expect([r.runs(), r.typed(), r.events(id)]).toEqual([0, [], ["approval-seen", "refused", "approval-seen", "refused"]]);
    r.approve(DEPLOY);
    expect(await r.run(id)).toMatchObject({ state: "done", attempt: 1 });
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
