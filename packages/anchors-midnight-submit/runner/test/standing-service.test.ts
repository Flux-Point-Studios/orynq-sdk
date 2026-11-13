import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { errorChain, holdLine, parseStandingConfig, printChanges, redact, redactionWork, runStandingLoops } from "../standing-service.js";
import { StandingFeeCap } from "../standing-budget.js";

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

it("names why it stopped, and never what a refused file holds", () => {
  const root = mkdtempSync(join(tmpdir(), "standing-service-stop-")); roots.push(root);
  const authors = join(root, "authors.json"); writeFileSync(authors, "[]"); chmodSync(authors, 0o644);
  const path = join(root, "config.json"); writeFileSync(path, JSON.stringify({ ...config(), network: "preprod", stateRoot: root, knownAuthorsFile: authors }), { mode: 0o600 });
  const run = () => spawnSync(process.execPath, ["--import", "tsx", "runner/standing-service.ts", "--config", path], { encoding: "utf8", timeout: 120_000 });
  const refused = run();
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain(`Standing signed author policy is unreadable: ${authors} can be read or written by group or others`);
  writeFileSync(authors, "abandon ability able"); chmodSync(authors, 0o600);
  const policy = run();
  expect(policy.status).toBe(1); expect(policy.stderr).toContain("Standing signed author policy is not JSON"); expect(policy.stderr).not.toContain("abandon");
  writeFileSync(path, "abandon ability able");
  const garbled = run();
  expect(garbled.status).toBe(1); expect(garbled.stderr).toContain("Standing configuration is not JSON"); expect(garbled.stderr).not.toContain("abandon");
}, 270_000);

it("prints why it stopped on one bounded line, whatever text a cause carries", () => {
  const path = join(tmpdir(), "forged\nline", "q".repeat(200), "r".repeat(200), "s".repeat(200), "config.json");
  const result = spawnSync(process.execPath, ["--import", "tsx", "runner/standing-service.ts", "--config", path], { encoding: "utf8", timeout: 120_000 });
  const printed = result.stderr.trimEnd(), prefix = "Standing configuration is unreadable: ";
  expect(result.status).toBe(1);
  expect(printed.startsWith(prefix)).toBe(true); expect(printed).not.toContain("\n"); expect(printed).toContain("forged line");
  expect(printed.length).toBe(prefix.length + 512);
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

it("logs a source hold with every message and type in its cause chain", () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
  const error = new Error("Standing reservation failed", { cause: new TypeError("fetch failed", { cause: new StandingFeeCap("fixture cap", { cause: refused }) }) });
  expect(JSON.parse(holdLine("standing-hold", "controller", "source", error, []))).toEqual({ event: "standing-hold", loop: "controller", reason: "source", causes: [
    { name: "Error", message: "Standing reservation failed" }, { name: "TypeError", message: "fetch failed" },
    { name: "StandingFeeCap", message: "fixture cap" }, { name: "Error", message: "connect ECONNREFUSED 127.0.0.1:443" }] });
  expect(JSON.parse(holdLine("standing-startup-hold", "follower", "source", "a thrown string", []))).toEqual({ event: "standing-startup-hold", loop: "follower", reason: "source", causes: [{ name: "string", message: "" }] });
});

it("keeps credentials, query strings, project ids and long hex out of a logged cause chain, and keeps what locates the failure", () => {
  const projectId = "mainnet" + "Q7".repeat(16), hash = "0a".repeat(32);
  const error = new Error(`upstream https://name:secret@rpc.example/v0/blocks?api_key=hidden#frag refused ${hash}`,
    { cause: new Error(`headers {"project_id":"${projectId}"}\nforged line`, { cause: Object.assign(new Event("error"), { message: "socket text" }) }) });
  const chain = errorChain(error, []), printed = JSON.stringify(chain);
  expect(chain).toEqual([{ name: "Error", message: "upstream https://rpc.example/v0/blocks refused [redacted]" },
    { name: "Error", message: 'headers {"project_id":"[redacted]"} forged line' }, { name: "Event", message: "" }]);
  for (const secret of ["secret", "name:", "hidden", "frag", projectId, hash, "socket text"]) expect(printed).not.toContain(secret);
  expect(errorChain(new Error("connect ECONNREFUSED 127.0.0.1:443 at block 3346139"), [])).toEqual([{ name: "Error", message: "connect ECONNREFUSED 127.0.0.1:443 at block 3346139" }]);
});

const pid = "mainnet" + "Q7".repeat(16);
it.each<[string, string, string]>([
  ["an uppercase scheme's userinfo", "HTTPS://user:SECRETPW@h.example/x", "SECRETPW"],
  ["an uppercase scheme's query", "Https://h.example/x?api_key=SECRETQ", "SECRETQ"],
  ["userinfo whose password holds an @", "https://user:SEC@RETPW@h.example/x", "RETPW"],
  ["userinfo under any scheme", "postgres://user:SECRETPG@db.example/x", "SECRETPG"],
  ["scheme-less userinfo", "connect user:SECRETNS@db.example:5432 refused", "SECRETNS"],
  ["a token-like path segment", "https://rpc.example/v1/SECRETPATHKEY0123456789abcdef/ws", "SECRETPATHKEY0123456789abcdef"],
  ["a capability path prefix", "http://127.0.0.1:41234/0123456789abcdef0123456789abcdef/graphql", "0123456789abcdef0123456789abcdef"],
  ["a Bearer header", "request headers: Authorization: Bearer SECRETBEARERTOKEN", "SECRETBEARERTOKEN"],
  ["a bare key=value", "x-api-key=SECRETAPIKEY", "SECRETAPIKEY"],
  ["token, secret, password and auth values", "token=SECRETTOK secret: SECRETSEC password=SECRETPWD auth=SECRETAUTH", "SECRETTOK|SECRETSEC|SECRETPWD|SECRETAUTH"],
  ["a JWT", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", "eyJhbGciOiJIUzI1NiJ9|SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
  ["a hex private key", "key " + "7f3a".repeat(16), "7f3a".repeat(16)],
  ["mnemonic words", "bad seed abandon ability able about above absent absorb abstract absurd abuse access accident", "abandon|absurd|accident"],
  ["a percent-encoded project id", `project_id%3D${pid}`, pid],
  ["a project id between JSON unicode escapes", `\\u0022${pid}\\u0022`, pid],
  ["a project id with a suffix", `${pid}_x`, pid],
  ["a project id after a digit", `9${pid}`, pid],
  ["a project id in a URL path", `https://h.example/${pid}x/`, pid],
])("redacts %s", (_, message, secrets) => {
  const printed = JSON.stringify(errorChain(new Error(message), []));
  for (const secret of secrets.split("|")) expect(printed).not.toContain(secret);
});

// A limit on how long a key name, a scheme or a user name may be is a limit on what is redacted:
// gluing a long word in front must not carry the secret past it.
const glue = "w".repeat(80), jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
it.each<[string, string, string]>([
  ["a key name glued to a long word", `${glue}api_key=SECRETGLUEDKEY`, "SECRETGLUEDKEY"],
  ["a key name with a long suffix", `api_key_${glue}=SECRETLONGNAME`, "SECRETLONGNAME"],
  ["a key name after another name's separator", "status:token=SECRETAFTERSEP", "SECRETAFTERSEP"],
  ["a scheme glued to a long word, its userinfo", `${glue}https://user:SECRETGLUEDPW@h.example/x`, "SECRETGLUEDPW|user:"],
  ["a scheme glued to a long word, its query", `${glue}https://h.example/x?sig=SECRETGLUEDQ`, "SECRETGLUEDQ"],
  ["a scheme longer than any registered one", `${"s".repeat(40)}://user:SECRETLONGSCHEME@h.example/x`, "SECRETLONGSCHEME"],
  ["a JWT glued to a word character", `x${jwt}`, "eyJhbGciOiJIUzI1NiJ9|eyJzdWIiOiIxIn0|SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
  ["a JWT glued to a dotted name", `session.id_${jwt}`, "eyJhbGciOiJIUzI1NiJ9|eyJzdWIiOiIxIn0|SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
  ["a JWT cut after its payload", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0", "eyJhbGciOiJIUzI1NiJ9|eyJzdWIiOiIxIn0"],
  ["scheme-less userinfo with a long user name", `connect ${"u".repeat(300)}:SECRETLONGUSER@db.example refused`, "SECRETLONGUSER"],
  ["scheme-less userinfo after a slash", "connect db/user:SECRETSLASH@db.example refused", "SECRETSLASH"],
  ["scheme-less userinfo whose password holds an @", "connect user:SECRETAT@TAILPW@db.example refused", "SECRETAT|TAILPW"],
  ["a Bearer value glued to a word character", "xBearer SECRETGLUEDBEARER", "SECRETGLUEDBEARER"],
  ["a hex private key glued to a word character", "x" + "7f3a".repeat(16), "7f3a"],
  ["a hex private key after an underscore", "key_" + "7f3a".repeat(16), "7f3a"],
  ["a project id glued to a long word", `${"w".repeat(40)}${pid}`, pid.slice(7)],
])("redacts %s", (_, message, secrets) => {
  const printed = JSON.stringify(errorChain(new Error(message), []));
  for (const secret of secrets.split("|")) expect(printed).not.toContain(secret);
});

// Shapes of a secret no configuration names.
it.each<[string, string, string]>([
  ["63 hex characters", "seed " + "7f3a".repeat(16).slice(1), "7f3a"],
  ["a hex echo cut to 40 characters", "seed " + "7f3a".repeat(10), "7f3a"],
  ["a 0x hex echo cut to 40 characters", "seed 0x" + "7f3a".repeat(10), "7f3a"],
  ["unpadded base64 of 32 bytes", "secret is c2VjcmV0S2V5TWF0ZXJpYWwwMTIzNDU2Nzg5QUJDREVGR0g", "c2VjcmV0S2V5TWF0ZXJpYWwwMTIzNDU2Nzg5QUJDREVGR0g"],
  ["padded base64", "secret is c2VjcmV0S2V5TWF0ZXJpYWwwMTIzNDU2Nzg5QUJDREU=", "c2VjcmV0S2V5TWF0ZXJpYWwwMTIzNDU2Nzg5QUJDREU"],
  ["upper-case mnemonic words", "bad seed ABANDON ABILITY ABLE ABOUT ABOVE ABSENT ABSORB", "ABANDON|ABSENT|ABSORB"],
  ["capitalised mnemonic words", "bad seed Abandon Ability Able About Above Absent Absorb", "Abandon|Absent|Absorb"],
  ["a letters-only path token of 32 characters", `https://rpc.example/v1/${"SecretPathLetter".repeat(2)}/ws`, "SecretPathLetter"],
])("redacts %s", (_, message, secrets) => {
  const printed = JSON.stringify(errorChain(new Error(message), []));
  for (const secret of secrets.split("|")) expect(printed).not.toContain(secret);
});

it.each<[string]>([
  ["connect ECONNREFUSED 127.0.0.1:443 at block 3346139"],
  ["Standing signed author policy is unreadable: /tmp/standing-service-stop-Ab3xYz/authors.json can be read or written by group or others"],
  ["mail ops@example.com at 12:30:05 about rpc.example.com"],
  ["read https://rpc.example.com:8443/api/v0/blocks/latest failed with HTTP 503"],
  ["packages/anchors-midnight-ledger9-write-path.md names keyJournal.sqlite and a balance of 340282366920938463463374607431768211455"],
  [`a ${"q".repeat(200)} word and a.b.c`],
])("keeps what locates a failure: %s", message => {
  expect(errorChain(new Error(message), [])).toEqual([{ name: "Error", message }]);
});

it("cuts the redaction window at its last space, tab or line break, and prints nothing of a text with none", () => {
  const hex = "7f3a".repeat(16);
  for (const gap of [" ", "\t", "\n", "\r\n"]) {
    const printed = JSON.stringify(errorChain(new Error(`head${gap}${"z ".repeat(2280)}${gap}${hex}`), []));
    expect(printed).toContain("head"); expect(printed).not.toContain(hex.slice(0, 16));
  }
  expect(errorChain(new Error("z".repeat(4600) + hex), [])).toEqual([{ name: "Error", message: "" }]);
});

it("redacts the error name and every link of the cause chain", () => {
  const inner = new Error("ok"); inner.name = "Bearer SECRETNAME";
  expect(JSON.stringify(errorChain(new Error("outer", { cause: new Error("mid", { cause: inner }) }), []))).not.toContain("SECRETNAME");
});

it("redacts each configured secret by value, raw, percent-encoded and JSON-escaped, whatever surrounds it", () => {
  const key = "store-key/with+chars&more", prefix = "0123456789abcdef0123456789abcdef", short = "9f2c";
  const message = `a${key}b ${encodeURIComponent(key)} ${JSON.stringify(key)} relay${prefix}x ${short}`;
  const printed = JSON.stringify(errorChain(new Error(message), [key, prefix, short]));
  for (const secret of [key, encodeURIComponent(key), prefix]) expect(printed).not.toContain(secret);
  expect(printed).toContain(short);
});

it("never throws: a link it cannot read makes the whole chain unprintable", () => {
  const numeric = Object.assign(new Error(), { message: 123 as unknown as string });
  expect(errorChain(new Error("wrap", { cause: numeric }), [])).toEqual([{ name: "Error", message: "wrap" }, { name: "Error", message: "123" }]);
  const nameless = new Error("m"); (nameless as { name: unknown }).name = undefined;
  expect(errorChain(nameless, [])).toEqual([{ name: "Error", message: "m" }]);
  const hostile = new Proxy({}, { get() { throw new Error("trap"); }, getPrototypeOf() { throw new Error("trap"); } });
  expect(errorChain(Object.assign(new Error(), { message: Symbol("s") as unknown as string }), [])).toEqual([{ name: "Error", message: "Symbol(s)" }]);
  const unstringable = Object.assign(new Error(), { message: { toString() { throw new Error("trap"); } } as unknown as string });
  for (const error of [hostile, new Error("wrap", { cause: hostile }), unstringable]) {
    expect(errorChain(error, [])).toBe("unprintable");
    expect(JSON.parse(holdLine("standing-hold", "controller", "source", error, []))).toEqual({ event: "standing-hold", loop: "controller", reason: "source", causes: "unprintable" });
  }
});

it("bounds a logged cause chain to eight links of 512 characters", () => {
  let error: Error = new Error("x".repeat(2000));
  for (let depth = 0; depth < 12; depth++) error = new Error(`link ${depth}`, { cause: error });
  const chain = errorChain(error, []) as { message: string }[];
  expect(chain).toHaveLength(8); expect(chain[0]!.message).toBe("link 11");
  const long = (errorChain(new Error("y".repeat(2000)), []) as { message: string }[])[0]!;
  expect(long.message).toHaveLength(512);
});

it("prints a line once per change, and again after a different line", () => {
  const lines: string[] = [], print = printChanges(line => lines.push(line));
  const held = (message: string) => holdLine("standing-hold", "controller", "source", new Error(message), []);
  print(held("first")); print(held("first")); print(held("second")); print("progress"); print(held("second"));
  expect(lines).toEqual([held("first"), held("second"), "progress", held("second")]);
});

// What bounds a redaction is the work it does, which no clock on a shared runner measures: each
// distinct form of a configured secret is one pass over the text, and every shape rule reads the
// same bounded window however long the text is. So the cost grows with the text's length times
// the configured values, never with its square.
const MB = 1_000_000;
it.each<[string, (size: number) => string]>([
  ["colon runs", size => "a:".repeat(size / 2)],
  ["key-word runs", size => "k-".repeat(size / 2) + "key"],
  ["mnemonic runs", size => "abandon ".repeat(size / 8) + "zzz"],
  ["scheme runs", size => "https://".repeat(size / 8)],
  ["dotted scheme-like runs", size => "a.".repeat(size / 2)],
  ["JWT-like runs", size => "eyJ-".repeat(size / 4)],
  ["hex runs", size => "a".repeat(size) + "g"],
  ["project-id-like runs", size => "1a".repeat(size / 2)],
  ["runs without a space to cut the window at", size => "x".repeat(size)],
])("redacts a 1 MB message of %s in one pass per configured value and a fixed window of shape rules", (_, run) => {
  const secrets = ["somesecretvalue1", "store-key/with+chars&more"], forms = 1 + 2;
  const measure = (size: number) => {
    const message = run(size), work = redactionWork();
    const printed = redact(message, secrets, 512, work);
    expect(printed.length).toBeLessThanOrEqual(512);
    expect(work.values).toBe(forms);
    expect(work.textCharacters).toBe(forms * message.length);
    expect(work.rules).toBeLessThanOrEqual(16);
    expect(work.windowCharacters).toBeLessThanOrEqual(work.rules * (512 + 4096));
    return work;
  };
  const one = measure(MB), two = measure(2 * MB);
  expect({ values: two.values, rules: two.rules, windowCharacters: two.windowCharacters }).toEqual({ values: one.values, rules: one.rules, windowCharacters: one.windowCharacters });
});

it("counts the work of the redaction errorChain prints, and none it does not do", () => {
  const work = redactionWork();
  expect(redact("upstream refused token=SECRETTOK", [], 512, work)).toBe((errorChain(new Error("upstream refused token=SECRETTOK"), []) as { message: string }[])[0]!.message);
  expect(work.values).toBe(0); expect(work.textCharacters).toBe(0);
  expect(work.rules).toBeGreaterThan(0); expect(work.windowCharacters).toBeGreaterThan(0);
});

it("drops a token cut at the edge of the redaction window, which a shorter redacted prefix could bring into view", () => {
  const hex = "7f3a".repeat(16), message = `https://h.example/x?q=${"z".repeat(4560)} ${hex}`;
  const printed = JSON.stringify(errorChain(new Error(message), []));
  expect(printed).toContain("https://h.example/x");
  expect(printed).not.toContain(hex.slice(0, 16));
});

it("prints why it stopped without a configured endpoint's path segment, by value", () => {
  const segment = "capabilityfatalsegment";
  const root = mkdtempSync(join(tmpdir(), "standing-service-fatal-")); roots.push(root);
  mkdirSync(join(root, segment));
  const authors = join(root, segment, "authors.json"); writeFileSync(authors, "[]"); chmodSync(authors, 0o644);
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({ ...config(), network: "preprod", stateRoot: root, knownAuthorsFile: authors, midnightReadRpcUrl: `https://midnight.example/${segment}/rpc` }), { mode: 0o600 });
  const result = spawnSync(process.execPath, ["--import", "tsx", "runner/standing-service.ts", "--config", path], { encoding: "utf8", timeout: 120_000 });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Standing signed author policy is unreadable: ");
  expect(result.stderr).not.toContain(segment);
}, 150_000);
