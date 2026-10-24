// After publish: installs what the pack step packed from the registry, each package alone
// and all of them together, imports each one, and requires one physical copy of every
// WASM-carrying singleton in every layout. Two copies of a WASM module hold two heaps, so
// an object made by one is rejected by the other at runtime.
//   node tools/release-guard/post-publish-check.mjs PACKED_DIR [REGISTRY]
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const SINGLETONS = [
  "@midnight-ntwrk/ledger-v8",
  "@midnight-ntwrk/onchain-runtime-v3",
  "@midnight-ntwrk/compact-runtime",
  "@midnight-ntwrk/zkir-v2",
];

export function packedSpecs(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tgz"))
    .map((f) => {
      const { name, version } = JSON.parse(execFileSync("tar", ["-xzOf", join(dir, f), "package/package.json"], { encoding: "utf8" }));
      return `${name}@${version}`;
    })
    .sort();
}

// Every physical copy under node_modules, followed through symlinks and counted once per real path.
export function singletonCopies(projectDir, singletons) {
  const found = Object.fromEntries(singletons.map((s) => [s, new Map()]));
  const seen = new Set();
  const visit = (nodeModules) => {
    if (!existsSync(nodeModules)) return;
    for (const entry of readdirSync(nodeModules)) {
      if (entry.startsWith(".")) continue;
      const names = entry.startsWith("@") ? readdirSync(join(nodeModules, entry)).map((n) => `${entry}/${n}`) : [entry];
      for (const name of names) {
        const real = realpathSync(join(nodeModules, name));
        if (seen.has(real)) continue;
        seen.add(real);
        if (found[name]) found[name].set(real, JSON.parse(readFileSync(join(real, "package.json"), "utf8")).version);
        visit(join(real, "node_modules"));
      }
    }
  };
  visit(join(projectDir, "node_modules"));
  return Object.fromEntries(Object.entries(found).map(([name, copies]) => [name, [...copies.values()].sort()]));
}

const nameOf = (spec) => spec.slice(0, spec.lastIndexOf("@"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function served(spec, registry, { attempts, delayMs }) {
  const name = nameOf(spec), version = spec.slice(spec.lastIndexOf("@") + 1);
  const url = `${registry.replace(/\/$/, "")}/${name.replace("/", "%2f")}`;
  for (let i = 1; i <= attempts; i++) {
    let res, metadata;
    try {
      res = await fetch(url, { headers: { accept: "application/vnd.npm.install-v1+json", "cache-control": "no-cache" } });
      if (res.ok) {
        const body = await res.text();
        try { metadata = JSON.parse(body); } catch { throw new Error(`${spec}: unreadable registry install metadata`); }
      } else await res.body?.cancel();
    } catch (error) {
      const code = error?.cause?.code ?? error?.code;
      if (!["ECONNRESET", "UND_ERR_SOCKET"].includes(code) || i === attempts) throw error;
      await sleep(delayMs);
      continue;
    }
    if (res.ok) {
      if (metadata?.name !== name || !metadata.versions || typeof metadata.versions !== "object" || Array.isArray(metadata.versions)) throw new Error(`${spec}: invalid registry install metadata`);
      const target = metadata.versions[version];
      if (target?.name === name && target.version === version) return true;
      if (target !== undefined) throw new Error(`${spec}: inconsistent registry version metadata`);
    } else if (res.status !== 404) throw new Error(`${spec}: registry answered HTTP ${res.status}`);
    if (i < attempts) await sleep(delayMs);
  }
  return false;
}

const lastLine = (text) => String(text).trim().split("\n").filter(Boolean).at(-1) ?? "";
const errorLine = (text) => String(text).split("\n").find((l) => /\b\w*Error\b/.test(l))?.trim() ?? lastLine(text);

async function importProblem(dir, spec) {
  const manifest = JSON.parse(readFileSync(join(dir, "node_modules", nameOf(spec), "package.json"), "utf8"));
  if (!manifest.exports && !manifest.main) {
    const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
    const missing = bins.filter((b) => !existsSync(join(dir, "node_modules", nameOf(spec), b)));
    if (!bins.length) return `${spec}: neither importable nor a bin`;
    return missing.length ? `${spec}: bin files missing: ${missing.join(", ")}` : null;
  }
  // A package may start a server on import; exiting right after evaluation keeps that from hanging the check.
  const script = `await import(${JSON.stringify(nameOf(spec))}); process.exit(0);`;
  try {
    await exec("node", ["--input-type=module", "-e", script], { cwd: dir, timeout: 60_000 });
    return null;
  } catch (e) {
    return `${spec}: import failed: ${errorLine(e.stderr) || e.message}`;
  }
}

async function checkLayout(specs, { registry, singletons }, importsToCheck) {
  const dir = mkdtempSync(join(tmpdir(), "post-publish-probe-"));
  const label = specs.join(" + ");
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "post-publish-probe", private: true, type: "module" }));
    try {
      await exec("npm", ["i", "--ignore-scripts", "--prefer-online", "--no-audit", "--no-fund", "--loglevel=error", `--registry=${registry}`, ...specs], {
        cwd: dir,
        maxBuffer: 64 << 20,
      });
    } catch (e) {
      const npmCode = /^npm (?:error|ERR!) code ([A-Z][A-Z0-9_]{0,63})\s*$/m.exec(String(e.stderr))?.[1] ?? "unavailable";
      const exit = Number.isSafeInteger(e.code) ? e.code : "unavailable";
      return { problems: [`${label}: npm install failed (exit=${exit}, npm=${npmCode})`], layout: null };
    }
    const problems = [];
    for (const spec of importsToCheck) {
      const problem = await importProblem(dir, spec);
      if (problem) problems.push(problem);
    }
    const copies = singletonCopies(dir, singletons);
    for (const [name, versions] of Object.entries(copies)) {
      if (versions.length > 1) problems.push(`${label}: ${name} has ${versions.length} copies (${versions.join(", ")})`);
    }
    return { problems, layout: { specs, copies: Object.fromEntries(Object.entries(copies).filter(([, v]) => v.length)) } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function checkLayouts(specs, { registry, singletons = SINGLETONS, visibility = { attempts: 30, delayMs: 10_000 } }) {
  const problems = [];
  const visible = [];
  for (const spec of specs) {
    if (await served(spec, registry, visibility)) visible.push(spec);
    else problems.push(`${spec}: not served by the registry after ${visibility.attempts} attempts`);
  }
  const layouts = [];
  const plans = visible.map((spec) => [[spec], [spec]]);
  if (visible.length > 1) plans.push([visible, []]);
  for (const [layoutSpecs, imports] of plans) {
    const result = await checkLayout(layoutSpecs, { registry, singletons }, imports);
    problems.push(...result.problems);
    if (result.layout) layouts.push(result.layout);
  }
  return { problems, layouts };
}

async function main(dir, registry) {
  const specs = packedSpecs(dir);
  if (!specs.length) {
    console.log(`post-publish-check: nothing was packed in ${dir}`);
    return 0;
  }
  const { problems, layouts } = await checkLayouts(specs, { registry });
  for (const p of problems) console.error(`post-publish-check: ${p}`);
  if (problems.length) return 1;
  console.log(`post-publish-check: ${specs.join(" ")} installed from ${registry} in ${layouts.length} layouts, imported, one copy of each singleton`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, registry = "https://registry.npmjs.org"] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: node tools/release-guard/post-publish-check.mjs PACKED_DIR [REGISTRY]");
    process.exit(2);
  }
  main(dir, registry).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`post-publish-check: ${error.message}`);
      process.exit(1);
    },
  );
}
