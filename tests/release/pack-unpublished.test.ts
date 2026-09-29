import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/pack-unpublished.mjs", import.meta.url));

// A registry that knows @orynq/published@1.0.0 and answers `broken` for every other version.
function registry(broken: number, seen: string[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.statusCode = req.url === "/@orynq%2fpublished/1.0.0" ? 200 : broken;
    res.end("{}");
  });
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      ok({ server, url: `http://127.0.0.1:${address.port}` });
    }),
  );
}

// Asynchronous: the fake registry answers from this process's event loop.
function run(cwd: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => ok({ status, stdout, stderr }));
  });
}

function tarball(file: string) {
  const list = spawnSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" });
  return JSON.parse(list.stdout);
}

describe("pack-unpublished", () => {
  let ws: string;
  let out: string;
  let server: Server | undefined;
  const seen: string[] = [];

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "pack-unpublished-"));
    out = join(ws, "out");
    seen.length = 0;
    const write = (dir: string, manifest: object) => {
      mkdirSync(join(ws, dir), { recursive: true });
      writeFileSync(join(ws, dir, "package.json"), JSON.stringify(manifest));
    };
    write(".", { name: "ws", private: true, packageManager: "pnpm@8.14.0" });
    writeFileSync(join(ws, "pnpm-workspace.yaml"), "packages:\n  - p/*\n");
    write("p/published", { name: "@orynq/published", version: "1.0.0" });
    write("p/fresh", { name: "@orynq/fresh", version: "0.1.0", dependencies: { "@orynq/published": "workspace:*" } });
    write("p/hidden", { name: "@orynq/hidden", version: "0.1.0", private: true });
    const install = spawnSync("pnpm", ["install", "--offline"], { cwd: ws, encoding: "utf8" });
    expect(install.status, install.stderr).toBe(0);
  });

  afterEach(() => {
    server?.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("packs every public package whose version the registry lacks, as pnpm publishes it", async () => {
    const reg = await registry(404, seen);
    server = reg.server;
    const result = await run(ws, out, reg.url);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(out)).toEqual(["orynq-fresh-0.1.0.tgz"]);
    expect(tarball(join(out, "orynq-fresh-0.1.0.tgz")).dependencies).toEqual({ "@orynq/published": "1.0.0" });
    expect(seen.sort()).toEqual(["/@orynq%2ffresh/0.1.0", "/@orynq%2fpublished/1.0.0"]);
    expect(result.stdout).toContain("packed @orynq/fresh@0.1.0");
  });

  it("packs nothing when the registry answers neither 200 nor 404", async () => {
    const reg = await registry(500, seen);
    server = reg.server;
    const result = await run(ws, out, reg.url);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("HTTP 500");
    expect(readdirSync(out)).toEqual([]);
  });

  it("names its arguments when given none", async () => {
    const result = await run(ws);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("usage");
  });
});
