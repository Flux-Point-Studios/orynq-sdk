import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { openJournal } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { deployIntent } from "../confirm.js";
import { LIMITS } from "../limits.js";
import { runIntent } from "../run.js";
import { audit, readAudit } from "../state.js";
import { stateRoot } from "./helpers.js";

const PACKAGE = new URL("../..", import.meta.url).pathname;
const TX = "aa".repeat(32);
function setup(extra: Record<string, unknown> = {}) {
  const r = stateRoot();
  const id = r.approve(deployIntent(LIMITS.payer, "0.01"));
  const record = `${r.dir}/typed.jsonl`, runs = `${r.dir}/runs`;
  const run = () => runIntent({ paths: r.paths, id, cwd: PACKAGE, env: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_TOOL: JSON.stringify({ kind: "deploy", runs, record, ...extra }) },
    tool: () => [process.execPath, "--import", "tsx", "runner/test/fake-tool.ts"], backoffMs: [1] });
  return { ...r, id, record, runs, run, typed: () => existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [] };
}

describe("runner security review regressions", () => {
  it("holds new bytes when an earlier confirmation's journal row was rolled back", async () => {
    const r = setup();
    openJournal(r.paths.deployJournal).close();
    audit(r.paths.root, { intent: r.id, event: "confirm", item: "deploy", tx_hash: "bb".repeat(32), fee_dust: "0.000000000000002", approval_sha256: r.approvalSha256(r.id) });
    const status = await r.run();
    expect(status.state).toBe("refused");
    expect(status.refusals[0]!.reason).toMatch(/journal no longer accounts/);
    expect(r.typed().map((entry) => entry.confirmed)).toEqual([false]);
  });

  it("rejects an unbounded transaction deadline before recording any confirmation", async () => {
    const r = setup({ ttl: "9999-12-31T23:59:59.000Z" });
    const status = await r.run();
    expect(status.state).toBe("refused");
    expect(readAudit(r.paths.root).filter((event) => event.event === "confirm")).toEqual([]);
    expect(r.typed().map((entry) => entry.confirmed)).toEqual([false]);
  });

  it("refuses recovery of a confirmation without its approval identity before spawning the tool", async () => {
    const r = setup();
    audit(r.paths.root, { intent: r.id, event: "confirm", item: "deploy", tx_hash: TX, fee_dust: "0.01" });
    expect((await r.run()).refusals[0]!.reason).toMatch(/lacks its approval identity/);
    expect(existsSync(r.runs)).toBe(false);
  });

  it("does not confirm when approval expires between its audit write and the final check", async () => {
    const r = setup();
    const expires = Date.parse(JSON.parse(readFileSync(r.files.approval(r.id), "utf8")).expires_at);
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, "now").mockImplementation(() => readAudit(r.paths.root).some((event) => event.event === "confirm") ? expires + 1 : realNow());
    try {
      const status = await r.run();
      expect(status.state).toBe("expired");
      expect(r.typed().map((entry) => entry.confirmed)).toEqual([false]);
    } finally { spy.mockRestore(); }
  });

  it("joins split progress lines and preserves the last unterminated line on exit", async () => {
    const r = setup();
    const status = await runIntent({ paths: r.paths, id: r.id, cwd: PACKAGE, env: { PATH: process.env.PATH },
      tool: () => [process.execPath, "-e", 'process.stdout.write("Syncing wal"); setTimeout(() => process.stdout.write("let\\nfinal tail"), 10);'] });
    expect(status.last_progress).toBe("final tail");
    expect(readFileSync(r.files.log(r.id), "utf8")).toContain("Syncing wallet\nfinal tail");
  });
});
