import { afterAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const installer = fileURLToPath(new URL("./install.sh", import.meta.url));
const pinned = readFileSync(new URL("./compactc.sha256", import.meta.url), "utf8");
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const platform = (() => {
  const arch = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim().replace("arm64", "aarch64");
  return execFileSync("uname", ["-s"], { encoding: "utf8" }).trim() === "Darwin" ? `${arch}-darwin` : `${arch}-unknown-linux-musl`;
})();
const zipName = `compactc_v0.31.1_${platform}.zip`;

// The installer refuses anything below a shared sticky directory such as /tmp, so every test
// directory lives under a private root in the caller's home, the way ~/.cache/midnight does.
// Installed binaries are read-only, so cleanup restores write permission before removing.
mkdirSync(join(homedir(), ".cache"), { recursive: true, mode: 0o700 });
const testRoot = mkdtempSync(join(homedir(), ".cache", "compactc-install-test-"));
const temps: string[] = [testRoot];
const temp = (prefix: string) => mkdtempSync(join(testRoot, prefix));
afterAll(() => {
  for (const dir of temps) {
    execFileSync("chmod", ["-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A release laid out like GitHub's, with a compactc whose --version answers like the real one.
function fakeRelease(version = "0.31.1") {
  const dir = temp("compactc-release-");
  const files: Record<string, string> = {
    compactc: '#!/usr/bin/env bash\nthisdir="$(cd $(dirname $0) ; pwd -P)"\nPATH="$thisdir:$PATH"\nexec "$thisdir/compactc.bin" "$@"\n',
    "compactc.bin": `#!/usr/bin/env bash\necho ${version}\n`,
    zkir: "#!/usr/bin/env bash\necho zkir\n",
    "zkir-v3": "#!/usr/bin/env bash\n",
    "format-compact": "#!/usr/bin/env bash\n",
    "fixup-compact": "#!/usr/bin/env bash\n",
  };
  const zip = join(dir, zipName);
  const zipper = "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n  for name, body in zip(sys.argv[2::2], sys.argv[3::2]):\n    i = zipfile.ZipInfo(name); i.external_attr = 0o100555 << 16; z.writestr(i, body)\n";
  execFileSync("python3", ["-c", zipper, zip, ...Object.entries(files).flat()]);
  const params: Record<string, string> = {
    bls_midnight_2p13: "params for k=13",
    bls_midnight_2p14: "params for k=14",
    "dust/9/spend.prover": "dust spend prover key",
    "dust/9/spend.verifier": "dust spend verifier key",
    "dust/9/spend.bzkir": "dust spend zkir",
  };
  mkdirSync(join(dir, "dust", "9"), { recursive: true });
  for (const [name, body] of Object.entries(params)) writeFileSync(join(dir, name), body);
  const pins = [
    `${sha256(readFileSync(zip))}  ${zipName}`,
    ...Object.entries(files).map(([name, body]) => `${sha256(body)}  ${platform}/${name}`),
    ...Object.entries(params).map(([name, body]) => `${sha256(body)}  ${name}`),
  ];
  return { dir, url: pathToFileURL(dir).href, zip, files, params, pins };
}

// The installer reads its pins from beside itself, so a copy with its own pins file is a
// complete installer for the fake release.
function installerWith(pins: string[]) {
  const dir = temp("compactc-installer-");
  copyFileSync(installer, join(dir, "install.sh"));
  writeFileSync(join(dir, "compactc.sha256"), pins.join("\n") + "\n");
  return join(dir, "install.sh");
}

const run = (script: string, args: string[], env: Record<string, string>) =>
  new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile("bash", [script, ...args], { env: { ...process.env, ...env }, encoding: "utf8" }, (error, stdout, stderr) =>
      resolve({ status: error ? Number(error.code) : 0, stdout, stderr }),
    );
  });

describe("compactc installer", () => {
  it("pins compactc 0.31.1 for every published platform and the k=13/14 parameters", () => {
    expect(pinned).toContain("e291b4bab4d4e857707008f8b1c25c2b8e0c843f6c737d0ee6c0d9ac69a6bbfb  compactc_v0.31.1_x86_64-unknown-linux-musl.zip");
    expect(pinned).toContain("3054ffa89d7a4dfe24afd31c27ef37e87a95757de0fc24485f335635e26dce57  x86_64-unknown-linux-musl/compactc.bin");
    expect(pinned).toContain("15646793d3ff7f36cd81aa63419163e29d9893538bb4a6911a21012e8735b537  x86_64-unknown-linux-musl/compactc");
    expect(pinned).toContain("d3324910969c4cc54143b8045b649e5c3a4bd5fb7b8f85fe1b770f640ce1c803  bls_midnight_2p13");
    expect(pinned).toContain("fc253016885ec830e97808c9ec920bb5cab5c21af590380a6cb5eb0538e2b244  bls_midnight_2p14");
    // The DUST spend circuit (k=13) whose proof pays every registry transaction's fee, as
    // midnight-ledger 8.1.3 pins it in ledger/static/dust/*.sha256.
    expect(pinned).toContain("996602da7ca386284e656c78ea03e55bffdba29475e6a67965c50de05e13efc2  dust/9/spend.prover");
    expect(pinned).toContain("3f1569ebcab0655c5c145b28947c74edc4e3f5c6b276e4404b661cf0905b49d3  dust/9/spend.verifier");
    expect(pinned).toContain("904181287e75b0fb596ba5fcc116c882ee5d28e3115304c93ebd913722ce5841  dust/9/spend.bzkir");
    for (const p of ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "x86_64-darwin", "aarch64-darwin"]) {
      const files = ["compactc", "compactc.bin", "zkir", "zkir-v3", "fixup-compact", "format-compact"].map((f) => `${p}/${f}`);
      for (const f of [`compactc_v0.31.1_${p}.zip`, ...files]) expect(pinned).toMatch(new RegExp(`^[0-9a-f]{64}  ${f}$`, "m"));
    }
  });

  it("installs a release and parameters whose every file matches its pin", async () => {
    const release = fakeRelease();
    const dest = join(temp("compactc-dest-"), "bin");
    const params = temp("zk-params-");
    const r = await run(installerWith(release.pins), [dest, params], { COMPACTC_RELEASE_URL: release.url, MIDNIGHT_PARAM_SOURCE: release.url });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(execFileSync(join(dest, "compactc"), ["--version"], { encoding: "utf8" }).trim()).toBe("0.31.1");
    for (const name of Object.keys(release.params)) expect(readFileSync(join(params, name), "utf8"), name).toBe(release.params[name]);
    expect(statSync(join(params, "dust", "9")).mode & 0o022).toBe(0);
    expect(r.stdout).toContain(`compactc 0.31.1 (${platform}) verified in ${dest}`);
  });

  it("refuses a release zip that does not match its pin and installs nothing", async () => {
    const release = fakeRelease();
    const pins = release.pins.map((l) => (l.endsWith(zipName) ? `${"0".repeat(64)}  ${zipName}` : l));
    const dest = join(temp("compactc-dest-"), "bin");
    const r = await run(installerWith(pins), [dest, temp("zk-params-")], {
      COMPACTC_RELEASE_URL: release.url,
      MIDNIGHT_PARAM_SOURCE: release.url,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`sha256 mismatch for ${zipName}`);
    expect(existsSync(join(dest, "compactc.bin"))).toBe(false);
  });

  it("refuses a compactc that does not report the pinned version", async () => {
    const release = fakeRelease("0.31.0");
    const dest = join(temp("compactc-dest-"), "bin");
    const r = await run(installerWith(release.pins), [dest, temp("zk-params-")], {
      COMPACTC_RELEASE_URL: release.url,
      MIDNIGHT_PARAM_SOURCE: release.url,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("compactc reports 0.31.0, expected 0.31.1");
  });

  it("refuses a parameters file that does not match its pin and leaves it out of the cache", async () => {
    const release = fakeRelease();
    writeFileSync(join(release.dir, "bls_midnight_2p14"), "tampered");
    const params = temp("zk-params-");
    const r = await run(installerWith(release.pins), [join(temp("compactc-dest-"), "bin"), params], {
      COMPACTC_RELEASE_URL: release.url,
      MIDNIGHT_PARAM_SOURCE: release.url,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("sha256 mismatch for bls_midnight_2p14");
    expect(existsSync(join(params, "bls_midnight_2p14"))).toBe(false);
  });

  it("refuses a DUST spend key that does not match its pin and leaves it out of the cache", async () => {
    const release = fakeRelease();
    writeFileSync(join(release.dir, "dust/9/spend.prover"), "tampered");
    const params = temp("zk-params-");
    const r = await run(installerWith(release.pins), [join(temp("compactc-dest-"), "bin"), params], {
      COMPACTC_RELEASE_URL: release.url,
      MIDNIGHT_PARAM_SOURCE: release.url,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("sha256 mismatch for dust/9/spend.prover");
    expect(existsSync(join(params, "dust/9/spend.prover"))).toBe(false);
  });

  it("re-verifies an existing install and replaces a binary that no longer matches its pin", async () => {
    const release = fakeRelease();
    const dest = join(temp("compactc-dest-"), "bin");
    mkdirSync(dest, { mode: 0o755 });
    writeFileSync(join(dest, "compactc.bin"), "#!/usr/bin/env bash\necho tampered\n");
    const r = await run(installerWith(release.pins), [dest, temp("zk-params-")], {
      COMPACTC_RELEASE_URL: release.url,
      MIDNIGHT_PARAM_SOURCE: release.url,
    });
    expect(r.status).toBe(0);
    expect(readFileSync(join(dest, "compactc.bin"), "utf8")).toBe(release.files["compactc.bin"]);
  });

  // A release installed by the installer itself, ready to be tampered with.
  async function installed() {
    const release = fakeRelease();
    const script = installerWith(release.pins);
    const dest = join(temp("compactc-dest-"), "bin");
    const params = temp("zk-params-");
    const env = { COMPACTC_RELEASE_URL: release.url, MIDNIGHT_PARAM_SOURCE: release.url };
    const first = await run(script, [dest, params], env);
    expect(first.status).toBe(0);
    return { release, script, dest, params, env };
  }

  it("positive control: re-verifies an intact install without fetching anything", async () => {
    const { script, dest, params } = await installed();
    const gone = pathToFileURL(join(temp("compactc-gone-"), "missing")).href;
    const r = await run(script, [dest, params], { COMPACTC_RELEASE_URL: gone, MIDNIGHT_PARAM_SOURCE: gone });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it.each(["compactc", "zkir-v3", "fixup-compact", "format-compact"])(
    "replaces an installed %s that no longer matches its pin, and never runs it",
    async (name) => {
      const { release, script, dest, params, env } = await installed();
      const marker = join(temp("compactc-marker-"), "ran");
      const tampered = `#!/usr/bin/env bash\necho "$@" >> ${marker}\necho 0.31.1\n`;
      chmodSync(join(dest, name), 0o755);
      writeFileSync(join(dest, name), tampered);
      const r = await run(script, [dest, params], env);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(join(dest, name), "utf8")).toBe(release.files[name]);
    },
  );

  it("replaces an installed file that is a symlink, even to a file that matches its pin", async () => {
    const { release, script, dest, params, env } = await installed();
    const elsewhere = join(temp("compactc-elsewhere-"), "zkir");
    writeFileSync(elsewhere, release.files.zkir!);
    chmodSync(join(dest, "zkir"), 0o755);
    rmSync(join(dest, "zkir"));
    symlinkSync(elsewhere, join(dest, "zkir"));
    const r = await run(script, [dest, params], env);
    expect(r.status).toBe(0);
    expect(lstatSync(join(dest, "zkir")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dest, "zkir"), "utf8")).toBe(release.files.zkir);
  });

  it.each(["compactc", "params"])("refuses a %s directory that group or others can write", async (which) => {
    const { script, dest, params, env } = await installed();
    const dir = which === "compactc" ? dest : params;
    chmodSync(dir, 0o777);
    const r = await run(script, [dest, params], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${dir} is writable by group or others`);
  });

  it.each(["compactc", "params"])("refuses a %s directory reached through a symlink", async (which) => {
    const { script, dest, params, env } = await installed();
    const link = join(temp("compactc-link-"), which);
    symlinkSync(which === "compactc" ? dest : params, link);
    const args = which === "compactc" ? [link, params] : [dest, link];
    const r = await run(script, args, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${link} is a symlink; pass the directory it points to`);
  });

  // What a fresh install below `parent` does, for either directory; nothing may be created.
  async function installBelow(which: string, parent: string) {
    const release = fakeRelease();
    const fresh = join(parent, `fresh-${which}`, which);
    const dest = which === "compactc" ? fresh : join(temp("compactc-dest-"), "bin");
    const params = which === "params" ? fresh : temp("zk-params-");
    const r = await run(installerWith(release.pins), [dest, params], { COMPACTC_RELEASE_URL: release.url, MIDNIGHT_PARAM_SOURCE: release.url });
    return { ...r, dir: fresh, created: existsSync(join(parent, `fresh-${which}`)) };
  }

  it.each(["compactc", "params"])("refuses a %s directory below an ancestor that group or others can write", async (which) => {
    const parent = temp("compactc-shared-parent-");
    chmodSync(parent, 0o777);
    const r = await installBelow(which, parent);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${parent}, above ${r.dir}, is writable by group or others`);
    expect(r.created).toBe(false);
  });

  it.each(["compactc", "params"])("refuses a %s directory below /tmp outright, even in a directory only the caller can write", async (which) => {
    const mine = mkdtempSync("/tmp/compactc-sticky-");
    temps.push(mine);
    const r = await installBelow(which, mine);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`/tmp, above ${r.dir}, is a shared sticky directory`);
    expect(r.created).toBe(false);
  });

  it.each(["compactc", "params"])("refuses a %s directory with a symlink anywhere above it", async (which) => {
    const link = join(temp("compactc-ancestor-link-"), "link");
    symlinkSync(temp("compactc-ancestor-target-"), link);
    const r = await installBelow(which, link);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${link}, above ${r.dir}, is a symlink`);
  });

  // Root hands a directory to another account; anyone else finds one the system already gave
  // to a service account, such as apt's partial directory.
  it.each(["compactc", "params"])("refuses a %s directory below an ancestor owned by another account", async (which) => {
    let parent: string;
    if (process.getuid?.() === 0) {
      parent = temp("compactc-foreign-parent-");
      chmodSync(parent, 0o755);
      chownSync(parent, 65534, 65534);
    } else {
      const uid = String(process.getuid?.());
      const found = spawnSync("find", ["/var", "/run", "/srv", "/opt", "-maxdepth", "4", "-type", "d", "!", "-uid", "0", "!", "-uid", uid, "-print", "-quit"], {
        encoding: "utf8",
      });
      parent = found.stdout.trim();
      expect(parent, "a directory owned by another non-root account").not.toBe("");
    }
    const r = await installBelow(which, parent);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${parent}, above ${r.dir}, is owned by another account`);
  });

  // Only root can hand a directory to another user; anyone else is handed one by the system.
  it("refuses an install directory owned by another user", async () => {
    const release = fakeRelease();
    let dest = "/usr/share";
    if (process.getuid?.() === 0) {
      dest = temp("compactc-foreign-");
      chmodSync(dest, 0o755);
      chownSync(dest, 65534, 65534);
    }
    const r = await run(installerWith(release.pins), [dest, temp("zk-params-")], {
      COMPACTC_RELEASE_URL: release.url,
      MIDNIGHT_PARAM_SOURCE: release.url,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${dest} is not owned by`);
  });
});
