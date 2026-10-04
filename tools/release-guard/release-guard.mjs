// Refuses a release that npm would accept but that breaks installs:
//  - a public package with a runtime dependency on a private workspace package
//    (pnpm pack rewrites workspace:* to a version that never reaches npm),
//  - a public package with a link: or file: runtime dependency (published verbatim),
//  - a version npm would record differently (semver.clean), and
//  - an unpublished version below one already published (npm tags it latest
//    while ^ ranges keep resolving the higher one).
// Versions are parsed and ordered by npm's own semver, prereleases included.
//   node tools/release-guard/release-guard.mjs [REGISTRY]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";

const RUNTIME_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

// The package a dependency installs: pnpm pack turns workspace:<name>@<range> and
// workspace:<path> into npm:<name>@<version>, and keeps npm:<name>@<range> as written.
const aliasName = (spec) => {
  const at = spec.indexOf("@", 1);
  return at === -1 ? spec : spec.slice(0, at);
};
function target(dep, spec, dir, nameAt) {
  if (spec.startsWith("npm:")) return aliasName(spec.slice(4));
  if (!spec.startsWith("workspace:")) return dep;
  const rest = spec.slice("workspace:".length);
  if (rest.startsWith(".") || rest.startsWith("/")) return nameAt.get(resolve(dir, rest)) ?? dep;
  return rest.includes("@", 1) ? aliasName(rest) : dep;
}

// projects: workspace package.json objects, each with `dir`, its directory.
export function privateRuntimeDeps(projects) {
  const privateNames = new Set(projects.filter((p) => p.private).map((p) => p.name));
  const nameAt = new Map(projects.map((p) => [resolve(p.dir), p.name]));
  const problems = [];
  for (const p of projects) {
    if (p.private) continue;
    for (const field of RUNTIME_FIELDS) {
      for (const [dep, spec] of Object.entries(p[field] ?? {})) {
        if (field === "peerDependencies" && p.peerDependenciesMeta?.[dep]?.optional) continue;
        if (spec.startsWith("link:") || spec.startsWith("file:")) {
          problems.push(`${p.name}@${p.version} -> ${dep} (${field}) is ${spec}, a local path npm cannot install`);
          continue;
        }
        const name = target(dep, spec, p.dir, nameAt);
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
