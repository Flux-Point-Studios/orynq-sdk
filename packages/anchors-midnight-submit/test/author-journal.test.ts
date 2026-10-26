import { afterAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { authorJournal, defaultAuthorBindingRoot } from "../src/author-journal.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-author-binding-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const author = "ab".repeat(32);

describe("account author journal binding", () => {
  it("ignores HOME and binds the same author across wallet/key file locations to one journal", () => {
    const old = process.env.HOME;
    process.env.HOME = join(dir, "hostile-home");
    try { expect(defaultAuthorBindingRoot()).toBe(join(userInfo().homedir, ".orynq-midnight-journals")); }
    finally { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; }
    const root = join(dir, "bindings"); const journal = join(dir, "original.sqlite");
    authorJournal("preprod", author, journal, root).close();
    authorJournal("preprod", author, journal, root).close();
    const copied = join(dir, "copied.sqlite"); copyFileSync(journal, copied);
    expect(() => authorJournal("preprod", author, copied, root)).toThrow("already bound to another journal");
    authorJournal("preprod", "cd".repeat(32), copied, root).close();
    const record = JSON.parse(readFileSync(join(root, `preprod-${author}.json`), "utf8"));
    expect(record.path).toBe(journal);
  });
  it("atomically chooses one journal when separate processes first bind the same author", async () => {
    const root = join(dir, "concurrent-bindings");
    const files = [join(dir, "first.sqlite"), join(dir, "second.sqlite")];
    const code = `const { authorJournal } = await import(process.argv[1]); try { authorJournal("preprod", process.argv[2], process.argv[3], process.argv[4]).close(); } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }`;
    const children = files.map(file => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code, new URL("../src/author-journal.ts", import.meta.url).href, author, file, root], { stdio: "ignore" }));
    const statuses = await Promise.all(children.map(async child => (await once(child, "close"))[0]));
    expect(statuses.sort()).toEqual([0, 1]);
    const record = JSON.parse(readFileSync(join(root, `preprod-${author}.json`), "utf8"));
    expect(files).toContain(record.path);
    authorJournal("preprod", author, record.path, root).close();
    expect(() => authorJournal("preprod", author, files.find(file => file !== record.path)!, root)).toThrow("already bound to another journal");
  });
  it("fails closed on a deleted or replaced bound journal", () => {
    const root = join(dir, "deleted-bindings"); const journal = join(dir, "deleted.sqlite");
    authorJournal("preprod", author, journal, root).close();
    rmSync(journal);
    expect(() => authorJournal("preprod", author, journal, root)).toThrow("bound journal is missing");
    expect(() => readFileSync(journal)).toThrow();
    writeFileSync(journal, "replacement", { mode: 0o600 });
    expect(() => authorJournal("preprod", author, journal, root)).toThrow("replaced or is unsafe");
  });
  it("refuses journal and binding directory symlinks", () => {
    const target = join(dir, "symlink-target"); writeFileSync(target, "unmodified", { mode: 0o600 });
    const link = join(dir, "journal-link"); symlinkSync(target, link);
    expect(() => authorJournal("preprod", author, link, join(dir, "symlink-bindings"))).toThrow("unsafe author journal");
    expect(readFileSync(target, "utf8")).toBe("unmodified");
    const rootLink = join(dir, "root-link"); symlinkSync(join(dir, "bindings"), rootLink);
    expect(() => authorJournal("preprod", author, join(dir, "other.sqlite"), rootLink)).toThrow("binding directory");
  });
});
