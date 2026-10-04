import { describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// A release laid out like GitHub's, with a compactc whose --version answers like the real one.
function fakeRelease(version = "0.31.1") {
  const dir = mkdtempSync(join(tmpdir(), "compactc-release-"));
  const files: Record<string, string> = {
    compactc: '#!/usr/bin/env bash\nthisdir="$(cd $(dirname $0) ; pwd -P)"\nexec "$thisdir/compactc.bin" "$@"\n',
    "compactc.bin": `#!/usr/bin/env bash\necho ${version}\n`,
    zkir: "#!/usr/bin/env bash\necho zkir\n",
    "zkir-v3": "#!/usr/bin/env bash\n",
    "format-compact": "#!/usr/bin/env bash\n",
    "fixup-compact": "#!/usr/bin/env bash\n",
  };
  const zip = join(dir, zipName);
  const zipper = "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n  for name, body in zip(sys.argv[2::2], sys.argv[3::2]):\n    i = zipfile.ZipInfo(name); i.external_attr = 0o100555 << 16; z.writestr(i, body)\n";
  execFileSync("python3", ["-c", zipper, zip, ...Object.entries(files).flat()]);
  const params = { bls_midnight_2p13: "params for k=13", bls_midnight_2p14: "params for k=14" };
  for (const [name, body] of Object.entries(params)) writeFileSync(join(dir, name), body);
  const pins = [
    `${sha256(readFileSync(zip))}  ${zipName}`,
    `${sha256(files["compactc.bin"]!)}  ${platform}/compactc.bin`,
    `${sha256(files.zkir!)}  ${platform}/zkir`,
    ...Object.entries(params).map(([name, body]) => `${sha256(body)}  ${name}`),
  ];
  return { dir, url: pathToFileURL(dir).href, zip, files, params, pins };
}

// The installer reads its pins from beside itself, so a copy with its own pins file is a
// complete installer for the fake release.
function installerWith(pins: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "compactc-installer-"));
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
    expect(pinned).toContain("d3324910969c4cc54143b8045b649e5c3a4bd5fb7b8f85fe1b770f640ce1c803  bls_midnight_2p13");
    expect(pinned).toContain("fc253016885ec830e97808c9ec920bb5cab5c21af590380a6cb5eb0538e2b244  bls_midnight_2p14");
    for (const p of ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "x86_64-darwin", "aarch64-darwin"]) {
      for (const f of [`compactc_v0.31.1_${p}.zip`, `${p}/compactc.bin`, `${p}/zkir`]) expect(pinned).toMatch(new RegExp(`^[0-9a-f]{64}  ${f}$`, "m"));
    }
  });

  it("installs a release and parameters whose every file matches its pin", async () => {
    const release = fakeRelease();
    const dest = join(mkdtempSync(join(tmpdir(), "compactc-dest-")), "bin");
    const params = mkdtempSync(join(tmpdir(), "zk-params-"));
    const r = await run(installerWith(release.pins), [dest, params], { COMPACTC_RELEASE_URL: release.url, MIDNIGHT_PARAM_SOURCE: release.url });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(execFileSync(join(dest, "compactc"), ["--version"], { encoding: "utf8" }).trim()).toBe("0.31.1");
    expect(readFileSync(join(params, "bls_midnight_2p14"), "utf8")).toBe(release.params.bls_midnight_2p14);
    expect(r.stdout).toContain(`compactc 0.31.1 (${platform}) verified in ${dest}`);
  });

  it("refuses a release zip that does not match its pin and installs nothing", async () => {
    const release = fakeRelease();
    const pins = release.pins.map((l) => (l.endsWith(zipName) ? `${"0".repeat(64)}  ${zipName}` : l));
    const dest = join(mkdtempSync(join(tmpdir(), "compactc-dest-")), "bin");
    const r = await run(installerWith(pins), [dest, mkdtempSync(join(tmpdir(), "zk-params-"))], {
      COMPACTC_RELEASE_URL: release.url,
      MIDNIGHT_PARAM_SOURCE: release.url,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`sha256 mismatch for ${zipName}`);
    expect(existsSync(join(dest, "compactc.bin"))).toBe(false);
  });

  it("refuses a compactc that does not report the pinned version", async () => {
    const release = fakeRelease("0.31.0");
    const dest = join(mkdtempSync(join(tmpdir(), "compactc-dest-")), "bin");
    const r = await run(installerWith(release.pins), [dest, mkdtempSync(join(tmpdir(), "zk-params-"))], {
      COMPACTC_RELEASE_URL: release.url,
      MIDNIGHT_PARAM_SOURCE: release.url,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("compactc reports 0.31.0, expected 0.31.1");
  });

  it("refuses a parameters file that does not match its pin and leaves it out of the cache", async () => {
    const release = fakeRelease();
    writeFileSync(join(release.dir, "bls_midnight_2p14"), "tampered");
    const params = mkdtempSync(join(tmpdir(), "zk-params-"));
    const r = await run(installerWith(release.pins), [join(mkdtempSync(join(tmpdir(), "compactc-dest-")), "bin"), params], {
      COMPACTC_RELEASE_URL: release.url,
      MIDNIGHT_PARAM_SOURCE: release.url,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("sha256 mismatch for bls_midnight_2p14");
    expect(existsSync(join(params, "bls_midnight_2p14"))).toBe(false);
  });

  it("re-verifies an existing install and replaces a binary that no longer matches its pin", async () => {
    const release = fakeRelease();
    const dest = join(mkdtempSync(join(tmpdir(), "compactc-dest-")), "bin");
    mkdirSync(dest);
    writeFileSync(join(dest, "compactc.bin"), "#!/usr/bin/env bash\necho tampered\n");
    const r = await run(installerWith(release.pins), [dest, mkdtempSync(join(tmpdir(), "zk-params-"))], {
      COMPACTC_RELEASE_URL: release.url,
      MIDNIGHT_PARAM_SOURCE: release.url,
    });
    expect(r.status).toBe(0);
    expect(readFileSync(join(dest, "compactc.bin"), "utf8")).toBe(release.files["compactc.bin"]);
  });
});
