#!/usr/bin/env node
/**
 * Command-line interface for @fluxpointstudios/orynq-observe.
 *
 * Subcommands:
 *   keygen  — generate an sr25519 observer keyfile.
 *   submit  — sign + POST an ai_capability_observation_v1 record.
 *
 * Mirrors the Python CLI flag-for-flag. Exit codes:
 *     0 success
 *     1 configuration error
 *     2 observation / canonical error
 *     3 network / gateway error
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { ObserverKeypair, InvalidKeyfileError } from "./keypair.js";
import { Observation, ObservationError } from "./observation.js";
import { GatewayError, SubmitError } from "./submit.js";
import { type Severity, SEVERITIES, type TeeTier } from "./canonical.js";

function fail(message: string, code: number): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

async function cmdKeygen(args: Record<string, string | undefined>) {
  if (!args.out) fail("--out is required", 1);
  const kp = args.seed
    ? await ObserverKeypair.fromSeedHex(args.seed)
    : await ObserverKeypair.generate();
  kp.save(args.out);
  process.stdout.write(
    JSON.stringify(
      {
        scheme: ObserverKeypair.SCHEME,
        public_hex: kp.publicHex,
        ss58_address: kp.ss58Address,
        keyfile: args.out,
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}

async function cmdSubmit(args: Record<string, string | undefined>) {
  for (const required of [
    "model",
    "model-version",
    "taxonomy",
    "severity",
    "observer-context",
    "prompt-file",
    "response-file",
    "wallet",
    "api-key",
  ]) {
    if (!args[required]) fail(`--${required} is required`, 1);
  }
  if (!SEVERITIES.includes(args.severity as Severity)) {
    fail(`--severity must be one of ${SEVERITIES.join(",")}`, 1);
  }
  let kp: ObserverKeypair;
  try {
    kp = await ObserverKeypair.load(args.wallet!);
  } catch (e) {
    fail(
      `could not load wallet: ${e instanceof InvalidKeyfileError ? e.message : String(e)}`,
      1,
    );
  }
  let obs: Observation;
  try {
    obs = new Observation({
      modelName: args.model!,
      modelVersion: args["model-version"]!,
      taxonomyId: args.taxonomy!,
      severity: args.severity as Severity,
      observerContext: args["observer-context"]!,
      modelHash: args["model-hash"] ?? null,
    });
    const prompt = readFileSync(args["prompt-file"]!, "utf-8");
    const response = readFileSync(args["response-file"]!, "utf-8");
    obs.addEvidence({ prompt, response });
    if (args.artifact) {
      await obs.addArtifact({
        pathOrRef: args.artifact,
        gatewayUrl: args["gateway-url"],
        apiKey: args["api-key"],
      });
    }
    if (args["tee-tier"] && args["tee-evidence"]) {
      const ev = readFileSync(args["tee-evidence"]!);
      let evHex = "";
      for (let i = 0; i < ev.length; i++) {
        evHex += ev[i].toString(16).padStart(2, "0");
      }
      obs.attestTee({
        tier: args["tee-tier"] as TeeTier,
        evidence: evHex,
      });
    }
  } catch (e) {
    if (e instanceof ObservationError) fail(`invalid observation: ${e.message}`, 2);
    throw e;
  }
  let receipt;
  try {
    receipt = await obs.submit({
      wallet: kp,
      network: (args.network ?? "preprod") as "preprod" | "mainnet",
      gatewayUrl: args["gateway-url"],
      apiKey: args["api-key"]!,
      timeoutSeconds: args["timeout-seconds"]
        ? Number(args["timeout-seconds"])
        : undefined,
    });
  } catch (e) {
    if (e instanceof GatewayError) {
      fail(`gateway rejected the observation: HTTP ${e.status} ${e.message}`, 3);
    }
    if (e instanceof SubmitError) {
      fail(`submit failed: ${e.message}`, 3);
    }
    throw e;
  }
  if (args["wait-for-anchor"]) {
    const deadline = Date.now() + Number(args["wait-for-anchor"]) * 1000;
    while (Date.now() < deadline) {
      await receipt.refresh({
        gatewayUrl:
          args["gateway-url"] ??
          `https://materios.fluxpointstudios.com/${args.network ?? "preprod"}-blobs`,
        apiKey: args["api-key"]!,
      });
      if (receipt.materiosTx && receipt.cardanoAnchorTx) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  process.stdout.write(
    JSON.stringify(
      {
        content_hash: receipt.contentHash,
        observer_ss58: receipt.observerSs58,
        gateway_status: receipt.gatewayStatus,
        materios_tx: receipt.materiosTx,
        cardano_anchor_tx: receipt.cardanoAnchorTx,
        accepted_at: receipt.acceptedAt,
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(
      "usage: orynq-observe <keygen|submit> [options]\n" +
        "  keygen --out <path> [--seed <hex>]\n" +
        "  submit --model <name> --model-version <v> --taxonomy <id>\n" +
        "         --severity <low|medium|high|critical>\n" +
        "         --observer-context <str>\n" +
        "         --prompt-file <path> --response-file <path>\n" +
        "         --wallet <keyfile> [--network preprod|mainnet]\n" +
        "         [--gateway-url <url>] --api-key <token>\n" +
        "         [--artifact <path-or-ref>] [--tee-tier <tier>]\n" +
        "         [--tee-evidence <path>] [--wait-for-anchor <secs>]\n",
    );
    process.exit(cmd ? 0 : 1);
  }

  const knownFlags: Record<string, { type: "string" | "boolean" }> = {
    out: { type: "string" },
    seed: { type: "string" },
    model: { type: "string" },
    "model-version": { type: "string" },
    "model-hash": { type: "string" },
    taxonomy: { type: "string" },
    severity: { type: "string" },
    "observer-context": { type: "string" },
    "prompt-file": { type: "string" },
    "response-file": { type: "string" },
    artifact: { type: "string" },
    "tee-tier": { type: "string" },
    "tee-evidence": { type: "string" },
    wallet: { type: "string" },
    network: { type: "string" },
    "gateway-url": { type: "string" },
    "api-key": { type: "string" },
    "timeout-seconds": { type: "string" },
    "wait-for-anchor": { type: "string" },
  };

  const { values } = parseArgs({
    args: argv.slice(1),
    options: knownFlags,
    strict: false,
  });
  const args = values as Record<string, string | undefined>;

  if (cmd === "keygen") return cmdKeygen(args);
  if (cmd === "submit") return cmdSubmit(args);
  fail(`unknown subcommand: ${cmd}`, 1);
}

main().catch((e) => {
  process.stderr.write(
    `fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`,
  );
  process.exit(1);
});
