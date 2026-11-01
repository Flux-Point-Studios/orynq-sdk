// Compiles the conduct circuits into the gitignored conduct-managed/ and pins their deterministic outputs.
//   node scripts/compile-conduct.mjs --write|--check [--units predicate,openings,mutants,reference]
// Build-order rule: node builtins and scripts/conduct only, because build:circuits runs before the workspace is built.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { emitOpenings } from "./conduct/template.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const circuits = join(root, "circuits/conduct");
const reference = join(circuits, "reference");
const managed = join(root, "conduct-managed");
const pinsFile = join(circuits, "pins.json");
const UNITS = ["predicate", "openings", "mutants", "reference"];
// The sources each compiled unit is built from, its entry first.
const UNIT_SOURCES = { predicate: ["predicate.compact", "verdict_core.compact"], openings: ["openings.generated.compact", "gadgets.compact"] };

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

const generatedFile = join(circuits, UNIT_SOURCES.openings[0]);
const generated = emitOpenings();
if (!check) await writeFile(generatedFile, generated);
else if (await readFile(generatedFile, "utf8").catch(() => undefined) !== generated) throw new Error("generated circuits differ from classes.json; run --write");

const unitOf = file => Object.keys(UNIT_SOURCES).find(unit => UNIT_SOURCES[unit].includes(file));
const mutants = JSON.parse(await readFile(join(circuits, "mutants.json"), "utf8"));
const mutantIds = new Set();
for (const { id, file, find } of mutants) {
  if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`mutant id ${JSON.stringify(id)} must be lowercase letters, digits and underscores`);
  if (mutantIds.has(id)) throw new Error(`mutant id ${id} is repeated`);
  mutantIds.add(id);
  if (unitOf(file) === undefined) throw new Error(`mutant ${id} must edit one of ${Object.values(UNIT_SOURCES).flat().join(", ")}`);
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

// Units, mutants and circuits build concurrently, with at most one compactc or zkir process per CPU. Every branch of a
// fan-out settles before its first failure is thrown, so no compiler outlives the script and every scratch is removed.
const execFileAsync = promisify(execFile);
async function settled(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  return results.map(result => result.value);
}
let freeSlots = availableParallelism();
const waiting = [];
async function run(file, argv, options = {}) {
  if (freeSlots > 0) freeSlots -= 1;
  else await new Promise(resolve => waiting.push(resolve));
  try {
    return await execFileAsync(file, argv, { encoding: "utf8", maxBuffer: 65536, ...options });
  } finally {
    const next = waiting.shift();
    if (next) next();
    else freeSlots += 1;
  }
}

// The source map names its sources relative to the compile's working directory; rooting it there lets a loader that
// reads the map, such as vitest, find them. compactc's standard library is built in and has no file, so it is marked
// virtual for loaders not to look for one.
const STANDARD_LIBRARY = "compiler/standard-library.compact";
async function compile(sourceDir, entry, out) {
  await run(compiler, ["--skip-zk", entry, out], { cwd: sourceDir });
  const mapFile = join(out, "contract/index.js.map");
  const map = JSON.parse(await readFile(mapFile, "utf8"));
  const sources = map.sources.map(source => (source === STANDARD_LIBRARY ? `virtual:${source}` : source));
  await writeFile(mapFile, JSON.stringify({ ...map, sources, sourceRoot: `${relative(dirname(mapFile), sourceDir)}/` }));
}

async function withScratch(prefix, body) {
  const scratch = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await body(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// Writes a unit's sources with one file edited into `sourceDir`, then compiles them from there.
async function compileEdited(unit, file, edit, sourceDir, out) {
  await mkdir(sourceDir, { recursive: true });
  for (const name of UNIT_SOURCES[unit]) {
    const text = await readFile(join(circuits, name), "utf8");
    await writeFile(join(sourceDir, name), name === file ? edit(text) : text);
  }
  await compile(sourceDir, UNIT_SOURCES[unit][0], out);
}

const zkirFiles = async dir => (await readdir(join(dir, "zkir"))).filter(name => name.endsWith(".zkir")).sort();

function opsOf(ir) {
  const counts = {};
  for (const { op } of ir.instructions) counts[op] = (counts[op] ?? 0) + 1;
  return { total: ir.instructions.length, persistent_hash: 0, ...Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))) };
}

// zkir writes the .bzkir beside its input, so it only ever runs on a scratch copy.
async function mockCompile(out) {
  const dir = join(out, "zkir");
  const files = await zkirFiles(out);
  const pins = await settled(files.map(async file => {
    const name = file.slice(0, -".zkir".length);
    const ir = await readFile(join(dir, file));
    return withScratch("conduct-zkir-", async scratch => {
      await writeFile(join(scratch, file), ir);
      const { stderr } = await run(zkir, ["mock-compile", "-v", join(scratch, file)]).catch(error => {
        throw new Error(`zkir mock-compile ${file} failed: ${error.stderr || error.message}`);
      });
      const size = /Mock compiling circuit "[^"]*" \(k=(\d+), rows=(\d+)\)/.exec(stderr);
      if (!size) throw new Error(`zkir mock-compile ${file} reported no k and rows`);
      await copyFile(join(scratch, `${name}.bzkir`), join(dir, `${name}.bzkir`));
      return [name, { zkirSha256: sha256(ir), k: Number(size[1]), rows: Number(size[2]), ops: opsOf(JSON.parse(ir)) }];
    });
  }));
  return Object.fromEntries(pins);
}

// The tests call the exported pure circuits; the proof statements must not depend on their being exported. A second
// compile with every pure circuit unexported must yield the same ZKIR.
async function requireExportInvariance(unit, out) {
  const entry = UNIT_SOURCES[unit][0];
  await withScratch("conduct-unexported-", async scratch => {
    const unexported = join(scratch, "out");
    await compileEdited(unit, entry, text => {
      const demoted = text.replace(/^export pure circuit /gm, "pure circuit ");
      if (demoted === text) throw new Error(`${entry} exports no pure circuit`);
      return demoted;
    }, join(scratch, "source"), unexported);
    const names = await zkirFiles(out);
    if (!isDeepStrictEqual(await zkirFiles(unexported), names)) throw new Error("the provable circuits depend on which pure circuits are exported");
    for (const name of names) {
      const [exported, demoted] = await settled([out, unexported].map(dir => readFile(join(dir, "zkir", name))));
      if (!exported.equals(demoted)) throw new Error(`${name} depends on which pure circuits are exported`);
    }
  });
}

async function pinnedUnit(unit) {
  const out = join(managed, unit);
  await rm(out, { recursive: true, force: true });
  await compile(circuits, UNIT_SOURCES[unit][0], out);
  const [circuitPins] = await settled([mockCompile(out), requireExportInvariance(unit, out)]);
  return { pureExportInvariant: true, circuits: circuitPins };
}

const build = {
  predicate: () => pinnedUnit("predicate"),
  openings: () => pinnedUnit("openings"),
  async mutants() {
    await rm(join(managed, "mutants"), { recursive: true, force: true });
    // A mutant keeps its edited sources in source/, which its source map names and the structure audit reads. Only the
    // predicate mutants are checked at ZKIR; the openings mutants are judged by their generated JS.
    await settled(mutants.map(async mutant => {
      const out = join(managed, "mutants", mutant.id);
      const unit = unitOf(mutant.file);
      await compileEdited(unit, mutant.file, text => text.replace(mutant.find, () => mutant.replace), join(out, "source"), out);
      if (unit === "predicate") await mockCompile(out);
    }));
  },
  async reference() {
    const out = join(managed, "reference/poac");
    await rm(out, { recursive: true, force: true });
    await compile(reference, "poac_verdict_core.compact", out);
  },
};

const rebuilt = Object.fromEntries(await settled(units.map(async unit => [unit, await build[unit]()])));
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
