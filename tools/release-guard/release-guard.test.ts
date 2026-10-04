import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inversions, privateRuntimeDeps } from "./release-guard.mjs";

const guard = fileURLToPath(new URL("./release-guard.mjs", import.meta.url));
const pkg = (name: string, version: string, extra: Record<string, unknown> = {}) => ({ name, version, ...extra });

describe("privateRuntimeDeps", () => {
  it("flags a public package whose dependencies name a private workspace package", () => {
    const projects = [
      pkg("@f/anchors-midnight", "0.1.0", { private: true }),
      pkg("@f/quickstart", "0.3.0", { dependencies: { "@f/anchors-midnight": "workspace:*" } }),
    ];
    expect(privateRuntimeDeps(projects)).toEqual(["@f/quickstart@0.3.0 -> @f/anchors-midnight (dependencies) is private"]);
  });

  it("flags non-optional peers and optionalDependencies, but not devDependencies or optional peers", () => {
    const projects = [
      pkg("@f/p", "1.0.0", { private: true }),
      pkg("@f/a", "1.0.0", { peerDependencies: { "@f/p": "*" } }),
      pkg("@f/b", "1.0.0", { optionalDependencies: { "@f/p": "*" } }),
      pkg("@f/c", "1.0.0", { devDependencies: { "@f/p": "*" } }),
      pkg("@f/d", "1.0.0", { peerDependencies: { "@f/p": "*" }, peerDependenciesMeta: { "@f/p": { optional: true } } }),
    ];
    expect(privateRuntimeDeps(projects)).toEqual([
      "@f/a@1.0.0 -> @f/p (peerDependencies) is private",
      "@f/b@1.0.0 -> @f/p (optionalDependencies) is private",
    ]);
  });

  it("lets a private package depend on anything", () => {
    const projects = [
      pkg("@f/p", "1.0.0", { private: true }),
      pkg("@f/q", "1.0.0", { private: true, dependencies: { "@f/p": "*" } }),
      pkg("@f/r", "1.0.0", { dependencies: { "@f/p": "*" } }),
    ];
    expect(privateRuntimeDeps(projects)).toEqual(["@f/r@1.0.0 -> @f/p (dependencies) is private"]);
  });
});

describe("inversions", () => {
  it("flags an unpublished version below an already-published one, and nothing else", () => {
    const published = { "@f/core": ["0.1.0", "0.2.0"], "@f/mcp": ["0.3.1"], "@f/same": ["1.0.0"] };
    const projects = [pkg("@f/core", "0.1.1"), pkg("@f/mcp", "0.4.0"), pkg("@f/new", "0.1.0"), pkg("@f/same", "1.0.0")];
    expect(inversions(projects, published)).toEqual([
      "@f/core@0.1.1 is below published 0.2.0; npm would tag it latest while ^0.2.0 ranges keep resolving 0.2.0",
    ]);
  });

  it("compares numerically, names the highest published version, and ignores prereleases", () => {
    const published = { "@f/a": ["0.9.0", "0.10.0", "0.11.0-rc.1"], "@f/b": ["2.0.0-beta.1"] };
    expect(inversions([pkg("@f/a", "0.9.1"), pkg("@f/b", "1.0.0")], published)).toEqual([
      "@f/a@0.9.1 is below published 0.10.0; npm would tag it latest while ^0.10.0 ranges keep resolving 0.10.0",
    ]);
  });

  it("skips private packages, which are never published", () => {
    const published = { "@f/p": ["1.0.0"], "@f/x": ["0.2.0"] };
    expect(inversions([pkg("@f/p", "0.0.1", { private: true }), pkg("@f/x", "0.1.0")], published)).toEqual([
      "@f/x@0.1.0 is below published 0.2.0; npm would tag it latest while ^0.2.0 ranges keep resolving 0.2.0",
    ]);
  });
});

describe("release-guard CLI", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function workspace(members: Array<[string, Record<string, unknown>]>): string {
    const root = mkdtempSync(join(tmpdir(), "release-guard-"));
    roots.push(root);
    const { packageManager } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", private: true, packageManager }));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    for (const [dir, json] of members) {
      mkdirSync(join(root, "packages", dir), { recursive: true });
      writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify(json));
    }
    return root;
  }

  // A registry that serves a packument for each listed name, 404 for the rest,
  // and `status` for every request when given.
  async function registry(packuments: Record<string, string[]>, status?: number): Promise<{ url: string; close: () => void }> {
    const server = createServer((req, res) => {
      const name = decodeURIComponent((req.url ?? "/").slice(1));
      if (status) return res.writeHead(status).end();
      const versions = packuments[name];
      if (!versions) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name, versions: Object.fromEntries(versions.map((v) => [v, { version: v }])) }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
  }

  const run = (cwd: string, registryUrl: string) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile("node", [guard, registryUrl], { cwd, encoding: "utf8" }, (error, stdout, stderr) =>
        resolve({ status: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr }),
      );
    });

  it("exits 1 on a workspace that would publish a dangling dependency", async () => {
    const root = workspace([
      ["anchors-midnight", { name: "@f/anchors-midnight", version: "0.1.0", private: true }],
      ["quickstart", { name: "@f/quickstart", version: "0.3.0", dependencies: { "@f/anchors-midnight": "workspace:*" } }],
    ]);
    const reg = await registry({});
    try {
      const r = await run(root, reg.url);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("@f/quickstart@0.3.0 -> @f/anchors-midnight (dependencies) is private");
    } finally {
      reg.close();
    }
  });

  it("exits 1 on a version the registry already exceeds", async () => {
    const root = workspace([["core", { name: "@f/core", version: "0.1.1" }]]);
    const reg = await registry({ "@f/core": ["0.1.0", "0.2.0"] });
    try {
      const r = await run(root, reg.url);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("@f/core@0.1.1 is below published 0.2.0");
    } finally {
      reg.close();
    }
  });

  it("fails closed when the registry cannot answer", async () => {
    const root = workspace([["core", { name: "@f/core", version: "0.3.0" }]]);
    const reg = await registry({}, 503);
    try {
      const r = await run(root, reg.url);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("@f/core: registry answered HTTP 503");
    } finally {
      reg.close();
    }
  });

  it("exits 0 and says what it checked on a clean workspace", async () => {
    const root = workspace([
      ["anchors-midnight", { name: "@f/anchors-midnight", version: "0.1.0", private: true }],
      ["quickstart", { name: "@f/quickstart", version: "0.3.0", devDependencies: { "@f/anchors-midnight": "workspace:*" } }],
      ["core", { name: "@f/core", version: "0.2.0" }],
    ]);
    const reg = await registry({ "@f/quickstart": ["0.2.1"], "@f/core": ["0.1.0", "0.2.0"] });
    try {
      const r = await run(root, reg.url);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("release-guard: 4 workspace packages, 2 public; no private runtime dependency, no version inversion");
    } finally {
      reg.close();
    }
  });
});
