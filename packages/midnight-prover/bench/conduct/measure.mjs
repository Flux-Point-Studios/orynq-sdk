// Real keys, real proofs and native verification for conduct circuits whose k has installed, pinned parameters.
//   node bench/conduct/measure.mjs --out <dir outside the repository> --circuits a,b [--reps 3] --native <verifier> [--dry-run]
// For each circuit: a one-circuit contract written by the unit's own generator is keyed twice (its ZKIR must equal the
// unit's pin and the two verifier keys must agree), proved --reps times, and each proof is judged by the native
// verifier, as are four bit flips of the proof and a zeroed proof. Evidence is written under --out only. Timings are
// evidence of this host on this run, never pins. It refuses, with exit 2 and before it starts any tool: a circuit
// whose k has no installed pinned parameters, an --out inside the repository, and a parameter source that could
// download. It needs the workspace built (pnpm build) for the runtime packages it loads.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, release, type as osType } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repo = resolve(pkg, "../..");
const FAIL_CLOSED = "http://127.0.0.1:9/";
const MAX_K = 16;
const usage = "usage: measure.mjs --out <dir outside the repository> --circuits a,b [--reps 1-9] --native <orynq-midnight-verifier> [--dry-run]";

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const options = { reps: "3" };
for (const args = process.argv.slice(2); args.length > 0;) {
  const arg = args.shift();
  if (arg === "--dry-run" && options.dryRun === undefined) options.dryRun = true;
  else if (["--out", "--circuits", "--reps", "--native"].includes(arg) && args.length > 0 && !Object.hasOwn(options, `given${arg}`)) {
    options[arg.slice(2)] = args.shift();
    options[`given${arg}`] = true;
  } else refuse(usage);
}
if (options.out === undefined || options.circuits === undefined || (!options.dryRun && options.native === undefined)) refuse(usage);
if (!/^[1-9]$/.test(options.reps)) refuse("--reps must be a whole number from 1 to 9");
const reps = Number(options.reps);

// A missing parameter file must fail closed: the tools fetch from this source, and nothing listens there.
if (process.env.MIDNIGHT_PARAM_SOURCE !== FAIL_CLOSED) refuse(`MIDNIGHT_PARAM_SOURCE must be ${FAIL_CLOSED}, so that a missing parameter file fails closed instead of downloading`);

// The deepest existing ancestor decides where a new directory would really be.
function realPath(path) {
  let existing = resolve(path);
  const rest = [];
  while (!existsSync(existing)) {
    rest.unshift(existing.slice(dirname(existing).length + 1));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...rest);
}
const out = realPath(options.out);
const inside = (path, dir) => path === dir || path.startsWith(dir + sep);
// The checkout, and where this checkout is a linked worktree, the main checkout that holds the repository: read from
// the worktree's .git file and its commondir, so that no tool is started before a refusal. A repository whose main
// checkout lies elsewhere than beside its .git directory is not followed.
function repositoryRoots() {
  const roots = [realpathSync(repo)];
  const link = join(repo, ".git");
  if (existsSync(link) && statSync(link).isFile()) {
    const gitDir = /^gitdir: (.+)$/m.exec(readFileSync(link, "utf8"))?.[1];
    const pointer = gitDir === undefined ? undefined : join(resolve(repo, gitDir), "commondir");
    if (pointer !== undefined && existsSync(pointer)) roots.push(realpathSync(dirname(resolve(dirname(pointer), readFileSync(pointer, "utf8").trim()))));
  }
  return roots;
}
if (repositoryRoots().some(dir => inside(out, dir))) refuse("evidence must be written outside the repository");

const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const conductPins = readJson(join(pkg, "circuits/conduct/pins.json"));
const benchPins = readJson(join(pkg, "bench/conduct/pins.json"));
const benchSpec = readJson(join(pkg, "bench/conduct/bench.json"));
/** Every pinned provable circuit: its unit or bench group, and its pin. */
const pinned = new Map();
for (const [unit, { circuits }] of Object.entries(conductPins.units)) for (const [id, pin] of Object.entries(circuits)) pinned.set(id, { unit, pin });
for (const [group, { circuits }] of Object.entries(benchPins.groups)) for (const [id, pin] of Object.entries(circuits)) pinned.set(id, { unit: "bench", group, pin });

// The parameter files the installer pins, by k.
const paramPins = Object.fromEntries([...readFileSync(join(repo, "tools/compactc/compactc.sha256"), "utf8").matchAll(/^([0-9a-f]{64}) {2}bls_midnight_2p(\d+)$/gm)].map(([, hash, k]) => [k, hash]));
const paramsDir = process.env.MIDNIGHT_PP;
if (paramsDir === undefined) refuse("MIDNIGHT_PP must name the directory of the installed proving parameters");

const selected = [...new Set(options.circuits.split(","))];
for (const id of selected) if (!pinned.has(id)) refuse(`unknown conduct circuit: ${id}`);
for (const id of selected) {
  const { k } = pinned.get(id).pin;
  const present = existsSync(join(paramsDir, `bls_midnight_2p${k}`));
  if (!present) refuse(`params 2p${k} absent; refusing download`);
  if (k > MAX_K) refuse(`${id} is pinned at k=${k}; keys and proofs above k=${MAX_K} are out of scope`);
  if (!Object.hasOwn(paramPins, String(k))) refuse(`params 2p${k} are not pinned by the installer; refusing to use them`);
}

const plan = selected.map(id => ({ id, unit: pinned.get(id).unit, k: pinned.get(id).pin.k, params: `bls_midnight_2p${pinned.get(id).pin.k}` }));
if (options.dryRun) {
  process.stdout.write(`${JSON.stringify({ dryRun: true, reps, paramSource: FAIL_CLOSED, circuits: plan }, null, 2)}\n`);
  process.exit(0);
}

// ---- Everything below starts tools and loads the runtime. ----
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const native = resolve(options.native);
if (!existsSync(native)) refuse(`native verifier not found: ${native}`);
const compiler = process.env.COMPACTC ?? "compactc";
const version = spawnSync(compiler, ["--version"], { encoding: "utf8" }).stdout?.trim();
if (version !== "0.31.1") refuse("Compact compiler 0.31.1 is required");
for (const { k } of plan) {
  const file = join(paramsDir, `bls_midnight_2p${k}`);
  if (sha256(readFileSync(file)) !== paramPins[k]) refuse(`params 2p${k} differ from the installer's pin`);
}

const { emitBench, benchInput, mandateInput, oneCircuitSource, sampleEventInput, BENCH_INCLUDES } = await import(pathToFileURL(join(pkg, "scripts/conduct/bench.mjs")).href);
const runtime = await import("@midnight-ntwrk/compact-runtime");
const ledger = await import("@midnightntwrk/ledger-v8");
const { provingProvider } = await import("@midnightntwrk/zkir-v2");
const circuitsDir = join(pkg, "circuits/conduct");

const text = command => {
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};
const thermal = () => {
  const zones = text(["sh", "-c", "cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null"]);
  return zones ? zones.split("\n").map(Number) : null;
};
const host = () => ({ loadavg: readFileSync("/proc/loadavg", "utf8").trim(), thermalMilliC: thermal(), at: new Date().toISOString() });

// A child's wall time and its peak resident set, from /usr/bin/time where it exists and Python's rusage otherwise.
function timed(command, env, cwd) {
  const started = process.hrtime.bigint();
  let result;
  let maxRssKb = null;
  let rssSource = "unmeasured: neither /usr/bin/time nor python3 is available";
  if (existsSync("/usr/bin/time")) {
    result = spawnSync("/usr/bin/time", ["-v", ...command], { encoding: "utf8", env, cwd, maxBuffer: 1 << 24 });
    const peak = /Maximum resident set size \(kbytes\): (\d+)/.exec(result.stderr ?? "");
    if (peak) [maxRssKb, rssSource] = [Number(peak[1]), "/usr/bin/time -v"];
  } else if (text(["python3", "-c", "print(1)"]) === "1") {
    const script = "import resource,subprocess,sys\nr=subprocess.run(sys.argv[1:])\nsys.stderr.write('\\nMAXRSS_KB %d\\n' % resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)\nsys.exit(r.returncode)";
    result = spawnSync("python3", ["-c", script, ...command], { encoding: "utf8", env, cwd, maxBuffer: 1 << 24 });
    const peak = /MAXRSS_KB (\d+)/.exec(result.stderr ?? "");
    if (peak) [maxRssKb, rssSource] = [Number(peak[1]), "python3 resource.getrusage(RUSAGE_CHILDREN)"];
  } else result = spawnSync(command[0], command.slice(1), { encoding: "utf8", env, cwd, maxBuffer: 1 << 24 });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.status !== 0) throw new Error(`${command[0]} failed: ${(result.stderr ?? "").slice(-2000)}`);
  return { wallMs, maxRssKb, rssSource };
}

// The one-circuit contract of a pinned circuit, as its unit's generator writes it, with the sources it includes.
function writeSource(id, dir) {
  const { unit, group } = pinned.get(id);
  mkdirSync(dir, { recursive: true });
  const copy = name => writeFileSync(join(dir, name), readFileSync(join(circuitsDir, name)));
  if (unit === "predicate") {
    for (const name of ["predicate.compact", "verdict_core.compact"]) copy(name);
    return "predicate.compact";
  }
  for (const name of BENCH_INCLUDES) copy(name);
  const source = unit === "bench"
    ? emitBench(group, { kind: benchSpec.groups[group].kind, circuits: { [id]: benchSpec.groups[group].circuits[id] } })
    : oneCircuitSource(unit, id);
  writeFileSync(join(dir, `${id}.compact`), source);
  return `${id}.compact`;
}

// An honest in-class input of a pinned circuit.
function inputOf(id) {
  const { unit, group } = pinned.get(id);
  if (unit === "bench") {
    const input = benchInput(benchSpec.groups[group].kind, id, benchSpec.groups[group].circuits[id]);
    if (input === undefined) throw new Error(`${id} has no honest input builder: it has rows and k only`);
    return { ...input, source: "synthetic in-class input from scripts/conduct/bench.mjs" };
  }
  if (unit === "openings" && id.startsWith("ev_")) return { ...sampleEventInput(id), source: "synthetic in-class event from scripts/conduct/bench.mjs" };
  if (unit === "openings") {
    const vectors = readJson(join(repo, "packages/conduct/tests/fixtures/mandate-vectors.json")).valid;
    for (const vector of vectors) {
      const input = mandateInput(Uint8Array.from(Buffer.from(vector.cborHex, "hex")));
      if (input.circuit === id) return { witnesses: input.witnesses, args: input.args, source: `mandate vector "${vector.name}" of packages/conduct/tests/fixtures/mandate-vectors.json` };
    }
  }
  throw new Error(`${id} has no honest input builder`);
}

const witnessFunctions = witnesses => Object.fromEntries(Object.entries(witnesses).map(([name, value]) =>
  [name, context => [context.privateState, value instanceof Uint8Array ? Array.from(value, BigInt) : value]]));
const toolEnv = { ...process.env, MIDNIGHT_PP: paramsDir, MIDNIGHT_PARAM_SOURCE: FAIL_CLOSED };
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
};

// Where the proof's own bytes start in its serialized body: after a tag byte and their length as a SCALE compact
// integer. A body that is not laid out so is not guessed at.
function payloadOffset(body) {
  for (const [width, mode] of [[1, 0], [2, 1], [4, 2]]) {
    const encoded = body.readUIntLE(1, width);
    if ((encoded & 3) === mode && encoded >>> 2 === body.length - 1 - width) return 1 + width;
  }
  throw new Error("the proof body is not a tag byte, a compact length and the proof bytes");
}

function nativeVerdict(registry, circuitId, transaction, state) {
  const request = { circuitId, transactionBase64: Buffer.from(transaction).toString("base64"), referenceStateBase64: Buffer.from(state).toString("base64") };
  const result = spawnSync(native, ["--registry", registry], { input: JSON.stringify(request), encoding: "utf8" });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { valid: false, code: `unparsed: ${(result.stdout ?? "").slice(0, 200)}` };
  }
}

async function measure(id) {
  const { unit, group, pin } = pinned.get(id);
  const work = join(out, "work", id);
  rmSync(work, { recursive: true, force: true });
  const before = host();
  const entry = writeSource(id, join(work, "source"));
  // The generated contract imports the Compact runtime, which it resolves through the package's own dependencies.
  symlinkSync(join(pkg, "node_modules"), join(work, "node_modules"), "dir");
  // Keygen twice, each a full compile from the same source.
  const builds = [];
  for (const run of ["a", "b"]) {
    const dir = join(work, `build-${run}`);
    const cost = timed([compiler, entry, dir], toolEnv, join(work, "source"));
    builds.push({ dir, ...cost });
  }
  const artifact = (dir, name) => readFileSync(join(dir, name));
  const [first, second] = builds;
  const verifierKey = artifact(first.dir, `keys/${id}.verifier`);
  const proverKey = artifact(first.dir, `keys/${id}.prover`);
  const keygen = {
    wallMs: builds.map(b => b.wallMs), maxRssKb: builds.map(b => b.maxRssKb), rssSource: first.rssSource,
    proverKeyBytes: proverKey.length, verifierKeyBytes: verifierKey.length, proverKeySha256: sha256(proverKey), verifierKeySha256: sha256(verifierKey),
    vkReproducible: verifierKey.equals(artifact(second.dir, `keys/${id}.verifier`)),
    pkReproducible: proverKey.equals(artifact(second.dir, `keys/${id}.prover`)),
    zkirSha256: sha256(artifact(first.dir, `zkir/${id}.zkir`)),
    zkirMatchesUnit: sha256(artifact(first.dir, `zkir/${id}.zkir`)) === pin.zkirSha256,
  };

  // The trusted registry of this circuit: its verifier key in the operation of its initial contract state.
  const module = await import(pathToFileURL(join(first.dir, "contract/index.js")).href);
  const input = inputOf(id);
  const contract = new module.Contract(witnessFunctions(input.witnesses));
  const coinKey = ledger.sampleCoinPublicKey();
  const initial = contract.initialState(runtime.createConstructorContext(undefined, coinKey));
  const template = ledger.ContractState.deserialize(initial.currentContractState.serialize());
  const operation = new ledger.ContractOperation();
  operation.verifierKey = verifierKey;
  template.setOperation(id, operation);
  writeFileSync(join(first.dir, "initial-state.bin"), template.serialize());
  const circuitId = `conduct-${id}`;
  const registry = join(first.dir, "registry.json");
  writeFileSync(registry, `${JSON.stringify({ version: 1, circuits: { [circuitId]: { entryPoint: id, verifierKeyPath: `keys/${id}.verifier`, initialContractStatePath: "initial-state.bin" } } }, null, 2)}\n`);

  const provider = provingProvider({
    lookupKey: async name => (name === id ? { proverKey: new Uint8Array(proverKey), verifierKey: new Uint8Array(verifierKey), ir: new Uint8Array(artifact(first.dir, `zkir/${id}.bzkir`)) } : undefined),
    getParams: async k => {
      if (!Object.hasOwn(paramPins, String(k))) throw new Error("Unpinned proving parameters");
      const bytes = readFileSync(join(paramsDir, `bls_midnight_2p${k}`));
      if (sha256(bytes) !== paramPins[k]) throw new Error("Proving parameters differ from their pin");
      return new Uint8Array(bytes);
    },
  });
  const deploy = new ledger.ContractDeploy(template);
  const reference = ledger.LedgerState.blank("undeployed");
  const now = new Date();
  const seconds = BigInt(Math.floor(now.getTime() / 1000));
  const block = { secondsSinceEpoch: seconds, secondsSinceEpochErr: 0, parentBlockHash: "0".repeat(64), lastBlockTime: seconds - 1n };
  const ttl = new Date(now.getTime() + 3_000_000);
  const strictness = new ledger.WellFormedStrictness();
  strictness.enforceBalancing = false;
  const deployment = ledger.Transaction.fromParts("undeployed", undefined, undefined, ledger.Intent.new(ttl).addDeploy(deploy));
  const finalizedDeploy = (await deployment.prove(provider, ledger.CostModel.initialCostModel())).bind();
  const [state, applied] = reference.apply(finalizedDeploy.wellFormed(reference, strictness, now), new ledger.TransactionContext(reference, block));
  if (applied.type !== "success") throw new Error("the reference ledger state could not be initialized");
  const stateBytes = state.serialize();

  const proofs = [];
  let evidence;
  for (let rep = 0; rep < reps; rep++) {
    const run = new module.Contract(witnessFunctions(input.witnesses));
    const context = runtime.createCircuitContext(deploy.address, coinKey, initial.currentContractState, undefined);
    const data = run.circuits[id](context, ...input.args).proofData;
    const call = new ledger.PrePartitionContractCall(deploy.address, id, template.operation(id),
      new ledger.PreTranscript(new ledger.QueryContext(template.data, deploy.address), data.publicTranscript),
      data.privateTranscriptOutputs, data.input, data.output, ledger.communicationCommitmentRandomness(), id);
    const transaction = ledger.Transaction.fromParts("undeployed").addCalls({ tag: "first" }, [call], ledger.LedgerParameters.initialParameters(), ttl);
    const started = process.hrtime.bigint();
    const proven = (await transaction.prove(provider, ledger.CostModel.initialCostModel())).bind();
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
    const bytes = Buffer.from(proven.serialize());
    const [action] = [...proven.intents.values()].flatMap(intent => intent.actions);
    const tagged = Buffer.from(action.proof.serialize());
    const body = tagged.subarray(tagged.indexOf(":", tagged.indexOf(":") + 1) + 1);
    const at = bytes.indexOf(body);
    if (at <= 0 || bytes.indexOf(body, at + 1) !== -1) throw new Error("the proof bytes were not located in the transaction");
    const honest = nativeVerdict(registry, circuitId, bytes, stateBytes);
    const header = payloadOffset(body);
    const payload = body.length - header;
    proofs.push({ wallMs, proofBytes: payload, serializedProofBytes: body.length, taggedProofBytes: tagged.length, transactionBytes: bytes.length, native: honest });
    if (rep === 0) {
      // Four bit flips across the proof's own bytes and those bytes zeroed, each judged by the native verifier. The
      // serialized header (tag and length) is left intact, so the transaction still decodes and the proof is what fails.
      const flips = [0, Math.floor(payload / 3), Math.floor((2 * payload) / 3), payload - 1].map(offset => {
        const forged = Buffer.from(bytes);
        forged[at + header + offset] ^= 1;
        return { offset, ...nativeVerdict(registry, circuitId, forged, stateBytes) };
      });
      const zeroedBytes = Buffer.from(bytes);
      zeroedBytes.fill(0, at + header, at + body.length);
      const zeroed = nativeVerdict(registry, circuitId, zeroedBytes, stateBytes);
      // With its header zeroed too the transaction no longer decodes, which the verifier reports as such.
      const headerless = Buffer.from(bytes);
      headerless.fill(0, at, at + body.length);
      const zeroedWithHeader = nativeVerdict(registry, circuitId, headerless, stateBytes);
      // Which statement and witness bytes the serialized transaction carries in the clear.
      const present = value => (value instanceof Uint8Array && value.length >= 16 ? bytes.includes(Buffer.from(value)) : undefined);
      const statement = input.args[0] ?? {};
      const visible = {
        statementFields: Object.fromEntries(Object.entries(statement).filter(([, v]) => v instanceof Uint8Array && v.length >= 16).map(([name, v]) => [name, present(v)])),
        witnesses: Object.fromEntries(Object.entries(input.witnesses).filter(([, v]) => v instanceof Uint8Array && v.length >= 16).map(([name, v]) => [name, present(v)])),
      };
      evidence = { honest, flips, zeroed, zeroedWithHeader, visible };
    }
  }
  const processMaxRssKb = process.resourceUsage().maxRSS;
  rmSync(join(work, "build-b"), { recursive: true, force: true });
  return {
    id, unit, ...(group === undefined ? {} : { group }), k: pin.k, rows: pin.rows, input: input.source,
    keygen,
    proofs: { reps, wallMs: stats(proofs.map(p => p.wallMs)), proofBytes: proofs[0].proofBytes, serializedProofBytes: proofs[0].serializedProofBytes, taggedProofBytes: proofs[0].taggedProofBytes, transactionBytes: stats(proofs.map(p => p.transactionBytes)), runs: proofs, processMaxRssKbAfter: processMaxRssKb, processMaxRssNote: "peak of this node process across every circuit proved so far, not of one proof" },
    native: { honest: evidence.honest, allHonest: proofs.every(p => p.native.code === "verified"), flips: evidence.flips, zeroed: evidence.zeroed, zeroedWithHeader: evidence.zeroedWithHeader },
    transactionVisibility: evidence.visible,
    host: { before, after: host() },
  };
}

mkdirSync(out, { recursive: true });
const environment = {
  uname: text(["uname", "-a"]) ?? `${osType()} ${release()}`, nproc: availableParallelism(), node: process.version, rustc: text(["rustc", "-V"]), cargo: text(["cargo", "--version"]),
  compactc: version, zkir: text([process.env.ZKIR ?? join(dirname(compiler), "zkir"), "--version"]),
  nativeVerifier: { path: native, sha256: sha256(readFileSync(native)) },
  params: Object.fromEntries(Object.entries(paramPins).map(([k, hash]) => [`bls_midnight_2p${k}`, hash])),
  repositoryHead: text(["git", "-C", repo, "rev-parse", "HEAD"]), repositoryDirty: (text(["git", "-C", repo, "status", "--porcelain"]) ?? "") !== "",
  startedAt: new Date().toISOString(),
};
writeFileSync(join(out, "environment.json"), `${JSON.stringify(environment, null, 2)}\n`);

const summary = [];
let failed = false;
for (const id of selected) {
  process.stderr.write(`measuring ${id}\n`);
  const entry = await measure(id);
  writeFileSync(join(out, `${id}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  const sound = entry.native.allHonest && entry.native.flips.length === 4 && entry.native.flips.every(f => f.code === "invalid-proof") && entry.native.zeroed.code === "invalid-proof"
    && entry.keygen.vkReproducible && entry.keygen.zkirMatchesUnit;
  if (!sound) failed = true;
  summary.push(entry);
  writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

// Every other pinned circuit, with why this run has no key or proof of it.
const reason = ({ pin }) => (Object.hasOwn(paramPins, String(pin.k)) && pin.k <= MAX_K ? "not selected in this run" : `UNMEASURED: keys/proof need 2p${pin.k} params`);
const unmeasured = [...pinned].filter(([id]) => !selected.includes(id)).map(([id, entry]) => ({ id, unit: entry.unit, ...(entry.group === undefined ? {} : { group: entry.group }), k: entry.pin.k, rows: entry.pin.rows, ops: entry.pin.ops, status: reason(entry) }));
writeFileSync(join(out, "unmeasured.json"), `${JSON.stringify(unmeasured, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ measured: summary.map(e => e.id), unmeasured: unmeasured.length, out, sound: !failed })}\n`);
process.exit(failed ? 1 : 0);
