// Packs every public workspace package whose version the npm registry does not have yet into
// DEST, the same choice `changeset publish` makes, so the npm-publish plugin can publish the
// tarballs without the token ever reaching a step that installs, builds or packs.
//   node scripts/pack-unpublished.mjs DEST [REGISTRY]
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const [dest, registry = "https://registry.npmjs.org"] = process.argv.slice(2);
if (!dest) {
  console.error("usage: node scripts/pack-unpublished.mjs DEST [REGISTRY]");
  process.exit(2);
}

const out = resolve(dest);
mkdirSync(out, { recursive: true });
const projects = JSON.parse(execFileSync("pnpm", ["-r", "ls", "--json", "--depth", "-1"], { encoding: "utf8" }));
const missing = [];
for (const { name, version, path, private: hidden } of projects) {
  if (hidden) continue;
  const url = `${registry.replace(/\/$/, "")}/${name.replace("/", "%2f")}/${version}`;
  const response = await fetch(url);
  await response.body?.cancel();
  if (response.status === 404) missing.push({ name, version, path });
  else if (response.status !== 200) throw new Error(`${url}: HTTP ${response.status}`);
}

for (const { name, version, path } of missing) {
  execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: path, stdio: ["ignore", "ignore", "inherit"] });
  console.log(`packed ${name}@${version}`);
}
