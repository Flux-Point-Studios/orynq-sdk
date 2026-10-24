import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { knownAuthors, midnightSource, readPrivateFile, rpcOnlySource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { openJournal } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { agentDriven, MAINNET_BATCH_AUTHOR_KEYS } from "../src/custody.js";
import { ensurePrivateDir } from "../src/keys.js";
import { networkEndpoints } from "../src/endpoints.js";
import { assertChainIdentity } from "../src/preflight.js";
import { registryOperator } from "../src/operator.js";
import { registryStateOnNode } from "../src/submission.js";
import { openWallet, type OperatorWallet } from "../src/wallet.js";
import { syncWithCheckpoints } from "../src/sync.js";
import { provingService } from "../src/zk.js";
import { readCensus } from "./census.js";
import { openCensusState } from "./census-state.js";
import { followerPolicyDigest } from "./follower-block.js";
import { openFollowerCatchup } from "./follower-catchup.js";
import { openFollowerState } from "./follower-state.js";
import { openStandingSession } from "./standing-session.js";
import { openStandingDelivery } from "./standing-delivery.js";
import { openStandingController } from "./standing-controller.js";
import { StandingFeeCap } from "./standing-budget.js";
import { openStandingStatus } from "./standing-status.js";
import { flushDirectory } from "./state.js";

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
        if (!caughtUp) wait = 10;
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

export async function runStandingService(config: ReturnType<typeof parseStandingConfig>) {
  if (config.mode === "anchor" && config.network === "mainnet" && agentDriven()) throw new Error("Agent-driven mainnet anchoring is forbidden");
  const lockPath = config.network === "mainnet" ? join(homedir(), ".local/state/orynq-midnight/runner/execution.lock") : join(config.stateRoot, "execution.lock");
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 }); ensurePrivateDir(dirname(lockPath));
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const abort = new AbortController(), stop = () => abort.abort();
  let follower: ReturnType<typeof openFollowerState> | undefined, census: ReturnType<typeof openCensusState> | undefined;
  let journal: ReturnType<typeof openJournal> | undefined, operator: ReturnType<typeof registryOperator> | undefined, wallet: OperatorWallet | undefined;
  let status: ReturnType<typeof openStandingStatus> | undefined;
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
      let documents: unknown; try { documents = JSON.parse(readPrivateFile(config.knownAuthorsFile)); } catch { throw new Error("Standing signed author policy is unreadable"); }
      if (!Array.isArray(documents)) throw new Error("Standing signed author policy must be a list");
      return knownAuthors({ documents });
    };
    const initial = authors();
    if (!initial.authors(config.network).some(row => row.key === config.author && row.role === "batch") || (config.network === "mainnet" && !MAINNET_BATCH_AUTHOR_KEYS.includes(config.author))) throw new Error("Standing batch author is not pinned and authorized");
    follower = openFollowerState(join(config.stateRoot, "follower.sqlite"), { network: config.network, genesis: config.genesis, registry: config.registry, author: config.author, policyDigest: followerPolicyDigest(initial.checkpoints(config.network)), runtimeSpecVersion: 1000300 });
    status = openStandingStatus(config.stateRoot, { ...follower.scope(), mode: config.mode });
    const catchup = openFollowerCatchup({ state: follower, node: config.midnightReadRpcUrl, authors, signal: abort.signal });
    let controller: ReturnType<typeof openStandingController> | undefined;
    if (config.mode === "anchor") {
      status.phase("wallet-sync");
      const endpoints = networkEndpoints(config.network, { blockfrostProjectIdFile: config.wallet.blockfrost }), source = midnightSource(endpoints);
      await assertChainIdentity(source, config.network);
      if (!(await registryStateOnNode(source, config.registry))) throw new Error("Standing node lacks the immutable registry");
      let record: { addresses?: { unshielded: string; shielded: string; dust: string } };
      try { record = JSON.parse(readPrivateFile(config.wallet.record)); } catch { throw new Error("Standing wallet record is unreadable"); }
      if (!record.addresses || Object.keys(record.addresses).sort().join(",") !== "dust,shielded,unshielded" || Object.values(record.addresses).some(address => typeof address !== "string" || !address)) throw new Error("Standing wallet record lacks addresses");
      wallet = await openWallet({ network: config.network, mnemonicFile: config.wallet.mnemonic, endpoints, source, zkDir: config.wallet.zk, stateFile: config.wallet.state, expectedAddresses: record.addresses });
      await syncWithCheckpoints(wallet, { timeoutMs: 180 * 60_000, progressMs: 60_000, checkpointMs: 5 * 60_000, signal: abort.signal, write: line => { status!.phase("wallet-sync"); console.log(line); } });
      const publication = { network: config.network, targets: config.stores.map(target => ({ url: target.url, apiKey: readPrivateFile(target.keyFile) })) };
      census = openCensusState(join(config.stateRoot, "census.sqlite"), config);
      journal = openJournal(join(config.stateRoot, "attempts.sqlite"));
      const startup = await catchup.start(), session = openStandingSession({ state: follower, verifiedStart: startup, authors });
      operator = registryOperator({ network: config.network, wallet, source, prover: provingService(config.wallet.zk), journalPath: join(config.stateRoot, "attempts.sqlite"), chain: follower.chainView(), authorKeyFile: config.wallet.author, authorRole: "batch", registry: config.registry, ttlMinutes: 10 });
      if (operator.authorKey !== config.author) throw new Error("Standing author file differs from the policy scope");
      const censusReader = () => readCensus({ rpcUrl: config.materiosRpcUrl, genesis: config.genesis, signal: abort.signal });
      const delivery = openStandingDelivery({ wallet, follower, session, census, journal, readCensus: censusReader, publication });
      controller = openStandingController({ census, follower, session, delivery, journal, operator, readCensus: censusReader, publication,
        verify: () => ({ source: rpcOnlySource({ network: config.network, node: config.midnightReadRpcUrl, hints: [], signal: abort.signal, httpBudget: { requests: 256, bytes: 64 * 1024 * 1024, abort: new AbortController() } }), knownAuthors: authors() }) });
    } else await catchup.start();
    let previous = "";
    const sample = () => {
      status!.sample(follower!.coverage());
    };
    status.phase("catchup"); sample();
    await runStandingLoops({ catchup, controller, abort, publish: (progress, result, loop, phase) => {
        status!.record(loop, phase, loop === "follower" ? { progress, head: follower!.head()?.hash } : result);
        if (phase === "start") return;
        status!.phase(progress === "idle" ? "running" : "catchup"); sample();
        const message = JSON.stringify({ event: "standing-progress", loop, progress, coverage: follower!.coverage(), result }); if (message !== previous) { console.log(message); previous = message; }
      }, hold: (error, loop) => {
        const message = error instanceof Error ? error.message : "";
        let cause = error, capped = false;
        for (let depth = 0; depth < 8 && cause instanceof Error; depth++) { if (cause instanceof StandingFeeCap) capped = true; cause = cause.cause; }
        const reason = capped ? "dust-cap" : /warmup|twenty|margin/i.test(message) ? "warmup" : /policy|author/i.test(message) ? "policy" : /history|floor|retained|coverage/i.test(message) ? "history" : "source";
        status!.hold(loop, reason); sample();
        if (reason !== previous) { console.log(JSON.stringify({ event: "standing-hold", loop, reason })); previous = reason; }
      } });
  } finally {
    abort.abort();
    try { status?.phase("stopping"); }
    finally {
      process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
      try { if (wallet && (await wallet.close())?.saved !== true) throw new Error("Standing final wallet save failed"); }
      finally { try { operator?.close(); journal?.close(); census?.close(); follower?.close(); status?.phase("stopped"); } finally { closeSync(fd); } }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = async () => {
    if (process.argv.length !== 4 || process.argv[2] !== "--config") throw new Error("Expected --config with an owner-only configuration file");
    let input: unknown; try { input = JSON.parse(readPrivateFile(process.argv[3]!)); } catch { throw new Error("Standing configuration is unreadable"); }
    await runStandingService(parseStandingConfig(input));
  };
  run().catch(error => { console.error(error instanceof Error && error.message === "Agent-driven mainnet anchoring is forbidden" ? error.message : "Standing service stopped before completion"); process.exitCode = 1; });
}
