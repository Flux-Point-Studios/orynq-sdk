// Refuses a release that npm would accept but that breaks installs:
//  - a public package with a runtime dependency on a private workspace package
//    (pnpm pack rewrites workspace:* to a version that never reaches npm), and
//  - an unpublished version below one already published (npm tags it latest
//    while ^ ranges keep resolving the higher one).
//   node tools/release-guard/release-guard.mjs [REGISTRY]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const RUNTIME_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

export function privateRuntimeDeps(projects) {
  const privateNames = new Set(projects.filter((p) => p.private).map((p) => p.name));
  const problems = [];
  for (const p of projects) {
    if (p.private) continue;
    for (const field of RUNTIME_FIELDS) {
      for (const dep of Object.keys(p[field] ?? {})) {
        if (field === "peerDependencies" && p.peerDependenciesMeta?.[dep]?.optional) continue;
        if (privateNames.has(dep)) problems.push(`${p.name}@${p.version} -> ${dep} (${field}) is private`);
      }
    }
  }
  return problems;
}

const release = (v) => (v.includes("-") ? null : v.split(".").map(Number));
const compare = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

export function inversions(projects, published) {
  const problems = [];
  for (const p of projects) {
    if (p.private) continue;
    const versions = published[p.name] ?? [];
    if (versions.includes(p.version)) continue;
    const own = release(p.version.split("-")[0]);
    const highest = versions
      .map((v) => [v, release(v)])
      .filter(([, r]) => r && compare(r, own) > 0)
      .sort(([, a], [, b]) => compare(b, a))[0]?.[0];
    if (highest) {
      problems.push(`${p.name}@${p.version} is below published ${highest}; npm would tag it latest while ^${highest} ranges keep resolving ${highest}`);
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
  const projects = listed.map(({ path }) => JSON.parse(readFileSync(join(path, "package.json"), "utf8")));
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
