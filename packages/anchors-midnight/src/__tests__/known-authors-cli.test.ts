import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { knownAuthors } from "../known-authors.js";

const cli = fileURLToPath(new URL("../../scripts/known-authors.ts", import.meta.url));
const run = (...args: string[]) =>
  new Promise<{ status: number; stdout: string; stderr: string }>((resolve) =>
    execFile(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8" }, (error, stdout, stderr) =>
      resolve({ status: error ? Number(error.code) : 0, stdout, stderr }),
    ),
  );

describe("the known-authors CLI an offline trust-root holder runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "orynq-known-authors-cli-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a root key only its owner can read, signs a document with it, and never prints the seed", async () => {
    const seedFile = join(dir, "root.seed");
    const created = await run("new-root-key", seedFile);
    expect(created.stderr).toBe("");
    expect(created.status).toBe(0);
    const root = created.stdout.trim();
    expect(root).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(seedFile).mode & 0o777).toBe(0o600);
    const seed = readFileSync(seedFile, "utf8").trim();

    const documentFile = join(dir, "document.json");
    const document = { format: "orynq-known-authors/v1", serial: 1, issued: "2026-10-04T00:00:00Z", networks: { preprod: { authors: [], checkpoints: [] } } };
    writeFileSync(documentFile, `${JSON.stringify(document, null, 2)}\n`);
    const signed = await run("sign", documentFile, seedFile);
    expect(signed.status).toBe(0);
    for (const out of [created.stdout, created.stderr, signed.stdout, signed.stderr]) expect(out).not.toContain(seed);

    const envelopes = JSON.parse(signed.stdout);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].document).toBe(readFileSync(documentFile, "utf8"));
    expect(knownAuthors({ documents: envelopes, trustRoots: [root] }).serial).toBe(1);
  });

  it("never replaces an existing key file, and refuses to sign with a key others can read", async () => {
    const seedFile = join(dir, "kept.seed");
    writeFileSync(seedFile, "keep\n", { mode: 0o600 });
    expect((await run("new-root-key", seedFile)).status).not.toBe(0);
    expect(readFileSync(seedFile, "utf8")).toBe("keep\n");
    const open = join(dir, "open.seed");
    writeFileSync(open, `${"ab".repeat(32)}\n`, { mode: 0o644 });
    const r = await run("sign", join(dir, "document.json"), open);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/open\.seed can be read or written by group or others/);
  });
});
