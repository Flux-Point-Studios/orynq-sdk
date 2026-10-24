import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const projects = JSON.parse(execFileSync("pnpm", ["-r", "list", "--depth", "-1", "--json"], { cwd: root, encoding: "utf8" })) as Array<{ path: string }>;
const packages = projects.filter(({ path }) => relative(root, path) !== "").map(({ path }) => ({
  path: relative(root, path),
  manifest: JSON.parse(readFileSync(join(path, "package.json"), "utf8")),
}));

// A peer of a public package counts too: changesets major-bumps a package whose peer dependency
// gets any release unless onlyUpdatePeerDependentsWhenOutOfRange holds it to out-of-range ones.
const peerOfPublic = (name: string) => packages.some(({ manifest }) => !manifest.private && manifest.peerDependencies?.[name] !== undefined);

describe("release plans of private packages and of public packages' peers", () => {
  it.each(packages.filter(({ manifest }) => manifest.private || peerOfPublic(manifest.name)).map(({ manifest }) => manifest.name as string))(
    "a minor release of %s does not major-bump public packages",
    (name) => {
      const scratch = mkdtempSync(join(tmpdir(), "orynq-release-plan-"));
      try {
        for (const file of ["package.json", "pnpm-workspace.yaml", ".changeset"]) cpSync(join(root, file), join(scratch, file), { recursive: true });
        symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
        for (const { path, manifest } of packages) {
          mkdirSync(dirname(join(scratch, path, "package.json")), { recursive: true });
          writeFileSync(join(scratch, path, "package.json"), JSON.stringify(manifest));
        }
        writeFileSync(join(scratch, ".changeset", "private-minor-probe.md"), `---\n"${name}": minor\n---\n\nPrivate package minor release probe.\n`);
        execFileSync("pnpm", ["changeset", "version"], { cwd: scratch, encoding: "utf8", stdio: "pipe" });
        const majors = packages.filter(({ manifest }) => !manifest.private).flatMap(({ path, manifest }) => {
          const next = JSON.parse(readFileSync(join(scratch, path, "package.json"), "utf8")).version;
          return Number(next.split(".")[0]) > Number(manifest.version.split(".")[0]) ? [`${manifest.name}: ${manifest.version} -> ${next}`] : [];
        });
        expect(majors).toEqual([]);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
