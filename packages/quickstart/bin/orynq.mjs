#!/usr/bin/env node
/**
 * `orynq` — solo-developer CLI for orynq-sdk-quickstart.
 *
 * Subcommands:
 *   orynq init         Generate identity + faucet drip + verify chain reach.
 *                      No on-chain submission. Idempotent: reruns just print
 *                      the current state.
 *   orynq trace        Submit a one-event "hello" trace from the saved
 *                      identity. Prints the explorer URLs at the end.
 *                      Combines `init` + first submission.
 *   orynq whoami       Print the saved address. No network calls.
 *   orynq status       GET ${gateway}/health and print the summary.
 *
 * Env overrides:
 *   ORYNQ_CONFIG_PATH    Path to identity file (default: ~/.orynq/config.json).
 *   ORYNQ_RPC_URL        Substrate WS RPC URL (default: preprod).
 *   ORYNQ_GATEWAY_URL    Blob-gateway URL (default: preprod).
 *   ORYNQ_AGENT_ID       AgentId for the trace bundle.
 *   ORYNQ_SUMMARY        Override the default observation event content.
 *   ORYNQ_SKIP_FAUCET    "1" to skip the faucet step (already-funded addrs).
 *
 * Exit codes:
 *   0   success
 *   1   user-facing error (printed to stderr, no stack trace)
 *   2   internal/unexpected error (full stack trace)
 */
import { argv, env, exit, stderr, stdout, version as nodeVersion } from "node:process";

// Lazy-resolve the package's own dist so the CLI works both from the
// monorepo dev tree and from a published tarball.
async function loadSdk() {
  return import("../dist/index.js").catch(() => import("../src/index.ts"));
}

function ansi(s, code) {
  if (!stdout.isTTY) return s;
  return `[${code}m${s}[0m`;
}
const bold = (s) => ansi(s, "1");
const dim = (s) => ansi(s, "2");
const green = (s) => ansi(s, "32");
const yellow = (s) => ansi(s, "33");
const cyan = (s) => ansi(s, "36");
const red = (s) => ansi(s, "31");

function printUsage() {
  stdout.write(
    [
      `${bold("orynq")} — solo-dev CLI for orynq-sdk-quickstart`,
      ``,
      `Usage:`,
      `  ${bold("orynq init")}     Generate identity + faucet-drip MATRA.`,
      `                            Idempotent — safe to rerun.`,
      `  ${bold("orynq trace")}    Submit your first trace on Materios.`,
      `                            Combines init + on-chain submit + cert.`,
      `  ${bold("orynq whoami")}   Print the saved SS58 address.`,
      `  ${bold("orynq status")}   Show gateway + chain health.`,
      `  ${bold("orynq help")}     Show this message.`,
      ``,
      `Env overrides:`,
      `  ORYNQ_CONFIG_PATH=<path>   Where to save identity (default: ~/.orynq/config.json)`,
      `  ORYNQ_RPC_URL=<wss-url>    Substrate RPC (default: Materios preprod)`,
      `  ORYNQ_GATEWAY_URL=<url>    Blob-gateway base URL`,
      `  ORYNQ_SKIP_FAUCET=1        Skip the faucet drip step`,
      ``,
      `Docs: https://github.com/Flux-Point-Studios/orynq-sdk#quickstart`,
      ``,
    ].join("\n"),
  );
}

async function cmdInit() {
  const sdk = await loadSdk();
  const identity = await sdk.loadOrCreateIdentity({
    configPath: env.ORYNQ_CONFIG_PATH,
  });

  stdout.write(
    `${bold("Identity")} ${identity.freshlyGenerated ? green("created") : dim("(reused)")}\n`,
  );
  stdout.write(`  address     ${cyan(identity.address)}\n`);
  stdout.write(`  configPath  ${identity.configPath}\n`);
  stdout.write(`  generatedAt ${identity.generatedAt}\n`);
  for (const w of identity.warnings) {
    stdout.write(`  ${yellow("warning")}     ${w}\n`);
  }

  if (env.ORYNQ_SKIP_FAUCET !== "1") {
    const gateway = env.ORYNQ_GATEWAY_URL ?? sdk.DEFAULT_GATEWAY_URL;
    stdout.write(`\n${bold("Faucet")} ${dim(`(${gateway})`)}\n`);
    const result = await sdk.requestFaucet({
      address: identity.address,
      gatewayBaseUrl: gateway,
    });
    switch (result.kind) {
      case "success":
        stdout.write(`  ${green("dripped")} ${result.amount} units\n`);
        stdout.write(`  txHash      ${result.txHash}\n`);
        stdout.write(`  ${dim("MOTRA will generate over the next few blocks.")}\n`);
        break;
      case "already-funded":
        stdout.write(
          `  ${dim("(already funded — drip ledger says yes; will reuse existing balance)")}\n`,
        );
        break;
      case "cooldown":
        stdout.write(
          `  ${yellow("cooldown")} retry in ~${Math.round((result.retryAfterMs ?? 0) / 1000)}s\n`,
        );
        break;
      case "error":
        stdout.write(`  ${red("error")} ${result.message} (HTTP ${result.status})\n`);
        return 1;
    }
  } else {
    stdout.write(`\n${bold("Faucet")} ${dim("(skipped via ORYNQ_SKIP_FAUCET=1)")}\n`);
  }

  stdout.write(`\n${green("init complete")}. Next:\n`);
  stdout.write(`  ${bold("orynq trace")}    submit your first trace\n`);
  return 0;
}

async function cmdTrace() {
  const sdk = await loadSdk();
  const traceStart = Date.now();

  const result = await sdk.bootstrapAndTrace({
    configPath: env.ORYNQ_CONFIG_PATH,
    rpcUrl: env.ORYNQ_RPC_URL,
    gatewayBaseUrl: env.ORYNQ_GATEWAY_URL,
    agentId: env.ORYNQ_AGENT_ID,
    summary: env.ORYNQ_SUMMARY,
    skipFaucet: env.ORYNQ_SKIP_FAUCET === "1",
    onProgress(step) {
      const ts = ((Date.now() - traceStart) / 1000).toFixed(1).padStart(5, " ");
      const tag = `${dim(`[+${ts}s]`)}`;
      switch (step.kind) {
        case "identity-loaded":
          stdout.write(
            `${tag} identity ${step.identity.freshlyGenerated ? green("created") : dim("(reused)")} ${cyan(step.identity.address)}\n`,
          );
          break;
        case "faucet-result":
          if (step.result.kind === "success") {
            stdout.write(`${tag} faucet ${green("dripped")} ${step.result.amount} units (tx ${step.result.txHash.slice(0, 12)}...)\n`);
          } else if (step.result.kind === "already-funded") {
            stdout.write(`${tag} faucet ${dim("already funded — reusing balance")}\n`);
          }
          break;
        case "waiting-for-motra":
          stdout.write(`${tag} waiting for MOTRA fee currency to generate (~10-30s)...\n`);
          break;
        case "motra-ready":
          stdout.write(`${tag} MOTRA ready (${step.balance.toString()} units)\n`);
          break;
        case "trace-built":
          stdout.write(
            `${tag} trace built — runId ${dim(step.bundle.runId.slice(0, 8))} rootHash ${dim(step.bundle.rootHash.slice(0, 12))}\n`,
          );
          break;
        case "receipt-submitted":
          stdout.write(
            `${tag} receipt submitted — receiptId ${dim(step.receiptId.slice(0, 14))} block ${dim(step.blockHash.slice(0, 14))}\n`,
          );
          break;
        case "certified":
          stdout.write(
            `${tag} ${green("certified")} certHash ${dim(step.certHash.slice(0, 14))}\n`,
          );
          break;
        case "explorer-ready":
          // Handled below in the summary block — keep the streaming
          // output uncluttered.
          break;
      }
    },
  });

  // Summary block — this is what the dev came for.
  stdout.write(`\n${green("First trace anchored on Materios")} ${dim(`(${(result.elapsedMs / 1000).toFixed(1)}s)`)}\n\n`);
  stdout.write(`${bold("View your trace:")}\n`);
  stdout.write(`  blob status   ${cyan(result.urls.blobStatus)}\n`);
  stdout.write(`  chain block   ${cyan(result.urls.explorer)}\n`);
  stdout.write(`  chain info    ${dim(result.urls.chainInfo)}\n`);
  stdout.write(`  health        ${dim(result.urls.gatewayHealth)}\n`);
  stdout.write(`\n${bold("Hashes")}\n`);
  stdout.write(`  receiptId     ${result.receiptId}\n`);
  stdout.write(`  blockHash     ${result.blockHash}\n`);
  stdout.write(`  rootHash      ${result.bundle.rootHash}\n`);
  stdout.write(`  merkleRoot    ${result.bundle.merkleRoot}\n`);
  if (result.certHash) {
    stdout.write(`  certHash      ${result.certHash}\n`);
  }
  return 0;
}

async function cmdWhoami() {
  const sdk = await loadSdk();
  // Use loadOrCreateIdentity, which creates on first run. If the dev
  // explicitly wants to refuse auto-create, they can rm the file before
  // calling whoami — but the spec is "frictionless first call", so we
  // create.
  const identity = await sdk.loadOrCreateIdentity({
    configPath: env.ORYNQ_CONFIG_PATH,
  });
  stdout.write(`${identity.address}\n`);
  if (env.ORYNQ_VERBOSE === "1") {
    stdout.write(`${dim("config: " + identity.configPath)}\n`);
    stdout.write(`${dim("generatedAt: " + identity.generatedAt)}\n`);
  }
  return 0;
}

async function cmdStatus() {
  const sdk = await loadSdk();
  const gateway = env.ORYNQ_GATEWAY_URL ?? sdk.DEFAULT_GATEWAY_URL;
  const base = gateway.replace(/\/blobs\/?$/, "").replace(/\/$/, "");
  // /status is the cluster-wide rollup (gateway + cert-daemon + anchor-worker).
  // /health is gateway-only. Prefer /status so the dev sees finality + L1
  // anchor health at a glance.
  const url = `${base}/status`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    stderr.write(`${red("error")} could not reach ${url}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const text = await res.text();
  if (!res.ok) {
    stderr.write(`${red("error")} HTTP ${res.status} from ${url}\n${text}\n`);
    return 1;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    stdout.write(text);
    return 0;
  }
  stdout.write(`${bold("Materios")} ${cyan(base)}\n`);
  stdout.write(`  status        ${parsed.overall ?? parsed.status ?? "unknown"}\n`);
  if (parsed.components?.gateway) {
    const g = parsed.components.gateway;
    stdout.write(`  uptime        ${Math.round((g.uptime ?? 0) / 60)}m\n`);
    stdout.write(`  totalReceipts ${g.storage?.totalReceipts ?? "?"}\n`);
  }
  if (parsed.components?.certDaemonAlice) {
    const c = parsed.components.certDaemonAlice;
    stdout.write(`  bestBlock     ${c.bestBlock}\n`);
    stdout.write(`  finalityGap   ${c.finalityGap}\n`);
  }
  if (parsed.components?.anchorWorker) {
    const a = parsed.components.anchorWorker;
    stdout.write(`  anchorCount   ${a.anchorCount}\n`);
    stdout.write(`  cardanoTxs    last=${a.lastTxHash?.slice(0, 12) ?? "?"}...\n`);
  }
  return 0;
}

async function main() {
  const cmd = argv[2] ?? "help";
  try {
    switch (cmd) {
      case "init":
        return await cmdInit();
      case "trace":
        return await cmdTrace();
      case "whoami":
        return await cmdWhoami();
      case "status":
        return await cmdStatus();
      case "help":
      case "--help":
      case "-h":
        printUsage();
        return 0;
      case "--version":
      case "-v": {
        const sdk = await loadSdk();
        stdout.write(`orynq-sdk-quickstart ${sdk.VERSION} (node ${nodeVersion})\n`);
        return 0;
      }
      default:
        stderr.write(`${red("error")} unknown command: ${cmd}\n\n`);
        printUsage();
        return 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // User-facing errors carry a leading-lowercase, no-trailing-period
    // convention. Internal errors print the full stack.
    if (err instanceof Error && /^[a-z]/.test(msg) && !/^Error:/.test(msg)) {
      stderr.write(`${red("error")} ${msg}\n`);
      return 1;
    }
    stderr.write(`${red("internal error")}\n`);
    if (err instanceof Error && err.stack) stderr.write(err.stack + "\n");
    else stderr.write(String(err) + "\n");
    return 2;
  }
}

main().then((code) => exit(code ?? 0));
