/**
 * A crash or ENOSPC mid-append leaves a torn last line in a spool file. It
 * must cost at most that one event, and it must not corrupt the next record.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendSpool, readSpool, type SpoolEvent } from "../src/spool";

const BUNDLE = "2026-02-03__main";
const ev = (ts: string): SpoolEvent => ({ ts, kind: "user", contentHash: `sha256:${ts}` });
const dirs: string[] = [];
const outDir = async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "spool-test-"));
  dirs.push(d);
  return d;
};
const spoolFile = (dir: string) => path.join(dir, "spool", `${BUNDLE}.jsonl`);

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("spool", () => {
  it("round-trips appended events", async () => {
    const dir = await outDir();
    await appendSpool(dir, BUNDLE, [ev("a"), ev("b")]);
    expect((await readSpool(dir, BUNDLE)).map((e) => e.ts)).toEqual(["a", "b"]);
  });

  it("skips a torn line instead of throwing", async () => {
    const dir = await outDir();
    await appendSpool(dir, BUNDLE, [ev("a")]);
    await fs.appendFile(spoolFile(dir), '{"ts":"2026-02-03T10:0');
    expect((await readSpool(dir, BUNDLE)).map((e) => e.ts)).toEqual(["a"]);
  });

  it("starts the next append on a fresh line after a torn fragment", async () => {
    const dir = await outDir();
    await appendSpool(dir, BUNDLE, [ev("a")]);
    await fs.appendFile(spoolFile(dir), '{"ts":"2026-02-03T10:0');
    await appendSpool(dir, BUNDLE, [ev("b")]);
    expect((await readSpool(dir, BUNDLE)).map((e) => e.ts)).toEqual(["a", "b"]);
  });

  it("adds no blank line when the file already ends cleanly", async () => {
    const dir = await outDir();
    await appendSpool(dir, BUNDLE, [ev("a")]);
    await appendSpool(dir, BUNDLE, [ev("b")]);
    expect(await fs.readFile(spoolFile(dir), "utf-8")).not.toContain("\n\n");
  });
});
