// Compiles the conduct circuits into the gitignored conduct-managed/ and pins their deterministic outputs.
//   node scripts/compile-conduct.mjs --write|--check [--units predicate,mutants,reference]
// Build-order rule: node builtins only, because build:circuits runs before the workspace is built.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const circuits = join(root, "circuits/conduct");
const reference = join(circuits, "reference");
const managed = join(root, "conduct-managed");
const pinsFile = join(circuits, "pins.json");
const UNITS = ["predicate", "mutants", "reference"];

const usage = `usage: compile-conduct.mjs --write|--check [--units ${UNITS.join(",")}]`;
let mode;
let unitList;
for (const args = process.argv.slice(2); args.length > 0;) {
  const arg = args.shift();
  if ((arg === "--check" || arg === "--write") && mode === undefined) mode = arg;
  else if (arg === "--units" && unitList === undefined && args.length > 0) unitList = args.shift();
  else throw new Error(usage);
}
if (mode === undefined) throw new Error(usage);
const check = mode === "--check";
const units = unitList === undefined ? UNITS : [...new Set(unitList.split(","))];
for (const unit of units) if (!UNITS.includes(unit)) throw new Error(`unknown conduct unit: ${unit}`);
const partial = units.length < UNITS.length;

const PREDICATE_SOURCES = ["predicate.compact", "verdict_core.compact"];
const mutants = JSON.parse(await readFile(join(circuits, "mutants.json"), "utf8"));
const mutantIds = new Set();
for (const { id, file, find } of mutants) {
  if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`mutant id ${JSON.stringify(id)} must be lowercase letters, digits and underscores`);
  if (mutantIds.has(id)) throw new Error(`mutant id ${id} is repeated`);
  mutantIds.add(id);
  if (!PREDICATE_SOURCES.includes(file)) throw new Error(`mutant ${id} must edit one of ${PREDICATE_SOURCES.join(", ")}`);
  if ((await readFile(join(circuits, file), "utf8")).split(find).length !== 2) throw new Error(`mutant ${id} does not apply exactly once`);
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sourcePaths = (await readdir(circuits, { recursive: true })).filter(name => /^(?!pins\.json$).*\.(compact|json)$/.test(name)).map(name => `circuits/conduct/${name}`);
const sources = {};
for (const path of sourcePaths.sort()) sources[path] = sha256(await readFile(join(root, path)));

const committed = await readFile(pinsFile, "utf8").catch(error => {
  if (error.code !== "ENOENT") throw error;
  return "";
});
const committedPins = committed ? JSON.parse(committed) : { sources: {}, units: {} };
for (const unit of Object.keys(committedPins.units)) if (!UNITS.includes(unit)) throw new Error(`pins.json names unknown conduct unit: ${unit}`);
// A pin survives only by being rebuilt: --check never compares a unit against itself, and a partial --write keeps the
// pins of skipped units only while the sources they were built from are unchanged.
if (check) {
  for (const unit of Object.keys(committedPins.units)) if (!units.includes(unit)) throw new Error(`--check must rebuild every pinned unit: ${unit} is not selected`);
} else if (partial && committed && !isDeepStrictEqual(committedPins.sources, sources)) {
  throw new Error("sources changed since pins.json was written; run --write without --units");
}

const compiler = process.env.COMPACTC ?? "compactc";
const tool = (file, argv) => execFileSync(file, argv, { encoding: "utf8", maxBuffer: 65536 }).trim();
if (tool(compiler, ["--version"]) !== "0.31.1") throw new Error("Compact compiler 0.31.1 is required");
const zkir = process.env.ZKIR ?? (process.env.COMPACTC ? join(dirname(compiler), "zkir") : "zkir");
const toolchain = { compactc: "0.31.1", language: tool(compiler, ["--language-version"]), runtime: tool(compiler, ["--runtime-version"]), zkir: tool(zkir, ["--version"]) };
if (toolchain.zkir !== "midnight-zkir 2.1.0") throw new Error("midnight-zkir 2.1.0 is required");

// The source map names its sources relative to the compile's working directory; rooting it there lets a loader that
// reads the map, such as vitest, find them.
async function compile(sourceDir, entry, out) {
  execFileSync(compiler, ["--skip-zk", entry, out], { cwd: sourceDir, encoding: "utf8", maxBuffer: 65536 });
  const mapFile = join(out, "contract/index.js.map");
  const map = JSON.parse(await readFile(mapFile, "utf8"));
  await writeFile(mapFile, JSON.stringify({ ...map, sourceRoot: `${relative(dirname(mapFile), sourceDir)}/` }));
}

async function withScratch(prefix, body) {
  const scratch = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await body(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// Writes the predicate sources with one file edited into `sourceDir`, then compiles them from there.
async function compileEditedPredicate(file, edit, sourceDir, out) {
  await mkdir(sourceDir, { recursive: true });
  for (const name of PREDICATE_SOURCES) {
    const text = await readFile(join(circuits, name), "utf8");
    await writeFile(join(sourceDir, name), name === file ? edit(text) : text);
  }
  await compile(sourceDir, "predicate.compact", out);
}

const zkirFiles = async dir => (await readdir(join(dir, "zkir"))).filter(name => name.endsWith(".zkir")).sort();

function opsOf(ir) {
  const counts = {};
  for (const { op } of ir.instructions) counts[op] = (counts[op] ?? 0) + 1;
  return { total: ir.instructions.length, persistent_hash: 0, ...Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))) };
}

// zkir writes the .bzkir beside its input, so it only ever runs on a scratch copy.
async function mockCompile(out) {
  const pins = {};
  const dir = join(out, "zkir");
  for (const file of await zkirFiles(out)) {
    const name = file.slice(0, -".zkir".length);
    const ir = await readFile(join(dir, file));
    pins[name] = await withScratch("conduct-zkir-", async scratch => {
      await writeFile(join(scratch, file), ir);
      const run = spawnSync(zkir, ["mock-compile", "-v", join(scratch, file)], { encoding: "utf8", maxBuffer: 65536 });
      if (run.error || run.status !== 0) throw new Error(`zkir mock-compile ${file} failed: ${run.error?.message ?? run.stderr}`);
      const size = /Mock compiling circuit "[^"]*" \(k=(\d+), rows=(\d+)\)/.exec(run.stderr);
      if (!size) throw new Error(`zkir mock-compile ${file} reported no k and rows`);
      await copyFile(join(scratch, `${name}.bzkir`), join(dir, `${name}.bzkir`));
      return { zkirSha256: sha256(ir), k: Number(size[1]), rows: Number(size[2]), ops: opsOf(JSON.parse(ir)) };
    });
  }
  return pins;
}

// The parity tests call the exported pure circuits; the proof statement must not depend on their being exported. A
// second compile with every pure circuit unexported must yield the same ZKIR.
async function requireExportInvariance(out) {
  await withScratch("conduct-unexported-", async scratch => {
    const unexported = join(scratch, "out");
    await compileEditedPredicate("predicate.compact", text => {
      const demoted = text.replace(/^export pure circuit /gm, "pure circuit ");
      if (demoted === text) throw new Error("predicate.compact exports no pure circuit");
      return demoted;
    }, join(scratch, "source"), unexported);
    const names = await zkirFiles(out);
    if (!isDeepStrictEqual(await zkirFiles(unexported), names)) throw new Error("the provable circuits depend on which pure circuits are exported");
    for (const name of names) {
      const [exported, demoted] = await Promise.all([out, unexported].map(dir => readFile(join(dir, "zkir", name))));
      if (!exported.equals(demoted)) throw new Error(`${name} depends on which pure circuits are exported`);
    }
  });
}

const build = {
  async predicate() {
    const out = join(managed, "predicate");
    await rm(out, { recursive: true, force: true });
    await compile(circuits, "predicate.compact", out);
    const circuitPins = await mockCompile(out);
    await requireExportInvariance(out);
    return { pureExportInvariant: true, circuits: circuitPins };
  },
  async mutants() {
    await rm(join(managed, "mutants"), { recursive: true, force: true });
    // A mutant keeps its edited sources in source/, which its source map names and the structure audit reads.
    for (const mutant of mutants) {
      const out = join(managed, "mutants", mutant.id);
      await compileEditedPredicate(mutant.file, text => text.replace(mutant.find, () => mutant.replace), join(out, "source"), out);
      await mockCompile(out);
    }
  },
  async reference() {
    const out = join(managed, "reference/poac");
    await rm(out, { recursive: true, force: true });
    await compile(reference, "poac_verdict_core.compact", out);
  },
};

const rebuilt = {};
for (const unit of units) {
  const pins = await build[unit]();
  if (pins) rebuilt[unit] = pins;
}
const kept = check || !partial ? {} : committedPins.units;
const pinnedUnits = {};
for (const unit of UNITS) {
  const pins = rebuilt[unit] ?? kept[unit];
  if (pins) pinnedUnits[unit] = pins;
}

const encoded = JSON.stringify({ version: 1, toolchain, sources, units: pinnedUnits }, null, 2) + "\n";
if (check) {
  if (committed !== encoded) throw new Error("Conduct circuits differ from their pins");
} else await writeFile(pinsFile, encoded);
console.log(check ? "Conduct circuits reproduce their pins" : "Compiled and pinned conduct circuits");
