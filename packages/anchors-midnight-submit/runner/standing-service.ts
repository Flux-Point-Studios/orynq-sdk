import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { knownAuthors, midnightSource, rpcOnlySource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { openJournal } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { agentDriven, MAINNET_BATCH_AUTHOR_KEYS } from "../src/custody.js";
import { ensurePrivateDir } from "../src/keys.js";
import { networkEndpoints } from "../src/endpoints.js";
import { assertChainIdentity } from "../src/preflight.js";
import { registryOperator } from "../src/operator.js";
import { SUBMITTER_RUNTIME_SPEC_VERSIONS, assertKnownRuntime, registryStateOnNode } from "../src/submission.js";
import { openWallet, type OperatorWallet } from "../src/wallet.js";
import { syncWithCheckpoints } from "../src/sync.js";
import { provingService } from "../src/zk.js";
import { readCensus } from "./census.js";
import { readProofStoreKey } from "./publisher.js";
import { openCensusState } from "./census-state.js";
import { followerPolicyDigest } from "./follower-block.js";
import { openFollowerCatchup } from "./follower-catchup.js";
import { openFollowerState } from "./follower-state.js";
import { openStandingSession } from "./standing-session.js";
import { openStandingDelivery } from "./standing-delivery.js";
import { openStandingController } from "./standing-controller.js";
import { StandingFeeCap } from "./standing-budget.js";
import { openStandingStatus } from "./standing-status.js";
import { flushDirectory, readPrivateJson } from "./state.js";
import { readCheckpointHistory } from "./checkpoint-history.js";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export function parseStandingConfig(value: unknown) {
  const object = (input: unknown, fields: string[]) => {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== [...fields].sort().join(",")) throw new Error("Standing configuration fields differ");
    return input as Record<string, unknown>;
  };
  const data = object(value, ["mode", "network", "genesis", "registry", "author", "stateRoot", "materiosRpcUrl", "midnightReadRpcUrl", "knownAuthorsFile", "wallet", "stores"]);
  const mode = data.mode, network = data.network;
  if ((mode !== "observe" && mode !== "anchor") || (network !== "mainnet" && network !== "preprod")) throw new Error("Invalid standing mode or network");
  const hash = (input: unknown) => { if (typeof input !== "string" || !/^[a-f0-9]{64}$/.test(input)) throw new Error("Invalid standing identity"); return input; };
  const path = (input: unknown) => { if (typeof input !== "string" || !isAbsolute(input) || /[\0\r\n]/.test(input)) throw new Error("Standing paths must be absolute"); return input; };
  const endpoint = (input: unknown) => {
    if (typeof input !== "string") throw new Error("Invalid standing endpoint");
    const url = new URL(input), loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(network === "preprod" && url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) throw new Error("Invalid standing endpoint");
    return input;
  };
  const registry = hash(data.registry);
  if (network === "mainnet" && registry !== "438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736") throw new Error("Standing mainnet registry is not approved");
  const wallet = object(data.wallet, ["mnemonic", "record", "state", "blockfrost", "zk", "author"]);
  if (!Array.isArray(data.stores) || data.stores.length !== 2) throw new Error("Standing requires two retained copies");
  const stores = data.stores.map(input => { const store = object(input, ["url", "keyFile"]); return { url: endpoint(store.url), keyFile: path(store.keyFile) }; });
  const targets = stores.map(store => new URL(store.url));
  if (targets[0]!.origin === targets[1]!.origin || (network === "mainnet" && targets[0]!.hostname === targets[1]!.hostname)) throw new Error("Standing retained copies require distinct hosts");
  return { mode, network, genesis: hash(data.genesis), registry, author: hash(data.author), stateRoot: path(data.stateRoot),
    materiosRpcUrl: endpoint(data.materiosRpcUrl), midnightReadRpcUrl: endpoint(data.midnightReadRpcUrl), knownAuthorsFile: path(data.knownAuthorsFile),
    wallet: { mnemonic: path(wallet.mnemonic), record: path(wallet.record), state: path(wallet.state), blockfrost: path(wallet.blockfrost), zk: path(wallet.zk), author: path(wallet.author) }, stores } as const;
}

// The service's errors name files and checks, never what a file holds, but provider and SDK text
// can ride in a cause. So every link's name and message pass redact before they are printed.
const REDACTED = "[redacted]";
const MNEMONIC_WORDS = new Set(wordlist);
const TOKEN_SEGMENT = /^(?=.*\d)(?=.*[A-Za-z])[\w\-.~%]{20,}$/;
// Every pattern below starts only where a token can (or is bounded), so each runs in linear time.
const SECRET_KEY = /(?<![\w-])([\w-]{0,64}?(?:key|token|secret|passw(?:or)?d|pwd|auth|project_id)[\w-]{0,64})("?\s{0,8}(?:=|:|%3[dD])\s{0,8}"?)([^\s,;&"'}\]]+)/gi;
// Shape rules read at most this much past the printed limit; a token the cut splits is dropped.
const WINDOW = 4096;

// Any URL keeps its scheme, host and the path segments that cannot be tokens; userinfo (up to its
// last @), query and fragment are dropped.
const url = (_: string, scheme: string, rest: string) => {
  const authorityEnd = rest.search(/[/?#]/), authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const path = authorityEnd < 0 ? "" : rest.slice(authorityEnd).replace(/[?#].*$/, "");
  return `${scheme}://${host}${path.split("/").map(segment => TOKEN_SEGMENT.test(segment) ? REDACTED : segment).join("/")}`;
};

// Six or more consecutive BIP-39 words read as (part of) a mnemonic.
const mnemonicRuns = (text: string) => text.replace(/\b[a-z]+(?:\s+[a-z]+){5,}\b/g, run => {
  const out: string[] = [];
  let streak: string[] = [];
  const flush = () => { out.push(...(streak.length >= 6 ? [REDACTED] : streak)); streak = []; };
  for (const word of run.split(/\s+/)) {
    if (MNEMONIC_WORDS.has(word)) streak.push(word);
    else { flush(); out.push(word); }
  }
  flush();
  return out.join(" ");
});

// Each configured secret of 8 or more characters goes by value (raw, percent-encoded and as JSON
// escapes it), as midnightSource redacts its headers, over the whole text; then, within the window,
// whatever looks like a credential goes
// by shape: URL userinfo, query strings and token-like path segments, scheme-less user:pass@,
// Bearer and Basic values, key=value secrets, JWTs, 64-hex runs, Blockfrost-shaped project ids
// and mnemonic word runs. The result is one line, at most `limit` long.
function redact(text: string, secrets: readonly string[], limit: number): string {
  const values = [...new Set(secrets.filter(secret => secret.length >= 8).flatMap(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length);
  const byValue = values.reduce((out, value) => out.split(value).join(REDACTED), text);
  const window = byValue.length > limit + WINDOW ? byValue.slice(0, limit + WINDOW).replace(/\S*$/, "") : byValue;
  return mnemonicRuns(window
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\b([a-z][a-z0-9+.-]{0,31}):\/\/([^\s"'<>]*)/gi, url)
    .replace(/(?<![^\s"'(<=,])[^\s:@/"']{1,256}:[^\s@/"']{1,256}@/g, `${REDACTED}@`)
    .replace(/\b(bearer|basic)\s+[^\s,;"']+/gi, `$1 ${REDACTED}`)
    .replace(SECRET_KEY, `$1$2${REDACTED}`)
    .replace(/(?<![\w-])eyJ[\w-]*\.[\w-]+\.[\w-]*/g, REDACTED)
    .replace(/\b(?:0x)?[0-9a-fA-F]{64,}\b/g, REDACTED)
    .replace(/(?<![A-Za-z])[a-z]{1,32}[A-Za-z0-9]{32}(?![A-Za-z0-9])/g, REDACTED)).slice(0, limit);
}

// At most eight links, each its type and message. A thrown non-Error names only its type, since
// nothing bounds what it carries. Reading a link can run hostile code (a getter, a Proxy trap,
// a Symbol message); then the chain is "unprintable", so a hold is logged rather than escalated
// into a failure of the loop that reported it.
export type ErrorChain = { name: string; message: string }[] | "unprintable";
const readable = <T>(read: () => T, unreadable: T): T => {
  try { return read(); }
  catch { return unreadable; }
};

export function errorChain(error: unknown, secrets: readonly string[]): ErrorChain {
  return readable<ErrorChain>(() => {
    const chain: { name: string; message: string }[] = [];
    for (let cause: unknown = error; chain.length < 8 && cause !== undefined;) {
      if (!(cause instanceof Error)) {
        chain.push({ name: typeof cause === "object" && cause ? redact(String(cause.constructor?.name || "object"), secrets, 64) : typeof cause, message: "" });
        break;
      }
      const name = cause.name === "Error" || cause.name === undefined ? cause.constructor.name : cause.name;
      chain.push({ name: redact(String(name), secrets, 64), message: redact(String(cause.message), secrets, 512) });
      cause = cause.cause;
    }
    return chain;
  }, "unprintable");
}

// What the service prints to stderr when it stops: each printable message, joined.
export function fatalLine(error: unknown, secrets: readonly string[]): string {
  const chain = errorChain(error, secrets);
  return (typeof chain === "string" ? [] : chain.map(link => link.message).filter(Boolean)).join(": ") || "Standing service stopped before completion";
}

export function holdLine(event: "standing-hold" | "standing-startup-hold", loop: "follower" | "controller", reason: string, error: unknown, secrets: readonly string[]) {
  return JSON.stringify({ event, loop, reason, causes: errorChain(error, secrets) });
}

export function printChanges(write: (line: string) => void) {
  let previous = "";
  return (line: string) => { if (line !== previous) { write(line); previous = line; } };
}

export async function runStandingLoops(options: {
  catchup: { turn(): Promise<{ state: string }> }; controller?: { turn(): Promise<unknown> } | undefined;
  abort: AbortController; publish(progress: string, result: unknown, loop: "follower" | "controller", phase: "start" | "success"): void; hold(error: unknown, loop: "follower" | "controller"): void;
}) {
  const { catchup, controller, abort, publish, hold } = options;
  let caughtUp = false, progress = "starting", result: unknown = null;
  const pause = async (ms: number) => {
    if (abort.signal.aborted) return;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      abort.signal.addEventListener("abort", done, { once: true });
    });
  };
  const failure = (error: unknown, loop: "follower" | "controller") => {
    if (abort.signal.aborted) return;
    hold(error, loop);
    if (error instanceof Error && /restart required/i.test(error.message)) throw error;
  };
  const following = async () => {
    while (!abort.signal.aborted) {
      let wait = 5_000;
      try {
        publish(progress, result, "follower", "start");
        const next = await catchup.turn(); progress = next.state; caughtUp = progress === "idle";
        if (!abort.signal.aborted) publish(progress, result, "follower", "success");
        wait = caughtUp ? 60_000 : 10;
      } catch (error) { caughtUp = false; failure(error, "follower"); }
      if (abort.signal.aborted) return;
      await pause(wait);
    }
  };
  const controlling = async () => {
    while (!abort.signal.aborted) {
      if (caughtUp) {
        try { publish(progress, result, "controller", "start"); result = await controller!.turn(); if (!abort.signal.aborted) publish(progress, result, "controller", "success"); }
        catch (error) { failure(error, "controller"); }
        if (abort.signal.aborted) return;
      }
      await pause(15_000);
    }
  };
  const jobs = [following(), ...(controller ? [controlling()] : [])];
  try { await Promise.all(jobs); }
  catch (error) { abort.abort(); await Promise.allSettled(jobs); throw error; }
}

export async function startStandingFollower<T>(options: { catchup: { start(): Promise<T> }; signal: AbortSignal; hold(error: unknown): void; retryMs?: number }): Promise<T> {
  const retryMs = options.retryMs ?? 5000;
  if (!Number.isSafeInteger(retryMs) || retryMs < 0 || retryMs > 60_000) throw new Error("Invalid standing startup retry delay");
  for (;;) {
    options.signal.throwIfAborted();
    try { return await options.catchup.start(); }
    catch (error) {
      options.signal.throwIfAborted();
      options.hold(error);
      if (error instanceof Error && /restart required/i.test(error.message)) throw error;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); options.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, retryMs);
        options.signal.addEventListener("abort", done, { once: true });
        if (options.signal.aborted) done();
      });
    }
  }
}

// `secrets` collects what the service learns must never be printed, for its caller's fatal line.
export async function runStandingService(config: ReturnType<typeof parseStandingConfig>, secrets: string[] = []) {
  if (config.mode === "anchor" && config.network === "mainnet" && agentDriven()) throw new Error("Agent-driven mainnet anchoring is forbidden");
  // An endpoint's path can carry a capability, as the credential relay's does.
  secrets.push(...[config.materiosRpcUrl, config.midnightReadRpcUrl, ...config.stores.map(store => store.url)].flatMap(url => new URL(url).pathname.split("/").filter(Boolean)));
  const lockPath = config.network === "mainnet" ? join(homedir(), ".local/state/orynq-midnight/runner/execution.lock") : join(config.stateRoot, "execution.lock");
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 }); ensurePrivateDir(dirname(lockPath));
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const abort = new AbortController(), stop = () => abort.abort();
  let follower: ReturnType<typeof openFollowerState> | undefined, census: ReturnType<typeof openCensusState> | undefined;
  let journal: ReturnType<typeof openJournal> | undefined, operator: ReturnType<typeof registryOperator> | undefined, wallet: OperatorWallet | undefined;
  let status: ReturnType<typeof openStandingStatus> | undefined, failure: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Shared execution lock is not private and owned");
    const locked = spawnSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
    if (locked.error || locked.status !== 0) throw new Error("Shared standing wallet lock is unavailable");
    flushDirectory(dirname(lockPath));
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    ensurePrivateDir(config.stateRoot); flushDirectory(dirname(config.stateRoot));
    const authors = () => {
      abort.signal.throwIfAborted();
      const documents = readPrivateJson(config.knownAuthorsFile, "Standing signed author policy");
      if (!Array.isArray(documents)) throw new Error("Standing signed author policy must be a list");
      return knownAuthors({ documents });
    };
    const initial = authors();
    if (!initial.authors(config.network).some(row => row.key === config.author && row.role === "batch") || (config.network === "mainnet" && !MAINNET_BATCH_AUTHOR_KEYS.includes(config.author))) throw new Error("Standing batch author is not pinned and authorized");
    follower = openFollowerState(join(config.stateRoot, "follower.sqlite"), { network: config.network, genesis: config.genesis, registry: config.registry, author: config.author, policyDigest: followerPolicyDigest(initial.checkpoints(config.network)) });
    const advancementFile = join(config.stateRoot, "checkpoint-history.json");
    if (existsSync(advancementFile)) await follower.retainCheckpointHistory(initial.checkpoints(config.network), readCheckpointHistory(advancementFile));
    status = openStandingStatus(config.stateRoot, { ...follower.scope(), mode: config.mode });
    const catchup = openFollowerCatchup({ state: follower, node: config.midnightReadRpcUrl, authors, signal: abort.signal,
      startupDiagnostic: event => console.log(JSON.stringify({ event: "standing-startup", ...event })) });
    const print = printChanges(line => console.log(line));
    // A link that cannot be read classifies as neither a fee cap nor any message.
    const printable = (error: unknown) => ({
      message: readable(() => error instanceof Error ? String(error.message) : "", ""),
      capped: readable(() => {
        for (let cause: unknown = error, depth = 0; depth < 8 && cause instanceof Error; depth++, cause = cause.cause) if (cause instanceof StandingFeeCap) return true;
        return false;
      }, false),
    });
    const startup = () => startStandingFollower({ catchup, signal: abort.signal, hold: error => {
      const { message } = printable(error);
      const reason = /policy|author|checkpoint/i.test(message) ? "policy" : /clock|stale/i.test(message) ? "warmup" : "source";
      status!.hold("follower", reason);
      print(holdLine("standing-startup-hold", "follower", reason, error, secrets));
    } });
    let controller: ReturnType<typeof openStandingController> | undefined;
    if (config.mode === "anchor") {
      status.phase("wallet-sync");
      const endpoints = networkEndpoints(config.network, { blockfrostProjectIdFile: config.wallet.blockfrost }), source = midnightSource(endpoints);
      secrets.push(...Object.values(endpoints.headers));
      await assertChainIdentity(source, config.network);
      if (!(await registryStateOnNode(source, config.registry))) throw new Error("Standing node lacks the immutable registry");
      const record = readPrivateJson(config.wallet.record, "Standing wallet record") as { addresses?: { unshielded: string; shielded: string; dust: string } };
      if (!record.addresses || Object.keys(record.addresses).sort().join(",") !== "dust,shielded,unshielded" || Object.values(record.addresses).some(address => typeof address !== "string" || !address)) throw new Error("Standing wallet record lacks addresses");
      wallet = await openWallet({ network: config.network, mnemonicFile: config.wallet.mnemonic, endpoints, source, zkDir: config.wallet.zk, stateFile: config.wallet.state, expectedAddresses: record.addresses });
      secrets.push(...wallet.secrets);
      await syncWithCheckpoints(wallet, { timeoutMs: 180 * 60_000, progressMs: 60_000, checkpointMs: 5 * 60_000, signal: abort.signal, write: line => { status!.phase("wallet-sync"); console.log(line); } });
      const publication = { network: config.network, targets: config.stores.map(target => ({ url: target.url, apiKey: readProofStoreKey(target.keyFile) })) };
      secrets.push(...publication.targets.map(target => target.apiKey));
      census = openCensusState(join(config.stateRoot, "census.sqlite"), config);
      journal = openJournal(join(config.stateRoot, "attempts.sqlite"));
      const verifiedStart = await startup(), session = openStandingSession({ state: follower, verifiedStart, authors });
      operator = registryOperator({ network: config.network, wallet, source, prover: provingService(config.wallet.zk), journalPath: join(config.stateRoot, "attempts.sqlite"), chain: follower.chainView(), authorKeyFile: config.wallet.author, authorRole: "batch", registry: config.registry, ttlMinutes: 10 });
      if (operator.authorKey !== config.author) throw new Error("Standing author file differs from the policy scope");
      const censusReader = () => readCensus({ rpcUrl: config.materiosRpcUrl, genesis: config.genesis, signal: abort.signal });
      const delivery = openStandingDelivery({ wallet, follower, session, census, journal, readCensus: censusReader, publication, runtime: () => assertKnownRuntime(source, config.network, SUBMITTER_RUNTIME_SPEC_VERSIONS, config.registry) });
      controller = openStandingController({ census, follower, session, delivery, journal, operator, readCensus: censusReader, publication,
        verify: hints => ({ source: rpcOnlySource({ network: config.network, node: config.midnightReadRpcUrl, hints, signal: abort.signal, httpBudget: { requests: 256, bytes: 64 * 1024 * 1024, abort: new AbortController() } }), knownAuthors: authors() }) });
    } else await startup();
    const sample = () => {
      status!.sample(follower!.coverage());
    };
    status.phase("catchup"); sample();
    await runStandingLoops({ catchup, controller, abort, publish: (progress, result, loop, phase) => {
        status!.record(loop, phase, loop === "follower" ? { progress, head: follower!.head()?.hash } : result);
        if (phase === "start") return;
        status!.phase(progress === "idle" ? "running" : "catchup"); sample();
        print(JSON.stringify({ event: "standing-progress", loop, progress, coverage: follower!.coverage(), result }));
      }, hold: (error, loop) => {
        const { message, capped } = printable(error);
        const reason = capped ? "dust-cap" : /warmup|twenty|margin/i.test(message) ? "warmup" : /policy|author/i.test(message) ? "policy" : /history|floor|retained|coverage/i.test(message) ? "history" : "source";
        status!.hold(loop, reason); sample();
        print(holdLine("standing-hold", loop, reason, error, secrets));
      } });
  } catch (error) { failure = error; throw error; }
  finally {
    abort.abort();
    try { status?.phase("stopping"); }
    finally {
      process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
      try { if (wallet && (await wallet.close())?.saved !== true) throw new Error("Standing final wallet save failed", { cause: failure }); }
      finally { try { operator?.close(); journal?.close(); census?.close(); follower?.close(); status?.phase("stopped"); } finally { closeSync(fd); } }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secrets: string[] = [];
  const run = async () => {
    if (process.argv.length !== 4 || process.argv[2] !== "--config") throw new Error("Expected --config with an owner-only configuration file");
    await runStandingService(parseStandingConfig(readPrivateJson(process.argv[3]!, "Standing configuration")), secrets);
  };
  run().catch(error => { console.error(fatalLine(error, secrets)); process.exitCode = 1; });
}
