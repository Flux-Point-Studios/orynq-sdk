import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLayouts, packedSpecs, singletonCopies } from "./post-publish-check.mjs";

const scratchDirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "post-publish-test-"));
  scratchDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

// Packs `files` (package.json included) the way npm does: everything under package/.
function tarball(files: Record<string, string>): Buffer {
  const dir = scratch();
  mkdirSync(join(dir, "package"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "package", name), body);
  execFileSync("tar", ["-czf", join(dir, "out.tgz"), "-C", dir, "package"]);
  return readFileSync(join(dir, "out.tgz"));
}

const manifest = (name: string, version: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, version, type: "module", ...extra });

describe("packedSpecs", () => {
  it("reads name@version from every tarball the pack step left, ignoring other files", () => {
    const dir = scratch();
    writeFileSync(join(dir, "b.tgz"), tarball({ "package.json": manifest("@f/b", "0.2.0") }));
    writeFileSync(join(dir, "a.tgz"), tarball({ "package.json": manifest("@f/a", "1.0.0") }));
    writeFileSync(join(dir, "notes.txt"), "not a tarball");
    expect(packedSpecs(dir)).toEqual(["@f/a@1.0.0", "@f/b@0.2.0"]);
  });
});

describe("singletonCopies", () => {
  function install(tree: Record<string, string>): string {
    const dir = scratch();
    for (const [path, version] of Object.entries(tree)) {
      mkdirSync(join(dir, path), { recursive: true });
      writeFileSync(join(dir, path, "package.json"), JSON.stringify({ name: path.split("node_modules/").pop(), version }));
    }
    return dir;
  }

  it("counts every physical copy, nested ones included", () => {
    const dir = install({
      "node_modules/@midnight-ntwrk/onchain-runtime-v3": "3.1.2",
      "node_modules/@midnight-ntwrk/compact-runtime": "0.16.0",
      "node_modules/@midnight-ntwrk/compact-runtime/node_modules/@midnight-ntwrk/onchain-runtime-v3": "3.0.0",
    });
    expect(singletonCopies(dir, ["@midnight-ntwrk/onchain-runtime-v3", "@midnight-ntwrk/compact-runtime"])).toEqual({
      "@midnight-ntwrk/onchain-runtime-v3": ["3.0.0", "3.1.2"],
      "@midnight-ntwrk/compact-runtime": ["0.16.0"],
    });
  });

  it("counts a symlinked package once, at its real path", () => {
    const dir = install({ "store/@midnight-ntwrk/ledger-v8": "8.1.3" });
    mkdirSync(join(dir, "node_modules/@midnight-ntwrk"), { recursive: true });
    symlinkSync(join(dir, "store/@midnight-ntwrk/ledger-v8"), join(dir, "node_modules/@midnight-ntwrk/ledger-v8"));
    mkdirSync(join(dir, "node_modules/x/node_modules/@midnight-ntwrk"), { recursive: true });
    symlinkSync(join(dir, "store/@midnight-ntwrk/ledger-v8"), join(dir, "node_modules/x/node_modules/@midnight-ntwrk/ledger-v8"));
    expect(singletonCopies(dir, ["@midnight-ntwrk/ledger-v8"])).toEqual({ "@midnight-ntwrk/ledger-v8": ["8.1.3"] });
  });
});

// A registry with real packuments and tarballs, so npm installs exactly as from npmjs.
describe("checkLayouts against a registry", () => {
  const packages: Record<string, Record<string, Buffer>> = {};
  let hidden = new Map<string, number>();
  let server: Server;
  let url = "";

  const publish = (name: string, version: string, files: Record<string, string>) => {
    (packages[name] ??= {})[version] = tarball(files);
  };

  beforeAll(async () => {
    publish("@midnight-ntwrk/ledger-v8", "8.1.3", { "package.json": manifest("@midnight-ntwrk/ledger-v8", "8.1.3", { exports: "./i.js" }), "i.js": "" });
    publish("@midnight-ntwrk/ledger-v8", "8.1.0", { "package.json": manifest("@midnight-ntwrk/ledger-v8", "8.1.0", { exports: "./i.js" }), "i.js": "" });
    publish("@f/good", "1.0.0", {
      "package.json": manifest("@f/good", "1.0.0", { exports: "./i.js", dependencies: { "@midnight-ntwrk/ledger-v8": "^8.1.0" } }),
      "i.js": 'import "@midnight-ntwrk/ledger-v8";',
    });
    publish("@f/pinned-old", "1.0.0", {
      "package.json": manifest("@f/pinned-old", "1.0.0", { exports: "./i.js", dependencies: { "@midnight-ntwrk/ledger-v8": "8.1.0" } }),
      "i.js": "",
    });
    publish("@f/broken", "1.0.0", { "package.json": manifest("@f/broken", "1.0.0", { exports: "./i.js" }), "i.js": 'throw new Error("boom");' });
    publish("@f/cli-only", "1.0.0", { "package.json": manifest("@f/cli-only", "1.0.0", { bin: { x: "./x.js" } }), "x.js": "" });
    publish("@f/serve-on-import", "1.0.0", {
      "package.json": manifest("@f/serve-on-import", "1.0.0", { exports: "./i.js" }),
      "i.js": "setInterval(() => {}, 1000);",
    });

    server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? "/").slice(1));
      const tgz = /^(.+)\/-\/[^/]+-(\d+\.\d+\.\d+)\.tgz$/.exec(path);
      if (tgz) return res.end(packages[tgz[1]!]![tgz[2]!]);
      const versioned = /^(@[^/]+\/[^/]+|[^@/][^/]*)\/(\d+\.\d+\.\d+)$/.exec(path);
      const name = versioned ? versioned[1]! : path;
      const remaining = hidden.get(name) ?? 0;
      if (remaining > 0) {
        hidden.set(name, remaining - 1);
        return res.writeHead(404).end();
      }
      const versions = packages[name];
      if (!versions || (versioned && !versions[versioned[2]!])) return res.writeHead(404).end();
      const meta = (v: string) => ({
        ...JSON.parse(execFileSync("tar", ["-xzOf", "-", "package/package.json"], { input: versions[v] }).toString()),
        dist: {
          tarball: `${url}/${name}/-/${name.split("/").pop()}-${v}.tgz`,
          integrity: `sha512-${createHash("sha512").update(versions[v]!).digest("base64")}`,
        },
      });
      res.writeHead(200, { "content-type": "application/json" });
      if (versioned) return res.end(JSON.stringify(meta(versioned[2]!)));
      const all = Object.keys(versions);
      res.end(JSON.stringify({ name, "dist-tags": { latest: all.sort().at(-1) }, versions: Object.fromEntries(all.map((v) => [v, meta(v)])) }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const options = () => ({ registry: url, singletons: ["@midnight-ntwrk/ledger-v8"], visibility: { attempts: 3, delayMs: 10 } });

  it("passes a package that installs, imports and resolves one copy of each singleton", async () => {
    expect(await checkLayouts(["@f/good@1.0.0"], options())).toEqual({
      problems: [],
      layouts: [{ specs: ["@f/good@1.0.0"], copies: { "@midnight-ntwrk/ledger-v8": ["8.1.3"] } }],
    });
  });

  it("flags two copies of a singleton when published packages are installed together", async () => {
    const { problems } = await checkLayouts(["@f/good@1.0.0", "@f/pinned-old@1.0.0"], options());
    expect(problems).toEqual(["@f/good@1.0.0 + @f/pinned-old@1.0.0: @midnight-ntwrk/ledger-v8 has 2 copies (8.1.0, 8.1.3)"]);
  });

  it("flags a package whose import throws", async () => {
    const { problems } = await checkLayouts(["@f/broken@1.0.0"], options());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^@f\/broken@1.0.0: import failed: .*boom/);
  });

  it("checks a bin-only package by its bin files, and an import that keeps the event loop alive still returns", async () => {
    const { problems, layouts } = await checkLayouts(["@f/cli-only@1.0.0", "@f/serve-on-import@1.0.0"], options());
    expect(problems).toEqual([]);
    expect(layouts.map((l) => l.specs)).toEqual([
      ["@f/cli-only@1.0.0"],
      ["@f/serve-on-import@1.0.0"],
      ["@f/cli-only@1.0.0", "@f/serve-on-import@1.0.0"],
    ]);
  });

  it("removes every probe project it installed", async () => {
    // Any directory under tmpdir() holding the probe manifest; other users' entries may be unreadable.
    const probes = () =>
      readdirSync(tmpdir()).filter((d) => {
        try {
          return readFileSync(join(tmpdir(), d, "package.json"), "utf8").includes('"name":"post-publish-probe"');
        } catch (e) {
          if (["ENOENT", "ENOTDIR", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "")) return false;
          throw e;
        }
      });
    const before = probes();
    const { layouts } = await checkLayouts(["@f/good@1.0.0", "@f/cli-only@1.0.0"], options());
    expect(layouts).toHaveLength(3);
    expect(probes()).toEqual(before);
  });

  it("waits for a version the registry does not serve yet, and gives up after the last attempt", async () => {
    hidden = new Map([["@f/good", 2]]);
    expect((await checkLayouts(["@f/good@1.0.0"], options())).problems).toEqual([]);
    expect(hidden.get("@f/good")).toBe(0);
    hidden = new Map([["@f/good", 5]]);
    expect(await checkLayouts(["@f/good@1.0.0"], options())).toEqual({
      problems: ["@f/good@1.0.0: not served by the registry after 3 attempts"],
      layouts: [],
    });
  });
});
