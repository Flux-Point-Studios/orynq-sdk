import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseStandingConfig, runStandingLoops } from "../standing-service.js";

const roots: string[] = [];
const config = () => ({ mode: "observe", network: "mainnet", genesis: "01".repeat(32), registry: "438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736", author: "02".repeat(32),
  stateRoot: "/fixture/state", materiosRpcUrl: "https://materios.example/rpc", midnightReadRpcUrl: "https://midnight.example/rpc", knownAuthorsFile: "/fixture/authors.json",
  wallet: { mnemonic: "/fixture/mnemonic", record: "/fixture/record", state: "/fixture/wallet.state", blockfrost: "/fixture/blockfrost", zk: "/fixture/zk", author: "/fixture/author" },
  stores: [{ url: "https://store-a.example/proofs", keyFile: "/fixture/store-a" }, { url: "https://store-b.example/proofs", keyFile: "/fixture/store-b" }] });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("accepts exact explicit configuration and keeps endpoint path prefixes", () => {
  const input = config(), parsed = parseStandingConfig(input);
  expect(parsed).toEqual(input); input.stores[0]!.url = "https://changed.example";
  expect(parsed.stores[0]!.url).toBe("https://store-a.example/proofs");
});

it("refuses scope changes, extra knobs and credential-bearing URLs", () => {
  for (const input of [{ ...config(), registry: "ff".repeat(32) }, { ...config(), maxDailyDust: "1" }, { ...config(), mode: "deploy" },
    { ...config(), midnightReadRpcUrl: "https://name:secret@midnight.example" }, { ...config(), materiosRpcUrl: "https://materios.example/?token=secret" },
    { ...config(), stores: [config().stores[0]] }, { ...config(), stateRoot: "relative/state" }, { ...config(), wallet: { ...config().wallet, salt: "/fixture/salt" } }]) {
    expect(() => parseStandingConfig(input)).toThrow();
  }
});

it("refuses agent-driven mainnet anchoring before any credential or shared-state access", () => {
  const root = mkdtempSync(join(tmpdir(), "standing-service-refusal-")); roots.push(root);
  const path = join(root, "config.json"); writeFileSync(path, JSON.stringify({ ...config(), mode: "anchor", stateRoot: join(root, "must-not-exist") }), { mode: 0o600 });
  const result = spawnSync(process.execPath, ["--import", "tsx", "runner/standing-service.ts", "--config", path], { env: { ...process.env, CODEX_CI: "1" }, encoding: "utf8", timeout: 120_000 });
  expect(result.status).toBe(1); expect(result.stderr).toMatch(/agent.*mainnet|mainnet.*agent/i);
  expect(result.stderr).not.toContain("secret"); expect(result.stderr).not.toContain("ENOENT");
  expect(existsSync(join(root, "must-not-exist"))).toBe(false);
}, 150_000);

it("excludes a second real service process while the original inherited lock remains open", () => {
  const root = mkdtempSync(join(tmpdir(), "standing-service-lock-")); roots.push(root);
  const path = join(root, "config.json"); writeFileSync(path, JSON.stringify({ ...config(), network: "preprod", stateRoot: root }), { mode: 0o600 });
  const fd = openSync(join(root, "execution.lock"), "wx+", 0o600);
  const child = () => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    'import {readFileSync} from "node:fs"; import {parseStandingConfig,runStandingService} from "./runner/standing-service.ts"; try {await runStandingService(parseStandingConfig(JSON.parse(readFileSync(process.argv[1],"utf8"))));} catch(error) {console.error(error.message); process.exitCode=1;}', path], { encoding: "utf8", timeout: 120_000 });
  try {
    expect(spawnSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", fd] }).status).toBe(0);
    const blocked = child(); expect(blocked.status).toBe(1); expect(blocked.stderr).toContain("Shared standing wallet lock is unavailable");
    expect(existsSync(join(root, "follower.sqlite"))).toBe(false);
  } finally { closeSync(fd); }
  const available = child(); expect(available.status).toBe(1); expect(available.stderr).toContain("Standing signed author policy is unreadable");
}, 270_000);

it("keeps following during slow proof preparation and drains it before returning", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  let followed = 0, prepared = 0, release: (() => void) | undefined;
  const catchup = { turn: async () => { followed++; return { state: "idle" as const }; } };
  const controller = { turn: async () => { prepared++; await new Promise<void>(resolve => { release = resolve; }); return { state: "waiting" as const }; } };
  let completed = false;
  const running = runStandingLoops({ catchup, controller, abort, publish: () => {}, hold: () => {} }).then(() => { completed = true; });
  try {
    await vi.advanceTimersByTimeAsync(15_001); expect(prepared).toBe(1);
    await vi.advanceTimersByTimeAsync(125_000); expect(followed).toBe(3); expect(prepared).toBe(1);
    abort.abort(); await vi.advanceTimersByTimeAsync(1); expect(completed).toBe(false);
    release!(); await running; expect(completed).toBe(true);
  } finally { abort.abort(); release?.(); await Promise.allSettled([running]); vi.useRealTimers(); }
});

it("aborts and drains the sibling loop before propagating a fatal failure", async () => {
  vi.useFakeTimers(); const abort = new AbortController(); let followed = 0;
  const running = runStandingLoops({ abort, catchup: { turn: async () => { followed++; return { state: "idle" as const }; } },
    controller: { turn: async () => { throw new Error("restart required: uncertain preparation"); } }, publish: () => {}, hold: () => {} });
  const rejected = expect(running).rejects.toThrow(/restart required/);
  try { await vi.advanceTimersByTimeAsync(15_001); await rejected; expect(abort.signal.aborted).toBe(true); expect(followed).toBeGreaterThan(0); }
  finally { abort.abort(); vi.useRealTimers(); }
});

it("reports each loop start and completion separately while a controller is busy",async()=>{
  vi.useFakeTimers();const abort=new AbortController(),events:unknown[][]=[];let release:(()=>void)|undefined;
  const running=runStandingLoops({abort,catchup:{turn:async()=>({state:"idle"})},controller:{turn:async()=>{await new Promise<void>(resolve=>{release=resolve;});return {state:"idle"};}},publish:(...event)=>{events.push(event);},hold:()=>{}});
  try {await vi.advanceTimersByTimeAsync(120_001);
    expect(events.some(event=>event[2]==="controller"&&event[3]==="start")).toBe(true);
    expect(events.filter(event=>event[2]==="follower"&&event[3]==="success").length).toBeGreaterThan(2);
    expect(events.some(event=>event[2]==="controller"&&event[3]==="success")).toBe(false);
  }finally{abort.abort();release?.();await running;vi.useRealTimers();}
});

it("batches idle reads for sixty seconds while draining catchup immediately and retrying failures promptly",async()=>{
  vi.useFakeTimers();const abort=new AbortController(),starts:number[]=[];
  const catchup={turn:vi.fn(async()=>{starts.push(Date.now());if(starts.length===1)throw new Error("temporary read refusal");return {state:starts.length===2?"progress":"idle"};})};
  const running=runStandingLoops({abort,catchup,publish:()=>{},hold:()=>{}});
  try{
    await vi.advanceTimersByTimeAsync(4_999);expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10);expect(starts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(59_999);expect(starts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);expect(starts).toHaveLength(4);expect(starts[3]!-starts[2]!).toBe(60_000);
  }finally{abort.abort();await running;vi.useRealTimers();}
});

it("records a fatal controller hold before draining and preserves its typed cause",async()=>{
  vi.useFakeTimers();const abort=new AbortController(),cause=new Error("fixture cause"),held:unknown[][]=[];
  const fatal=new Error("process restart required",{cause});
  const running=runStandingLoops({abort,catchup:{turn:async()=>({state:"idle"})},controller:{turn:async()=>{throw fatal;}},publish:()=>{},hold:(...event)=>{held.push(event);}});
  const rejected=expect(running).rejects.toBe(fatal);
  try {await vi.advanceTimersByTimeAsync(15_001);await rejected;expect(held).toContainEqual([fatal,"controller"]);}
  finally{abort.abort();vi.useRealTimers();}
});
