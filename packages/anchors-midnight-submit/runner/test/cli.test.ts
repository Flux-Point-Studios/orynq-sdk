import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fresh } from "../../test/fakes.js";
import { deployIntent } from "../confirm.js";
import { LIMITS } from "../limits.js";
import { audit, readAudit, readStatus, writeStatus } from "../state.js";
import { HOUR, iso, stateRoot } from "./helpers.js";

const LAUNCHER = new URL("../orynq-midnight-runner", import.meta.url).pathname;
const DEPLOY = deployIntent(LIMITS.payer, "0.01");

// A HOME of its own, and a systemctl stand-in first on PATH that logs its arguments and reports
// `invocation` as every unit's InvocationID and every unit inactive.
function home(invocation = "") {
  const dir = fresh("home");
  mkdirSync(`${dir}/.local/state/orynq-midnight`, { recursive: true, mode: 0o700 });
  const bin = `${dir}/bin`;
  mkdirSync(bin);
  const log = `${dir}/systemctl.log`;
  writeFileSync(
    `${bin}/systemctl`,
    `#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in\n  *InvocationID*) echo '${invocation}' ;;\n  *is-active*) echo inactive; exit 3 ;;\nesac\n`,
  );
  chmodSync(`${bin}/systemctl`, 0o755);
  const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir };
  // The paths mainnetPaths names under that HOME, in the process the launcher starts.
  const state = `${dir}/.local/state/orynq-midnight`;
  const r = stateRoot({ paths: { root: `${state}/runner`, deployJournal: `${state}/mainnet-deploy.sqlite`, anchorsJournal: `${state}/mainnet-anchors.sqlite`, planOut: `${dir}/orynq-midnight-mainnet-plan.json` } });
  return {
    env,
    paths: r.paths,
    approve: r.approve,
    anchors: r.anchors,
    approvalSha256: r.approvalSha256,
    systemctl: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

const cli = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) =>
    execFile(LAUNCHER, args, { env, encoding: "utf8", timeout: 60_000 }, (error, out, err) => resolve({ code: error ? Number(error.code) : 0, out, err })),
  );

describe("orynq-midnight-runner run", () => {
  it.each(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "CODEX_MANAGED_BY_NPM"])("refuses a process that carries %s, names it in the status and the audit log, and runs nothing", async (name) => {
    const h = home("inv-1");
    const id = h.approve(DEPLOY);
    const r = await cli({ ...h.env, INVOCATION_ID: "inv-1", [name]: "" }, "run", id);
    expect(r.code).toBe(1);
    const reason = "this process carries Claude Code or Codex environment; only systemd starts the runner, with the user manager's environment";
    expect(r.err).toContain(reason);
    expect(readStatus(h.paths.root, id)!.refusals).toEqual([{ at: expect.any(String), reason }]);
    expect(readAudit(h.paths.root).map((e) => [e.event, e.reason])).toEqual([["refused-start", reason]]);
    expect(h.systemctl()).toEqual([]);
  });

  it("refuses a process systemd did not start as that intent's unit", async () => {
    const h = home("inv-1");
    const id = h.approve(DEPLOY);
    const outside = await cli(h.env, "run", id);
    expect(outside.code).toBe(1);
    expect(outside.err).toContain("this process was not started by systemd (it has no INVOCATION_ID)");
    const other = await cli({ ...h.env, INVOCATION_ID: "inv-2" }, "run", id);
    expect(other.code).toBe(1);
    expect(other.err).toContain(`INVOCATION_ID inv-2 is not that of orynq-midnight-runner@${id}.service (inv-1)`);
    expect(h.systemctl()).toEqual([`--user show --property=InvocationID --value orynq-midnight-runner@${id}.service`]);
    expect(readStatus(h.paths.root, id)!.refusals).toHaveLength(2);
  });

  it("runs the intent through the gate when systemd started it as that intent's unit", async () => {
    const h = home("inv-1");
    const id = h.approve(DEPLOY, { approver: "codex" });
    const r = await cli({ ...h.env, INVOCATION_ID: "inv-1" }, "run", id);
    expect(r.code).toBe(0);
    expect(readStatus(h.paths.root, id)).toMatchObject({ state: "refused", refusals: [{ reason: 'the approval is not deci\'s in chat: approver "codex", approved_via "chat"' }] });
    expect(r.out).toMatch(new RegExp(`^${id} - refused attempt 0 tx - refusals 1 \\(the approval is not deci`));
  });

  it("records a run that broke off in the status and the audit log, for dispatch to start again", async () => {
    const h = home("inv-1");
    const id = h.approve(h.anchors());
    writeFileSync(h.paths.deployJournal, "not a database", { mode: 0o600 });
    const r = await cli({ ...h.env, INVOCATION_ID: "inv-1" }, "run", id);
    expect(r.code).toBe(1);
    expect(readStatus(h.paths.root, id)).toMatchObject({ state: "admitted", refusals: [{ reason: expect.stringMatching(/^the run broke off: .*not a database/) }] });
    expect(readAudit(h.paths.root).map((e) => e.event)).toEqual(["approval-seen", "failed"]);
  });
});

describe("orynq-midnight-runner dispatch", () => {
  it("does not dispatch a durable NO after snapshot loss, but dispatches its replacement", async () => {
    const h = home();
    const id = h.approve(DEPLOY);
    audit(h.paths.root, { intent: id, event: "no", approval_sha256: h.approvalSha256(id), problems: ["payer mismatch"] });
    const stopped = await cli(h.env, "dispatch");
    expect(stopped.code, stopped.err).toBe(0);
    expect(h.systemctl()).toEqual([]);
    h.approve(DEPLOY, { expires_at: iso(Date.now() + 3_600_000) });
    const replacement = await cli(h.env, "dispatch");
    expect(replacement.code, replacement.err).toBe(0);
    expect(replacement.out).toBe(`started orynq-midnight-runner@${id}.service\n`);
  });

  it("does not dispatch a used approval rewritten with other whitespace, key order or offset", async () => {
    const h = home();
    const id = h.approve(DEPLOY);
    audit(h.paths.root, { intent: id, event: "no", approval_sha256: h.approvalSha256(id), problems: ["payer mismatch"] });
    const file = `${h.paths.root}/approvals/${id}.json`;
    const approval = JSON.parse(readFileSync(file, "utf8"));
    const mountain = (at: string) => new Date(Date.parse(at) - 6 * HOUR).toISOString().replace("Z", "-06:00");
    for (const rewritten of [
      `${JSON.stringify(approval, null, 2)}\n`,
      JSON.stringify(Object.fromEntries(Object.entries(approval).reverse())),
      JSON.stringify({ ...approval, approved_at: mountain(approval.approved_at), expires_at: approval.expires_at.replace("Z", "+00:00") }),
    ]) {
      writeFileSync(file, rewritten);
      const r = await cli(h.env, "dispatch");
      expect([rewritten, r.code, r.out, h.systemctl()]).toEqual([rewritten, 0, "", []]);
    }
  });

  it("starts an approval the gate refuses before naming it once, and again only once the gate names it", async () => {
    const h = home("inv-1");
    const id = h.approve(DEPLOY, { approver: "codex" });
    // A run under an earlier approval finished.
    writeStatus(h.paths.root, { intent_id: id, state: "done", attempt: 1, approval_sha256: "00".repeat(32), transactions: [], refusals: [], updated_at: "" });
    const started = `started orynq-midnight-runner@${id}.service\n`;
    expect((await cli(h.env, "dispatch")).out).toBe(started);
    expect((await cli({ ...h.env, INVOCATION_ID: "inv-1" }, "run", id)).code).toBe(0);
    const status = readStatus(h.paths.root, id)!;
    expect([status.state, "approval_sha256" in status]).toEqual(["refused", false]);
    expect((await cli(h.env, "dispatch")).out).toBe("");
    h.approve(DEPLOY);
    expect((await cli(h.env, "dispatch")).out).toBe(started);
  });

  it("starts the unit of each approval not yet used or finished under that approval, and only those", async () => {
    const h = home();
    const unused = h.approve(DEPLOY);
    const used = h.approve(deployIntent(LIMITS.payer, "0.009"));
    writeFileSync(`${h.paths.root}/used/${used}`, "{}");
    // Dispatch starts it once; its run then records it expired.
    const expired = h.approve(deployIntent(LIMITS.payer, "0.008"), { approved_at: iso(Date.now() - 3_600_000), expires_at: iso(Date.now() - 1) });
    // Finished under this approval, then approved again.
    const finished = h.approve(deployIntent(LIMITS.payer, "0.007"));
    const reapproved = h.approve(deployIntent(LIMITS.payer, "0.006"));
    const finish = (id: string, state: "refused" | "expired", approval: string) => writeStatus(h.paths.root, { intent_id: id, state, attempt: 1, approval_sha256: approval, transactions: [], refusals: [], updated_at: "" });
    finish(finished, "refused", h.approvalSha256(finished));
    finish(reapproved, "refused", "00".repeat(32));
    const first = await cli(h.env, "dispatch");
    expect(first.code, first.err).toBe(0);
    expect(first.out.trim().split("\n")).toEqual([unused, expired, reapproved].sort().map((id) => `started orynq-midnight-runner@${id}.service`));
    const [calls, events] = [h.systemctl().length, readAudit(h.paths.root).length];
    finish(expired, "expired", h.approvalSha256(expired));
    const r = await cli(h.env, "dispatch");
    expect(r.code, r.err).toBe(0);
    const started = [unused, reapproved].sort();
    expect(h.systemctl().slice(calls)).toEqual(started.flatMap((id) => [`--user is-active --quiet orynq-midnight-runner@${id}.service`, `--user start --no-block orynq-midnight-runner@${id}.service`]));
    expect(r.out.trim().split("\n")).toEqual(started.map((id) => `started orynq-midnight-runner@${id}.service`));
    expect(readAudit(h.paths.root).slice(events).map((e) => [e.event, e.intent])).toEqual(started.map((id) => ["dispatch", id]));
    expect([used, finished].some((id) => h.systemctl().join("\n").includes(id))).toBe(false);
  });

  it("refuses a process that carries agent environment", async () => {
    const h = home();
    h.approve(DEPLOY);
    const r = await cli({ ...h.env, CLAUDECODE: "1" }, "dispatch");
    expect(r.code).toBe(1);
    expect(r.err).toContain("this process carries Claude Code or Codex environment");
    expect(h.systemctl()).toEqual([]);
  });
});

describe("orynq-midnight-runner status and check", () => {
  it("prints one line per intent: action, state, attempt, transactions, refusals and the last progress line", async () => {
    const h = home();
    const id = h.approve(DEPLOY);
    writeStatus(h.paths.root, { intent_id: id, action: "deploy", state: "retrying", attempt: 2, next_attempt_at: "2026-10-20T19:00:00.000Z", last_progress: "wallet sync at 2026-10-20T18:58:00Z, 60 s in: ...", transactions: [], refusals: [], updated_at: "" });
    writeStatus(h.paths.root, {
      intent_id: "34941c71",
      action: "anchors",
      state: "refused",
      attempt: 1,
      transactions: [{ item: "proof-run-1", tx_hash: "a0".repeat(32), fee_dust: "0.000000000000002", confirmed_at: "", approval_sha256: "" }],
      refusals: [{ at: "", reason: 'proof-run-1-hidden: attribute is "45"' }],
      updated_at: "",
    });
    const r = await cli(h.env, "status");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").sort()).toEqual([
      `34941c71 anchors refused attempt 1 tx ${"a0".repeat(8)} refusals 1 (proof-run-1-hidden: attribute is "45") | `,
      `${id} deploy retrying attempt 2 next 2026-10-20T19:00:00.000Z tx - refusals 0 | wallet sync at 2026-10-20T18:58:00Z, 60 s in: ...`,
    ]);
    expect((await cli(h.env, "status", id)).out.trim().split("\n")).toHaveLength(1);
  });

  it("checks an intent against the gate without running it, naming its sha256", async () => {
    const h = home();
    const id = h.approve(DEPLOY);
    const ok = await cli(h.env, "check", id);
    expect(ok.code).toBe(0);
    expect(ok.out.trim()).toMatch(new RegExp(`^${id} sha256 bf35fa0c0d16371a78ad26743e9d2691f6fca549571e3fa63816f0010b66a715: admitted, deploy, 1 transaction of at most 0\\.01 DUST, approval expires \\S+Z$`));
    const missing = await cli(h.env, "check", "34941c71");
    expect([missing.code, missing.out.trim()]).toEqual([1, `34941c71: refused, no intent ${h.paths.root}/intents/34941c71.json`]);
    expect(readAudit(h.paths.root)).toEqual([]);
  });

  it("names its commands when given another, or an intent id that is not 8 lowercase hex characters", async () => {
    const usage = "usage: orynq-midnight-runner status [<intent id>] | check <intent id> | dispatch | run <intent id>";
    const h = home();
    for (const args of [["approve", "bf35fa0c"], ["check", "../../x"], ["status", "BF35FA0C"], ["run"], ["dispatch", "bf35fa0c"], ["check", "bf35fa0c", "now"]]) {
      const r = await cli(h.env, ...args);
      expect([args, r.code, r.err.trim()]).toEqual([args, 2, usage]);
    }
  });
});
