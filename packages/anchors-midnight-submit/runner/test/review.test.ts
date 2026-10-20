import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { readAnchorPlan } from "../../src/anchor-plan.js";
import { deployIntent } from "../confirm.js";
import { confirmedDust } from "../gate.js";
import { LIMITS } from "../limits.js";
import { runIntent } from "../run.js";
import { readAudit, writeStatus } from "../state.js";
import { deployJournal, HOUR, iso, stateRoot } from "./helpers.js";
import type { FakeTool } from "./fake-tool.js";

const PACKAGE = new URL("../..", import.meta.url).pathname;
const DEPLOY = deployIntent(LIMITS.payer, "0.01");
const tx = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fixture(fake: Omit<FakeTool, "runs" | "record"> = { kind: "deploy" }) {
  const r = stateRoot();
  const runs = `${r.dir}/runs`;
  const record = `${r.dir}/record`;
  return {
    ...r,
    runs,
    run: (id: string, beforeTool: (plan?: string) => void = () => undefined) => runIntent({
      paths: r.paths, id, cwd: PACKAGE,
      env: { PATH: process.env.PATH, HOME: r.dir, FAKE_TOOL: JSON.stringify({ ...fake, runs, record }) },
      tool: (_, plan, planSha256) => {
        beforeTool(plan);
        return [process.execPath, "--import", "tsx", "runner/test/fake-tool.ts", ...(plan ? ["--plan", plan] : []), ...(planSha256 ? ["--plan-sha256", planSha256] : [])];
      },
      backoffMs: [10], pollMs: 10,
    }),
    confirmed: () => readAudit(r.paths.root).filter((e) => e.event === "confirm"),
  };
}

describe("runner review invariants", () => {
  it("holds a fee reservation until 24 hours after the transaction's validity deadline", () => {
    const r = stateRoot();
    r.approve(DEPLOY);
    const now = Date.now();
    const until = now - 24 * HOUR + 1000;
    appendFileSync(r.files.audit, `${JSON.stringify({ at: iso(now - 24 * HOUR - 1000), event: "confirm", intent: "12345678", tx_hash: tx(1), fee_dust: "0.01", valid_until: iso(until) })}\n`);
    expect(confirmedDust(r.paths.root, now - 24 * HOUR)).toBe(10n ** 13n);
    expect(confirmedDust(r.paths.root, until)).toBe(0n);
  });

  it("refuses a second prompt for the same item within one attempt", async () => {
    const r = fixture({ kind: "deploy", repeatPrompt: true });
    const result = await r.run(r.approve(DEPLOY));
    expect(result.state).toBe("refused");
    expect(r.confirmed()).toHaveLength(1);
  });

  it("records a wrong-action NO as a terminal refusal", async () => {
    const r = fixture({ kind: "deploy" });
    const id = r.approve(r.anchors(), { expires_at: iso(Date.now() + 5000) });
    await deployJournal(r.paths.deployJournal);
    const result = await r.run(id);
    expect(result.state).toBe("refused");
    expect(result.attempt).toBe(1);
    expect(readAudit(r.paths.root).some((e) => e.event === "no")).toBe(true);
  });

  it("keeps the original approval identity while an attempt is running", async () => {
    const r = fixture({ kind: "deploy", syncMs: 1000 });
    const id = r.approve(DEPLOY);
    const running = r.run(id);
    await vi.waitFor(() => expect(existsSync(r.runs)).toBe(true), { timeout: 10_000 });
    r.approve(DEPLOY, { expires_at: iso(Date.now() + HOUR) });
    const result = await running;
    expect(result.state).toBe("refused");
    expect(result.refusals.at(-1)?.reason).toContain("approval changed");
    expect(r.confirmed()).toEqual([]);
  });

  it("recovers confirmation limits from the audit when a status snapshot is lost", async () => {
    const r = fixture();
    const id = r.approve(DEPLOY);
    const approval = digest(readFileSync(r.files.approval(id)));
    for (const n of [1, 2, 3]) {
      appendFileSync(r.files.audit, `${JSON.stringify({ at: iso(Date.now()), event: "confirm", intent: id, item: "deploy", tx_hash: tx(n), fee_dust: "0.000000000000002", approval_sha256: approval })}\n`);
    }
    const result = await r.run(id);
    expect(result.state).toBe("refused");
    expect(result.refusals.at(-1)?.reason).toContain("confirmed 3 times");
    expect(r.confirmed()).toHaveLength(3);
  });

  it("rechecks daily headroom when resuming bytes whose earlier reservation aged out", async () => {
    const r = fixture({ kind: "deploy", fee: String(10n ** 13n) });
    const id = r.approve(DEPLOY);
    const approval = digest(readFileSync(r.files.approval(id)));
    const transactions = [
      { item: "deploy", tx_hash: tx(0xaa), fee_dust: "0.01", confirmed_at: iso(Date.now() - 25 * HOUR), approval_sha256: approval },
      { item: "deploy", tx_hash: tx(0xbb), fee_dust: "0.01", confirmed_at: iso(Date.now()), approval_sha256: approval },
    ];
    for (const t of transactions) appendFileSync(r.files.audit, `${JSON.stringify({ ...t, intent: id, event: "confirm", at: t.confirmed_at })}\n`);
    writeStatus(r.paths.root, { intent_id: id, state: "retrying", attempt: 1, transactions, refusals: [], updated_at: iso(Date.now()) });
    appendFileSync(r.files.audit, `${JSON.stringify({ intent: "12345678", event: "confirm", item: "other", tx_hash: tx(0xcc), fee_dust: "0.09", at: iso(Date.now()) })}\n`);
    const result = await r.run(id);
    expect(result.state).toBe("refused");
    expect(result.refusals.at(-1)?.reason).toContain("daily cap");
  });

  it("waits for the shared execution lock and rechecks DUST after it is released", async () => {
    const r = fixture();
    const id = r.approve(DEPLOY);
    appendFileSync(r.files.audit, `${JSON.stringify({ at: iso(Date.now()), event: "confirm", intent: "12345678", item: "other", tx_hash: tx(1), fee_dust: "0.09" })}\n`);
    const writer = spawn("flock", ["--exclusive", `${r.paths.root}/execution.lock`, process.execPath, "--input-type=module", "-e", `
      import { appendFileSync, writeFileSync } from "node:fs";
      const [root, ready] = process.argv.slice(1);
      writeFileSync(ready, "ready");
      await new Promise(r => setTimeout(r, 3000));
      appendFileSync(root + "/audit.jsonl", JSON.stringify({ at: new Date().toISOString(), event: "confirm", intent: "12345678", item: "other", tx_hash: "02".repeat(32), fee_dust: "0.01" }) + "\\n");
    `, r.paths.root, `${r.dir}/ready`], { stdio: "ignore" });
    const ended = once(writer, "exit");
    try {
      await vi.waitFor(() => expect(existsSync(`${r.dir}/ready`)).toBe(true), { timeout: 10_000 });
      const result = await r.run(id);
      expect(result.state).toBe("refused");
      expect(r.confirmed().filter((e) => e.intent === id)).toEqual([]);
    } finally {
      await ended;
    }
  });

  it("pins the bytes parsed as a plan to the expected digest", () => {
    const r = fixture();
    const expected = digest(readFileSync(r.template));
    expect(readAnchorPlan(r.template, expected).entries).toHaveLength(2);
    const changed = JSON.parse(readFileSync(r.template, "utf8"));
    changed.entries[1].rootHash = tx(0xef);
    writeFileSync(r.template, JSON.stringify(changed));
    expect(() => readAnchorPlan(r.template, expected)).toThrow(/sha256/);
  });

  it("gives the anchor tool the digest of the approved filled plan", async () => {
    const r = fixture({ kind: "anchor" });
    const id = r.approve(r.anchors());
    await deployJournal(r.paths.deployJournal);
    let original = "";
    let attempt = 0;
    const result = await r.run(id, (plan) => {
      if (++attempt === 1) {
        original = readFileSync(plan!, "utf8");
        const changed = JSON.parse(original);
        changed.entries[1].rootHash = tx(0xef);
        writeFileSync(plan!, JSON.stringify(changed));
      } else writeFileSync(plan!, original);
    });
    expect(result.state).toBe("done");
    expect(result.attempt).toBe(2);
    expect(r.confirmed()).toHaveLength(2);
  });
});
