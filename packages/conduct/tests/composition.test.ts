import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FileGuardLog } from "./fixtures/k1/file-log.mjs";

const CAP = 10_000_000n;
const clean = '{"asset":"lovelace","amount":"10000000","counterparty":"supplier"}';
const poison = '{"asset":"lovelace","amount":"10000000","counterparty":"supplier","note":1e999}';
const conflict = /cannot append guard event seq 0 at log length 1|EEXIST/;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });
function ledger(): string {
  const dir = mkdtempSync(join(tmpdir(), "conduct-composition-"));
  dirs.push(dir);
  return join(dir, "ledger");
}
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/k1/${name}`, import.meta.url));
const parse = (stdout: string) => stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const executed = (path: string) => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).reduce((sum, line) => sum + BigInt(line), 0n) : 0n;
const logged = (path: string) => new FileGuardLog(`${path}.log`).history();

function host(path: string, history: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["--import", "tsx", fixture("agent-host.mts"), path, clean, "durable"], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, HISTORY: history, ...env },
  });
  expect(result.status, result.stderr).toBe(0);
  return parse(result.stdout)[0];
}

function concurrentHost(path: string, barrier: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture("agent-host.mts"), path, clean, "durable"], {
      env: { ...process.env, HISTORY: "restore", BARRIER: barrier },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", status => (status === 0 ? resolve(parse(stdout)[0]) : reject(new Error(`host exited ${status}: ${stderr}`))));
  });
}

// Restarts the queue host after each crash, like a process supervisor; returns the uncaught error of every crash.
function supervise(path: string, history: string, maxRuns: number) {
  const queue = `${path}.queue.json`;
  writeFileSync(queue, JSON.stringify([clean, poison, clean, poison, clean, poison, clean]));
  const crashes: string[] = [];
  let runs = 0;
  let status: number | null;
  do {
    const result = spawnSync(process.execPath, ["--import", "tsx", fixture("queue-host.mts"), path, queue], {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, HISTORY: history },
    });
    expect(result.signal).toBeNull();
    status = result.status;
    runs++;
    if (status !== 0) crashes.push(/^\w*Error: .*$/m.exec(result.stderr)?.[0] ?? result.stderr);
  } while (status !== 0 && runs < maxRuns);
  return { runs, status, crashes };
}
const poisonCrash = "MandateError: SCHEMA_UNKNOWN_KEY: unknown action key";
const conflictCrash = "Error: cannot append guard event seq 0 at log length 1";

describe("S2: restarted hosts share one spend cap", () => {
  it("restarts that omit history are refused at construction and execute nothing", () => {
    const path = ledger();
    for (let i = 0; i < 3; i++) expect(host(path, "omit").refused).toMatch(/construct: history must be "fresh" or \{ events, head \}/);
    expect(executed(path)).toBe(0n);
    expect(logged(path).events).toHaveLength(0);
  });

  it("restarts that declare fresh against a non-empty log execute one cap", () => {
    const path = ledger();
    expect(host(path, "fresh")).toEqual({ allowed: true });
    for (let i = 0; i < 2; i++) expect(host(path, "fresh").refused).toMatch(conflict);
    expect(executed(path)).toBe(CAP);
    expect(logged(path).events.map(e => e.seq)).toEqual([0n]);
  });

  it("restarts that restore the log execute one cap and record every decision", () => {
    const path = ledger();
    expect(host(path, "restore")).toEqual({ allowed: true });
    for (let i = 0; i < 2; i++) expect(host(path, "restore")).toMatchObject({ allowed: false, reason: "SPEND_CAP_EXCEEDED" });
    expect(executed(path)).toBe(CAP);
    expect(logged(path).events.map(e => e.seq)).toEqual([0n, 1n, 2n]);
  });
});

describe("S4: two live instances on one log", () => {
  it("both restore the same position; exactly one is authorized and the other is refused", async () => {
    const path = ledger();
    const barrier = `${path}.barrier`;
    const results = await Promise.all([concurrentHost(path, barrier), concurrentHost(path, barrier)]);
    expect(results.filter(r => r.allowed === true)).toHaveLength(1);
    expect(results.filter(r => typeof r.refused === "string" && conflict.test(r.refused))).toHaveLength(1);
    expect(executed(path)).toBe(CAP);
    expect(logged(path).events.map(e => e.seq)).toEqual([0n]);
    expect(host(path, "restore")).toMatchObject({ allowed: false, reason: "SPEND_CAP_EXCEEDED" });
    expect(executed(path)).toBe(CAP);
  });
});

describe("S5: log truncation between restarts", () => {
  it("deleting recorded events cannot lower the head, so restore is refused", () => {
    const path = ledger();
    expect(host(path, "restore")).toEqual({ allowed: true });
    unlinkSync(join(`${path}.log`, "0.v8"));
    expect(host(path, "restore").refused).toMatch(/construct: recorded guard events do not end at the expected log head/);
    expect(executed(path)).toBe(CAP);
  });
});

describe("agent-forced restarts: poisoned tool calls crash a supervised host", () => {
  it("omitting history refuses every start and executes nothing", () => {
    const path = ledger();
    const omitted = 'GuardConfigError: history must be "fresh" or { events, head } from the guard event log';
    expect(supervise(path, "omit", 3)).toEqual({ runs: 3, status: 1, crashes: [omitted, omitted, omitted] });
    expect(executed(path)).toBe(0n);
  });

  it("declaring fresh on every start executes one cap", () => {
    const path = ledger();
    expect(supervise(path, "fresh", 10)).toEqual({
      runs: 7, status: 0, crashes: [poisonCrash, conflictCrash, poisonCrash, conflictCrash, poisonCrash, conflictCrash],
    });
    expect(executed(path)).toBe(CAP);
    expect(logged(path).events).toHaveLength(1);
  });

  it("restoring on every start executes one cap and records each clean call", () => {
    const path = ledger();
    expect(supervise(path, "restore", 10)).toEqual({ runs: 4, status: 0, crashes: [poisonCrash, poisonCrash, poisonCrash] });
    expect(executed(path)).toBe(CAP);
    expect(logged(path).events.map(e => e.type)).toEqual([
      "orynq.conduct.guard.action.v1", "orynq.conduct.guard.denial.v1", "orynq.conduct.guard.denial.v1", "orynq.conduct.guard.denial.v1",
    ]);
  });
});
