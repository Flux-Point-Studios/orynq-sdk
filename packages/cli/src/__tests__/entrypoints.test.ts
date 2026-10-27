import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));
const commands = ["invoice", "pay", "status", "balance", "call", "test-x402"];
const bin = fileURLToPath(new URL(manifest.bin.poi, packageRoot));

function runNode(args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: fileURLToPath(packageRoot),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
}

describe.each(["import", "require"] as const)("built %s entry", (format) => {
  const entry = manifest.exports["."][format].default;
  const load = format === "import"
    ? `await import(${JSON.stringify(entry)})`
    : `require(${JSON.stringify(entry)})`;

  it("loads silently without parsing argv or exiting and exposes createProgram and VERSION", () => {
    const result = runNode(["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { Command } from "commander";
      const require = createRequire(import.meta.url);
      for (const constructor of [Command, require("commander").Command]) {
        for (const method of ["parse", "parseAsync"]) {
          constructor.prototype[method] = () => { throw new Error("import parsed argv"); };
        }
      }
      process.argv = [process.execPath, "consumer.js", "--consumer-only-option"];
      process.exit = () => { throw new Error("import called process.exit"); };
      const entry = ${load};
      assert.equal(typeof entry.createProgram, "function");
      assert.equal(typeof entry.VERSION, "string");
      const program = entry.createProgram();
      assert.notEqual(program, entry.createProgram());
      assert.equal(program.name(), "poi");
      assert.equal(program.version(), entry.VERSION);
      assert.deepEqual(program.commands.map(command => command.name()), ${JSON.stringify(commands)});
    `]);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });

  it("exports VERSION matching package.json", () => {
    const result = runNode(["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      process.exit = () => { throw new Error("import called process.exit"); };
      const { VERSION } = ${load};
      assert.equal(VERSION, ${JSON.stringify(manifest.version)});
    `]);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });

  it("has no executable shebang", () => {
    expect(readFileSync(new URL(entry, packageRoot), "utf8").startsWith("#!")).toBe(false);
  });
});

describe("poi bin", () => {
  it("preserves the executable shebang", () => {
    expect(readFileSync(bin, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  it("prints the package version and exits successfully", () => {
    const result = runNode([bin, "--version"]);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${manifest.version}\n`);
    expect(result.status).toBe(0);
  });

  it("lists all six commands in help and exits successfully", () => {
    const result = runNode([bin, "--help"]);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    for (const command of commands) {
      expect(result.stdout).toMatch(new RegExp(`^  ${command}[ \\[]`, "m"));
    }
  });

  it("preserves help and exit status when no command is given", () => {
    const result = runNode([bin]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: poi");
  });

  it("rejects unknown options", () => {
    const result = runNode([bin, "--unknown-option"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: unknown option '--unknown-option'");
  });
});
