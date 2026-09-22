import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));

describe("orynq-openclaw --version", () => {
  it("reports the version of the package that is installed", () => {
    const out = execFileSync(process.execPath, [join(pkgRoot, "dist", "main.cjs"), "--version"], {
      encoding: "utf-8"
    });
    expect(out.trim()).toBe(version);
  });
});
