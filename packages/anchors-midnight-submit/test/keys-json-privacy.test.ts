import { afterAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletMnemonicFile } from "../src/keys.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-keys-json-privacy-"));
const mnemonic = join(dir, "wallet.mnemonic");
createWalletMnemonicFile(mnemonic);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const cli = fileURLToPath(new URL("../scripts/keys.ts", import.meta.url));

it.each(["synthetic mnemonic words passed as the wrong file", "ab".repeat(32), "synthetic-project-id-0123456789"])("never quotes a mistaken secret --equals file", async (secret) => {
  const file = join(dir, "mistaken-secret");
  writeFileSync(file, secret, { mode: 0o600 });
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ["--import", "tsx", cli, "addresses", mnemonic, "preprod", "--equals", file], { encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`${file} is not JSON`);
  expect(result.stderr).not.toContain(secret.slice(0, 10));
});
