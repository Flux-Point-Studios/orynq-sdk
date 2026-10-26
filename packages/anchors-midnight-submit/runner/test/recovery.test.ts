import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { deployIntent, driveTool } from "../confirm.js";
import { admit } from "../gate.js";
import { LIMITS } from "../limits.js";
import { runIntent } from "../run.js";
import { audit, readAudit, readStatus } from "../state.js";
import { HOUR, iso, stateRoot } from "./helpers.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});
vi.mock("../confirm.js", async (original) => ({ ...await original<typeof import("../confirm.js")>(), driveTool: vi.fn() }));

const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const tx = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const intent = deployIntent(LIMITS.payer, "0.01");
const PACKAGE = new URL("../..", import.meta.url).pathname;
type Driver = Parameters<typeof driveTool>[0];
let calls: Driver[] = [];
let decisions: boolean[] = [];

function summary(n = 170, fee = "0.01", payer = LIMITS.payer) {
  return [`network ${LIMITS.network}`, `authority ${LIMITS.deploy.authority}: immutable`, ...Object.entries(LIMITS.deploy.verifierKeys).map(([k, v]) => `${k.padEnd(16)} vk sha256 ${v}`), `paid from ${payer}`, `fee (declared) ${fee} DUST, all of it burned`, `valid until ${iso(Date.now() + 600_000)}`, `deploy tx hash ${tx(n)}`].join("\n");
}

function drive(steps: ((d: Driver) => { code: number; answers?: { token: string; confirmed: boolean; problems: string[] }[] })[] = []) {
  vi.mocked(driveTool).mockImplementation((d) => {
    calls.push(d);
    const result = steps[calls.length - 1]?.(d) ?? { code: 0 };
    return { exited: Promise.resolve({ answers: [], ...result }), stop: () => undefined };
  });
}
// Answers one prompt as driveTool does: the runner's decision, and its NO hook before a NO.
function answer(d: Driver, text = summary(), n = 170) {
  const decision = d.decide(text, tx(n).slice(0, 16));
  decisions.push(decision.problems.length === 0);
  if (decision.problems.length > 0) d.onNo!(decision);
  return { code: decision.problems.length ? 1 : 0, answers: [{ token: `DEPLOY ${tx(n).slice(0, 16)}`, confirmed: decision.problems.length === 0, problems: decision.problems }] };
}
function run(r: ReturnType<typeof stateRoot>, id: string) {
  return runIntent({ paths: r.paths, id, cwd: PACKAGE, env: {}, tool: () => ["never-executed"], backoffMs: [1], pollMs: 1 });
}

beforeEach(() => { calls = []; decisions = []; vi.clearAllMocks(); drive(); });
afterEach(() => vi.restoreAllMocks());

describe("approval consumption across interruptions and replacement", () => {
  it("permits a fresh run of a replacement received between attempts", async () => {
    const r = stateRoot(); const id = r.approve(intent);
    drive([() => { r.approve(intent, { expires_at: iso(Date.now() + HOUR) }); return { code: 1 }; }]);
    expect((await run(r, id)).state).toBe("refused");
    expect(fs.existsSync(r.files.used(id))).toBe(false);
    expect(admit(r.paths, id, Date.now())).toMatchObject({ ok: true });
  });
  it("a run stopped by approval replacement does not consume the new approval", async () => {
    const r = stateRoot(); const id = r.approve(intent);
    const original = hash(fs.readFileSync(r.files.approval(id)));
    drive([d => { r.approve(intent, { expires_at: iso(Date.now() + HOUR) }); return answer(d); }]);
    const stopped = await run(r, id);
    expect(stopped.state).toBe("refused");
    expect(decisions).toEqual([false]);
    expect(hash(fs.readFileSync(r.files.approval(id)))).not.toBe(original);
    expect(admit(r.paths, id, Date.now())).toMatchObject({ ok: true });
    calls = []; decisions = []; drive([d => answer(d)]);
    expect((await run(r, id)).state).toBe("done");
    expect(decisions).toEqual([true]);
    expect(admit(r.paths, id, Date.now())).toMatchObject({ ok: false, reason: expect.stringContaining("already used") });
  });
  it.each([false, true])("keeps a terminal NO terminal after interruption before the used marker (lost snapshot: %s)", async (lostSnapshot) => {
    const r = stateRoot(); const id = r.approve(intent);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.appendFileSync).mockImplementation((file, value, options) => {
      if (typeof value === "string" && value.includes('"event":"run-end"')) throw new Error("simulated interruption after NO");
      return actual.appendFileSync(file, value, options);
    });
    drive([d => answer(d, summary(170, "0.01", "synthetic-other-payer"))]);
    await expect(run(r, id)).rejects.toThrow("simulated interruption");
    vi.mocked(fs.appendFileSync).mockImplementation(actual.appendFileSync);
    expect(readAudit(r.paths.root).some(e => e.event === "no")).toBe(true);
    expect(fs.existsSync(r.files.used(id))).toBe(false);
    expect(readStatus(r.paths.root, id)?.state).toBe("running");
    if (lostSnapshot) fs.rmSync(r.files.status(id));
    calls = []; decisions = []; drive([d => answer(d)]);
    const resumed = await run(r, id);
    expect({ state: resumed.state, toolCalls: calls.length, decisions }).toEqual({ state: "refused", toolCalls: 0, decisions: [] });
  });

  it("keeps an earlier approval consumed after its replacement finishes", async () => {
    const r = stateRoot(); const id = r.approve(intent);
    const original = fs.readFileSync(r.files.approval(id));
    drive([d => { r.approve(intent, { expires_at: iso(Date.now() + HOUR) }); return answer(d); }]);
    expect((await run(r, id)).state).toBe("refused");
    calls = []; decisions = []; drive([d => answer(d)]);
    expect((await run(r, id)).state).toBe("done");
    fs.writeFileSync(r.files.approval(id), original);
    calls = []; decisions = []; drive([d => answer(d)]);
    expect((await run(r, id)).state).toBe("refused");
    expect(calls).toHaveLength(0);
  });

  it("counts earlier confirmations against the daily cap for a replacement", async () => {
    const r = stateRoot(); const id = r.approve(intent);
    audit(r.paths.root, { event: "confirm", intent: id, item: "deploy", tx_hash: tx(169), fee_dust: "0.01", valid_until: iso(Date.now() + 600_000), approval_sha256: r.approvalSha256(id) });
    r.confirmed("12345678", tx(168), "0.09");
    drive([d => { r.approve(intent, { expires_at: iso(Date.now() + HOUR) }); return answer(d); }]);
    expect((await run(r, id)).state).toBe("refused");
    expect(admit(r.paths, id, Date.now())).toMatchObject({ ok: true });
    calls = []; decisions = []; drive([d => answer(d)]);
    const replacement = await run(r, id);
    expect(replacement.state).toBe("refused");
    expect(replacement.refusals.at(-1)?.reason).toContain("daily cap");
    expect(decisions).toEqual([false]);
  });
});
