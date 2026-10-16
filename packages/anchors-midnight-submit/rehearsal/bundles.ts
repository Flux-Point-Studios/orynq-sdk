// Real process-trace bundles for the preprod rehearsal: each one traces a real, read-only
// process on this host (its command, exit code, timing, stdout digest and a bounded excerpt),
// finalized by @fluxpointstudios/orynq-sdk-process-trace, given its storage manifest and turned
// into an anchor entry by anchors-cardano, exactly as a recorder would. Every run pins, before
// execution, the manifest of the model that drove the rehearsal; for kind 2 its hash is the
// attribute anchor_hiding publishes. Each same-block round anchors a fresh pair, so every
// round's pair is traced and indexed here.
//   node --import tsx bundles.ts            writes bundles/<label>.json and bundles/index.json
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAnchorEntryFromBundle } from "@fluxpointstudios/orynq-sdk-anchors-cardano";
import { addEvent, addSpan, closeSpan, createManifest, createTrace, finalizeTrace, manifestFromAnthropic } from "@fluxpointstudios/orynq-sdk-process-trace";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const A = `${REPO}packages/anchors-midnight`;
const B = `${REPO}packages/anchors-midnight-submit`;
const ZK = `${process.env.HOME}/.cache/orynq-midnight/zk`;
const OUT = new URL("./bundles/", import.meta.url);
type Job = { label: string; cmd: string; args: string[]; cwd: string; kind: 1 | 2 };
const kind1 = (label: string, cmd: string, args: string[], cwd = REPO): Job => ({ label, cmd, args, cwd, kind: 1 });
const kind2 = (label: string, cmd: string, args: string[], cwd = REPO): Job => ({ label, cmd, args, cwd, kind: 2 });
const rpc = (method: string) => ["-sS", "-m", "20", "-X", "POST", "-H", "content-type: application/json", "-d", JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }), "https://rpc.preprod.midnight.network"];
const rounds = Array.from({ length: 20 }, (_, i) => i + 1);

const jobs: Job[] = [
  kind1("git-head", "git", ["rev-parse", "HEAD"]),
  kind1("contract-hashes", "sha256sum", ["-c", "HASHES.txt"], `${A}/contract`),
  kind1("compactc-version", `${process.env.HOME}/.cache/orynq-midnight/compactc/compactc`, ["--version"]),
  kind1("zk-material", "sha256sum", ["bls_midnight_2p13", "bls_midnight_2p14", "dust/9/spend.prover", "dust/9/spend.verifier", "dust/9/spend.bzkir"], ZK),
  kind1("preprod-chain", "curl", rpc("system_chain")),
  kind1("preprod-runtime", "curl", rpc("state_getRuntimeVersion")),
  kind1("preprod-ledger", "curl", rpc("midnight_ledgerVersion")),
  kind1("git-log", "git", ["log", "--oneline", "-12"]),
  kind1("commitment-suite", "npx", ["vitest", "run", "src/__tests__/commitment.test.ts"], A),
  kind1("node-version", "node", ["--version"]),
  kind1("pnpm-lock-midnight", "grep", ["-c", "@midnight-ntwrk/", "pnpm-lock.yaml"]),
  kind1("uname", "uname", ["-srm"]),
  ...rounds.flatMap((n) => [kind1(`same-block-a-${n}`, "date", ["-u", "+%Y-%m-%dT%H:%M:%S.%NZ"]), kind1(`same-block-b-${n}`, "date", ["-u", "+%s%N"])]),
  kind1("crash-before-broadcast", "git", ["status", "--short", "--branch"]),
  kind1("crash-after-broadcast", "sha256sum", ["src/registry.ts", "src/registry-call.ts"], A),
  kind1("rotation-old-before", "ls", ["-1", "src"], B),
  kind1("rotation-old-after", "ls", ["-1", "test"], B),
  kind1("rotation-new-after", "wc", ["-l", "src/operator.ts", "src/deployer.ts"], B),
  kind1("revoked-new-after", "wc", ["-c", "contract/HASHES.txt"], A),
  kind2("hidden-broadcast-suite", "npx", ["vitest", "run", "test/broadcast.test.ts"], B),
  kind2("hidden-relay-suite", "npx", ["vitest", "run", "test/relay.test.ts"], B),
  kind2("hidden-keys-suite", "npx", ["vitest", "run", "test/keys.test.ts"], B),
];

const model = await manifestFromAnthropic({ model: "claude-opus-5-5", snapshotId: "claude-opus-5-5[1m]" });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
mkdirSync(OUT, { recursive: true });
const index: unknown[] = [];
for (const job of jobs) {
  const run = await createTrace({ agentId: "orynq-midnight-preprod-rehearsal", description: job.label, metadata: { host: "gemtek", cwd: job.cwd }, manifest: model, strict: true });
  const span = addSpan(run, { name: job.label, visibility: "public" });
  const started = Date.now();
  const r = spawnSync(job.cmd, job.args, { cwd: job.cwd, encoding: "utf8", timeout: 300_000, env: { ...process.env, NO_COLOR: "1", MIDNIGHT_PP: ZK } });
  await addEvent<"command">(run, span.id, { kind: "command", command: job.cmd, args: job.args, cwd: job.cwd, exitCode: r.status ?? -1, visibility: "public" });
  await addEvent<"observation">(run, span.id, { kind: "observation", observation: `exit ${r.status} after ${Date.now() - started} ms`, category: "process", data: { stdoutSha256: sha(r.stdout ?? ""), stderrSha256: sha(r.stderr ?? ""), bytes: (r.stdout ?? "").length }, visibility: "public" });
  await addEvent<"output">(run, span.id, { kind: "output", stream: "stdout", content: (r.stdout ?? "").slice(0, 4096), truncated: (r.stdout ?? "").length > 4096, visibility: "private" });
  await closeSpan(run, span.id, r.status === 0 ? "completed" : "failed");
  const bundle = await finalizeTrace(run);
  const { manifest } = await createManifest(bundle);
  if (!manifest.manifestHash) throw new Error(`${job.label}: createManifest gave no manifestHash`);
  bundle.manifestHash = manifest.manifestHash;
  const entry = createAnchorEntryFromBundle(bundle);
  writeFileSync(new URL(`${job.label}.json`, OUT), JSON.stringify(bundle, null, 1));
  index.push({ label: job.label, kind: job.kind, exit: r.status, rootHash: entry.rootHash, manifestHash: entry.manifestHash, merkleRoot: entry.merkleRoot, modelManifestHash: bundle.modelManifestHash });
  console.log(job.label, job.kind, r.status, entry.rootHash.slice(0, 16));
}
writeFileSync(new URL("index.json", OUT), JSON.stringify(index, null, 1));
