import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize } from "node:v8";
import { afterEach, expect, it } from "vitest";

const dirs: string[] = [];
function ledger(): string {
  const dir = mkdtempSync(join(tmpdir(), "conduct-k1-"));
  dirs.push(dir);
  return join(dir, "ledger");
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });
const clean = '{"asset":"lovelace","amount":"10000000","counterparty":"supplier"}';
const poison = '{"asset":"lovelace","amount":"10000000","counterparty":"supplier","note":1e999}';
function host(name: "agent" | "control", path: string, json: string, mode = "legacy") {
  return spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL(`./fixtures/k1/${name}-host.mts`, import.meta.url)), path, json, mode], {
    encoding: "utf8", timeout: 20_000, maxBuffer: 100_000,
  });
}
it("K1 control-host: one payment, two trace events, clean exit", () => {
  const path = ledger();
  const result = host("control", path, clean);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('"recordedEvents":2');
  expect(readFileSync(path, "utf8")).toBe("10000000\n");
});
it("K1 agent-host: three poisoned restarts cannot execute three caps or crash", () => {
  const path = ledger();
  for (let i = 0; i < 3; i++) {
    const result = host("agent", path, poison);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"refused":');
    expect(result.stdout).toContain('"recordedEvents":0');
  }
  expect(existsSync(path)).toBe(false);
});
it("K2 agent-host: poisoned denial rejects safely and clean denial is recorded", () => {
  const path = ledger();
  const bad = host("agent", path, poison.replace("supplier", "mallory"));
  expect(bad.status, bad.stderr).toBe(0);
  expect(bad.stdout).toContain('"refused":');
  const good = host("agent", path, clean.replace("supplier", "mallory"), "durable");
  expect(good.status, good.stderr).toBe(0);
  expect(good.stdout).toContain('"reason":"COUNTERPARTY_NOT_ALLOWED"');
  expect(good.stdout).toContain('"recordedEvents":1');
  expect(existsSync(path)).toBe(false);
});
it("K1 durable agent-host: three restarted guards share one cap and retain all evidence", () => {
  const path = ledger();
  for (let i = 0; i < 3; i++) {
    const result = host("agent", path, clean, "durable");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`"allowed":${i === 0}`);
    expect(result.stdout).toContain('"recordedEvents":1');
  }
  expect(readFileSync(path, "utf8")).toBe("10000000\n");
  const events = deserialize(readFileSync(`${path}.events`));
  expect(events.map((e: { seq: bigint }) => e.seq)).toEqual([0n, 1n, 2n]);
});
it("F3 agent-host: failed async trace and sync misuse never execute an effect", () => {
  const path = ledger();
  for (const mode of ["closed", "sync"]) {
    const result = host("agent", path, clean, mode);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"refused":');
    expect(existsSync(path)).toBe(false);
  }
});
