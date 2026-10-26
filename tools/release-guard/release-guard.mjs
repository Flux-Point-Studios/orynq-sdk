// Refuses a release that npm would accept but that breaks installs:
//  - a public package with a runtime dependency on a private workspace package
//    (pnpm pack rewrites workspace:* to a version that never reaches npm),
//  - a public package with a runtime dependency on a local path (link:, file: or a bare
//    path, which npm publishes verbatim) or a spec npm cannot classify,
//  - a version npm would record differently (semver.clean), and
//  - an unpublished version below one already published (npm tags it latest
//    while ^ ranges keep resolving the higher one).
// Specs are classified by npm-package-arg, and local paths are compared after realpath, so a
// symlink cannot hide which package a path reaches. Versions are parsed and ordered by npm's
// own semver, prereleases included.
//   node tools/release-guard/release-guard.mjs [REGISTRY]
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import npa from "npm-package-arg";
import semver from "semver";

const RUNTIME_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];
const LOCAL_TYPES = new Set(["directory", "file"]);
// pnpm's workspace:<alias>@<range>; an alias never starts with ".", "_" or "/".
const WORKSPACE_ALIAS = /^([^._/][^@]*)@/;
const WORKSPACE_SHORTHANDS = new Set(["*", "^", "~"]);

const real = (path) => {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
};

// What a dependency installs: { name } for a package npm resolves by name, or { path } for a
// local path. pnpm pack rewrites workspace:<alias>@<range>, workspace:<range> and
// workspace:<path> to npm:<name>@<version> and keeps every other spec as written.
function installs(dep, spec, dir) {
  if (spec.startsWith("link:")) return { path: resolve(dir, spec.slice("link:".length)), verbatim: true };
  if (spec.startsWith("workspace:")) {
    const rest = spec.slice("workspace:".length);
    const alias = WORKSPACE_ALIAS.exec(rest);
    if (alias) return { name: alias[1] };
    if (WORKSPACE_SHORTHANDS.has(rest) || semver.validRange(rest)) return { name: dep };
    const local = npa.resolve(dep, rest, dir);
    if (!LOCAL_TYPES.has(local.type)) throw new Error(`workspace:${rest} is neither a range nor a path`);
    return { path: local.fetchSpec, verbatim: false };
  }
  const parsed = npa.resolve(dep, spec, dir);
  if (parsed.type === "alias") return { name: parsed.subSpec.name };
  if (LOCAL_TYPES.has(parsed.type)) return { path: parsed.fetchSpec, verbatim: true };
  return { name: dep };
}

// projects: workspace package.json objects, each with `dir`, its directory.
export function privateRuntimeDeps(projects) {
  const privateNames = new Set(projects.filter((p) => p.private).map((p) => p.name));
  let byRealDir;
  const projectAt = (path) => {
    byRealDir ??= new Map(projects.map((p) => [real(p.dir), p]).filter(([dir]) => dir !== null));
    const at = real(path);
    return at === null ? undefined : byRealDir.get(at);
  };
  const problems = [];
  for (const p of projects) {
    if (p.private) continue;
    for (const field of RUNTIME_FIELDS) {
      for (const [dep, spec] of Object.entries(p[field] ?? {})) {
        if (field === "peerDependencies" && p.peerDependenciesMeta?.[dep]?.optional) continue;
        const id = `${p.name}@${p.version} -> ${dep} (${field}) is ${spec}`;
        let target;
        try {
          target = installs(dep, spec, p.dir);
        } catch (error) {
          problems.push(`${id}, which npm cannot classify: ${error.message}`);
          continue;
        }
        if (target.path !== undefined) {
          const reached = projectAt(target.path);
          if (target.verbatim) {
            problems.push(`${id}, a local path npm cannot install${reached?.private ? `; it reaches private ${reached.name}` : ""}`);
            continue;
          }
          if (!reached) {
            problems.push(`${id}, which reaches no workspace package`);
            continue;
          }
          target = { name: reached.name };
        }
        const { name } = target;
        if (privateNames.has(name)) problems.push(`${p.name}@${p.version} -> ${name}${name === dep ? "" : ` as ${dep}`} (${field}) is private`);
      }
    }
  }
  return problems;
}

// Published prereleases are left out: neither ^ ranges nor the latest tag resolve to them.
export function inversions(projects, published) {
  const problems = [];
  for (const p of projects) {
    if (p.private) continue;
    const id = `${p.name}@${p.version}`;
    const recorded = semver.clean(p.version);
    if (recorded === null) {
      problems.push(`${id} is not valid semver`);
      continue;
    }
    if (recorded !== p.version) {
      problems.push(`${id} is not canonical semver; npm would publish it as ${recorded}`);
      continue;
    }
    const versions = published[p.name] ?? [];
    if (versions.includes(p.version)) continue;
    const [highest] = semver.rsort(versions.filter((v) => semver.valid(v) === v && !semver.prerelease(v)));
    if (highest && semver.lt(p.version, highest)) {
      problems.push(`${id} is below published ${highest}; npm would tag it latest while ^${highest} ranges keep resolving ${highest}`);
    }
  }
  return problems;
}

async function publishedVersions(names, registry) {
  const out = {};
  for (const name of names) {
    const res = await fetch(`${registry.replace(/\/$/, "")}/${name.replace("/", "%2f")}`);
    if (res.status === 404) {
      await res.body?.cancel();
      out[name] = [];
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`${name}: registry answered HTTP ${res.status}`);
    }
    out[name] = Object.keys((await res.json()).versions ?? {});
  }
  return out;
}

async function main(registry) {
  const listed = JSON.parse(execFileSync("pnpm", ["-r", "ls", "--json", "--depth", "-1"], { encoding: "utf8" }));
  const projects = listed.map(({ path }) => ({ ...JSON.parse(readFileSync(join(path, "package.json"), "utf8")), dir: path }));
  const publicNames = projects.filter((p) => !p.private).map((p) => p.name);
  const problems = [...privateRuntimeDeps(projects), ...inversions(projects, await publishedVersions(publicNames, registry))];
  if (problems.length) {
    for (const p of problems) console.error(`release-guard: ${p}`);
    return 1;
  }
  console.log(
    `release-guard: ${projects.length} workspace packages, ${publicNames.length} public; no private runtime dependency, no version inversion`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2] ?? "https://registry.npmjs.org").then(
    (code) => process.exit(code),
    (error) => {
      console.error(`release-guard: ${error.message}`);
      process.exit(1);
    },
  );
}
