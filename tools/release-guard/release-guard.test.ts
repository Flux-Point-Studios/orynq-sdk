import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inversions, privateRuntimeDeps } from "./release-guard.mjs";

const guard = fileURLToPath(new URL("./release-guard.mjs", import.meta.url));
const pkg = (name: string, version: string, extra: Record<string, unknown> = {}) => ({ name, version, dir: `/w/${name}`, ...extra });
const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

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

  it("follows workspace: and npm: aliases, and workspace: paths, to the package they name", () => {
    const w = mkdtempSync(join(tmpdir(), "release-guard-aliases-"));
    tempRoots.push(w);
    for (const dir of ["anchors-midnight", "core", "a", "b", "c"]) mkdirSync(join(w, dir));
    const projects = [
      pkg("@f/anchors-midnight", "0.1.0", { private: true, dir: join(w, "anchors-midnight") }),
      pkg("@f/core", "0.2.0", { dir: join(w, "core") }),
      pkg("@f/a", "1.0.0", { dir: join(w, "a"), dependencies: { midnight: "workspace:@f/anchors-midnight@*", core: "workspace:@f/core@^" } }),
      pkg("@f/b", "1.0.0", { dir: join(w, "b"), optionalDependencies: { m: "npm:@f/anchors-midnight@0.1.0", c: "npm:@f/core@0.2.0" } }),
      pkg("@f/c", "1.0.0", { dir: join(w, "c"), peerDependencies: { m: "workspace:../anchors-midnight", c: "workspace:../core" } }),
    ];
    expect(privateRuntimeDeps(projects)).toEqual([
      "@f/a@1.0.0 -> @f/anchors-midnight as midnight (dependencies) is private",
      "@f/b@1.0.0 -> @f/anchors-midnight as m (optionalDependencies) is private",
      "@f/c@1.0.0 -> @f/anchors-midnight as m (peerDependencies) is private",
    ]);
  });

  it("refuses link: and file: dependencies, which npm publishes verbatim as local paths", () => {
    const projects = [
      pkg("@f/p", "1.0.0", { private: true, dir: "/w/packages/p" }),
      pkg("@f/a", "1.0.0", { dir: "/w/packages/a", dependencies: { x: "link:../p" }, devDependencies: { y: "file:../p" } }),
      pkg("@f/b", "1.0.0", { dir: "/w/packages/b", optionalDependencies: { z: "file:../p" } }),
    ];
    expect(privateRuntimeDeps(projects)).toEqual([
      "@f/a@1.0.0 -> x (dependencies) is link:../p, a local path npm cannot install",
      "@f/b@1.0.0 -> z (optionalDependencies) is file:../p, a local path npm cannot install",
    ]);
  });

  describe("on local paths, resolved through symlinks the way npm-package-arg classifies them", () => {
    const tree = (): string => {
      const root = mkdtempSync(join(tmpdir(), "release-guard-paths-"));
      tempRoots.push(root);
      for (const dir of ["priv", "core", "pub"]) mkdirSync(join(root, dir));
      symlinkSync("../priv", join(root, "pub", "privlink"));
      return root;
    };
    const members = (root: string, deps: Record<string, string>) => [
      pkg("@f/priv", "0.1.0", { private: true, dir: join(root, "priv") }),
      pkg("@f/core", "0.2.0", { dir: join(root, "core") }),
      pkg("@f/pub", "9.9.9", { dir: join(root, "pub"), dependencies: deps }),
    ];

    it("refuses a bare relative path, which npm publishes verbatim, and names the private package it reaches", () => {
      const root = tree();
      expect(privateRuntimeDeps(members(root, { midnight: "../priv", core: "../core" }))).toEqual([
        "@f/pub@9.9.9 -> midnight (dependencies) is ../priv, a local path npm cannot install; it reaches private @f/priv",
        "@f/pub@9.9.9 -> core (dependencies) is ../core, a local path npm cannot install",
      ]);
    });

    it("refuses bare ./, ~/ and absolute paths and file: paths, through a symlink too", () => {
      const root = tree();
      expect(privateRuntimeDeps(members(root, { a: "./privlink", b: `${join(root, "priv")}`, c: "file:./privlink" }))).toEqual([
        "@f/pub@9.9.9 -> a (dependencies) is ./privlink, a local path npm cannot install; it reaches private @f/priv",
        `@f/pub@9.9.9 -> b (dependencies) is ${join(root, "priv")}, a local path npm cannot install; it reaches private @f/priv`,
        "@f/pub@9.9.9 -> c (dependencies) is file:./privlink, a local path npm cannot install; it reaches private @f/priv",
      ]);
    });

    it("follows a workspace: path through a symlink to the private package pnpm pack would name", () => {
      const root = tree();
      expect(privateRuntimeDeps(members(root, { midnight: "workspace:./privlink", core: "workspace:../core" }))).toEqual([
        "@f/pub@9.9.9 -> @f/priv as midnight (dependencies) is private",
      ]);
    });

    it("refuses a workspace: path that reaches no workspace package, and a spec npm cannot classify", () => {
      const root = tree();
      expect(privateRuntimeDeps(members(root, { gone: "workspace:../missing", linked: "workspace:link:../priv", caret: "^" }))).toEqual([
        "@f/pub@9.9.9 -> gone (dependencies) is workspace:../missing, which reaches no workspace package",
        '@f/pub@9.9.9 -> linked (dependencies) is workspace:link:../priv, which npm cannot classify: Unsupported URL Type "link:": link:../priv',
        '@f/pub@9.9.9 -> caret (dependencies) is ^, which npm cannot classify: Invalid tag name "^" of package "caret@^": Tags may not have any characters that encodeURIComponent encodes.',
      ]);
    });

    it("positive control: pnpm's workspace:*, workspace:^ and workspace:~ name the dependency itself", () => {
      const root = tree();
      const projects = [
        pkg("@f/priv", "0.1.0", { private: true, dir: join(root, "priv") }),
        pkg("@f/core", "0.2.0", { dir: join(root, "core") }),
        pkg("@f/pub", "9.9.9", { dir: join(root, "pub"), dependencies: { "@f/core": "workspace:^", "@f/priv": "workspace:~" } }),
      ];
      expect(privateRuntimeDeps(projects)).toEqual(["@f/pub@9.9.9 -> @f/priv (dependencies) is private"]);
    });
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

  it("refuses a version npm would record differently: a v prefix, build metadata or invalid semver", () => {
    const projects = [pkg("@f/a", "v0.1.5"), pkg("@f/b", "0.1.5+hotfix"), pkg("@f/c", "0.1"), pkg("@f/d", "01.2.3"), pkg("@f/e", "0.1.5")];
    expect(inversions(projects, {})).toEqual([
      "@f/a@v0.1.5 is not canonical semver; npm would publish it as 0.1.5",
      "@f/b@0.1.5+hotfix is not canonical semver; npm would publish it as 0.1.5",
      "@f/c@0.1 is not valid semver",
      "@f/d@01.2.3 is not valid semver",
    ]);
  });

  it("orders prereleases as npm does: one below the highest published release is an inversion", () => {
    const published = { "@f/a": ["0.1.9"], "@f/b": ["0.1.9"], "@f/c": ["0.1.9"] };
    const projects = [pkg("@f/a", "0.1.9-rc.1"), pkg("@f/b", "0.2.0-rc.1"), pkg("@f/c", "0.1.5")];
    expect(inversions(projects, published)).toEqual([
      "@f/a@0.1.9-rc.1 is below published 0.1.9; npm would tag it latest while ^0.1.9 ranges keep resolving 0.1.9",
      "@f/c@0.1.5 is below published 0.1.9; npm would tag it latest while ^0.1.9 ranges keep resolving 0.1.9",
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

  it("exits 1 on a private package reached through an alias or a workspace path", async () => {
    const root = workspace([
      ["anchors-midnight", { name: "@f/anchors-midnight", version: "0.1.0", private: true }],
      ["alias", { name: "@f/alias", version: "9.9.9", dependencies: { midnight: "workspace:@f/anchors-midnight@*" } }],
      ["path", { name: "@f/path", version: "9.9.9", dependencies: { midnight: "workspace:../anchors-midnight" } }],
    ]);
    const reg = await registry({});
    try {
      const r = await run(root, reg.url);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("@f/alias@9.9.9 -> @f/anchors-midnight as midnight (dependencies) is private");
      expect(r.stderr).toContain("@f/path@9.9.9 -> @f/anchors-midnight as midnight (dependencies) is private");
    } finally {
      reg.close();
    }
  });

  it("exits 1 on a private package reached by a bare relative path or a workspace: path through a symlink", async () => {
    const root = workspace([
      ["anchors-midnight", { name: "@f/anchors-midnight", version: "0.1.0", private: true }],
      ["bare", { name: "@f/bare", version: "9.9.9", dependencies: { midnight: "../anchors-midnight" } }],
      ["linked", { name: "@f/linked", version: "9.9.9", dependencies: { midnight: "workspace:./privlink" } }],
    ]);
    symlinkSync("../anchors-midnight", join(root, "packages", "linked", "privlink"));
    const reg = await registry({});
    try {
      const r = await run(root, reg.url);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        "@f/bare@9.9.9 -> midnight (dependencies) is ../anchors-midnight, a local path npm cannot install; it reaches private @f/anchors-midnight",
      );
      expect(r.stderr).toContain("@f/linked@9.9.9 -> @f/anchors-midnight as midnight (dependencies) is private");
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
