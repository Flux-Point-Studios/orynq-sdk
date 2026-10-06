import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "orynq-private-file-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const privateFile = fileURLToPath(new URL("../private-file.ts", import.meta.url));

// Calls writePrivateFile in a process whose files may not grow past 32 KiB. Past that limit
// write(2) returns a short count instead of failing, as it does on a full disk or a spent quota.
const writeCapped = (file: string, bytes: number) =>
  new Promise<{ status: number; stderr: string }>((resolve) =>
    execFile(
      "/bin/sh",
      ["-c", 'ulimit -f 64 && exec "$@"', "sh", process.execPath, "--import", "tsx", "--input-type=module", "-e", `import { writePrivateFile } from ${JSON.stringify(privateFile)}; writePrivateFile(process.argv[1], "x".repeat(${bytes}));`, file],
      { encoding: "utf8", env: { ...process.env, TSX_DISABLE_CACHE: "1" } },
      (error, _stdout, stderr) => resolve({ status: error ? Number(error.code) : 0, stderr }),
    ),
  );

describe("writing a private file", () => {
  it("writes the whole text under the size limit", async () => {
    const file = join(dir, "small");
    expect(await writeCapped(file, 1000)).toEqual({ status: 0, stderr: "" });
    expect(readFileSync(file, "utf8")).toBe(`${"x".repeat(1000)}\n`);
  });

  it("fails a write the file system cuts short and leaves no file holding part of the text", async () => {
    const file = join(dir, "cut");
    const run = await writeCapped(file, 1 << 20);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/EFBIG: file too large/);
    expect(existsSync(file)).toBe(false);
  });
});
