import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const native = resolve(import.meta.dirname, "../native");

it.each(["unchanged", "source", "dependencies", "new-module", "source-symlink", "build-script"])("requires security re-review for %s boundary", async mutation => {
  const directory = await mkdtemp(join(tmpdir(), "orynq-verify-only-boundary-"));
  const target = join(directory, "native");
  try {
    await mkdir(join(target, "src"), { recursive: true });
    for (const file of ["src/main.rs", "Cargo.toml", "Cargo.lock", "public-input-boundary.sha256", "check-verify-only-boundary.sh"]) await copyFile(join(native, file), join(target, file));
    await copyFile(join(native, "../artifact-pins.json"), join(directory, "artifact-pins.json"));
    if (mutation === "source") await writeFile(join(target, "src/main.rs"), "// changed input or operation\n", { flag: "a" });
    if (mutation === "dependencies") await writeFile(join(target, "Cargo.lock"), "\n# dependency review required\n", { flag: "a" });
    if (mutation === "new-module") await writeFile(join(target, "src/signing.rs"), "// new production module\n");
    if (mutation === "source-symlink") await symlink("main.rs", join(target, "src/alias.rs"));
    if (mutation === "build-script") await writeFile(join(target, "build.rs"), "fn main() {}\n");
    const result = spawnSync("bash", [join(target, "check-verify-only-boundary.sh")], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status === 0).toBe(mutation === "unchanged");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
