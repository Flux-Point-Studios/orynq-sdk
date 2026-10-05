import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorKey, readAuthorSecret, saltKeyId } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { walletAddresses } from "../src/keys.js";

const cli = fileURLToPath(new URL("../scripts/keys.ts", import.meta.url));
const run = (...args: string[]) =>
  new Promise<{ status: number; stdout: string; stderr: string }>((resolve) =>
    execFile(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8" }, (error, stdout, stderr) =>
      resolve({ status: error ? Number(error.code) : 0, stdout, stderr }),
    ),
  );

describe("the keys CLI an operator runs to create wallets and author keys", () => {
  const root = mkdtempSync(join(tmpdir(), "orynq-midnight-keys-cli-"));
  const dir = join(root, "secrets");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("creates a private directory, a wallet, an author key and a salt key, printing only public derivations", async () => {
    expect((await run("private-dir", dir)).status).toBe(0);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    const mnemonicFile = join(dir, "wallet.mnemonic");
    const wallet = await run("new-wallet", mnemonicFile, "preprod");
    expect(wallet.stderr).toBe("");
    expect(wallet.status).toBe(0);
    expect(JSON.parse(wallet.stdout)).toEqual(walletAddresses(mnemonicFile, "preprod"));

    const keyFile = join(dir, "author.key");
    const author = await run("new-author", keyFile);
    expect(author.status).toBe(0);
    expect(author.stdout.trim()).toBe(Buffer.from(authorKey(readAuthorSecret(keyFile))).toString("hex"));

    const saltFile = join(dir, "salt.key");
    const salt = await run("new-salt", saltFile);
    expect(salt.status).toBe(0);
    expect(statSync(saltFile).mode & 0o777).toBe(0o600);
    expect(salt.stdout.trim()).toBe(Buffer.from(saltKeyId(readAuthorSecret(saltFile))).toString("hex"));

    const words = readFileSync(mnemonicFile, "utf8").trim().split(" ");
    const secrets = [readFileSync(keyFile, "utf8").trim(), readFileSync(saltFile, "utf8").trim()];
    for (const out of [wallet.stdout, wallet.stderr, author.stdout, author.stderr, salt.stdout, salt.stderr]) {
      for (const secret of secrets) expect(out).not.toContain(secret.slice(0, 16));
      for (const word of words) expect(out.split(/[^a-z]+/)).not.toContain(word);
    }
  });

  it("answers whether a mnemonic derives a recorded public wallet, as a boolean", async () => {
    const mnemonicFile = join(dir, "wallet.mnemonic");
    const record = join(root, "wallet.json");
    writeFileSync(record, JSON.stringify({ network: "preprod", addresses: walletAddresses(mnemonicFile, "preprod") }));
    expect((await run("addresses", mnemonicFile, "preprod", "--equals", record)).stdout.trim()).toBe("true");
    const other = join(root, "other.json");
    writeFileSync(other, JSON.stringify({ network: "preprod", addresses: { ...walletAddresses(mnemonicFile, "preprod"), dust: "mn_dust_preprod1x" } }));
    const mismatch = await run("addresses", mnemonicFile, "preprod", "--equals", other);
    expect(mismatch.stdout.trim()).toBe("false");
    expect(mismatch.status).toBe(1);
  });

  it("refuses to replace an existing wallet or key and says so without the content", async () => {
    const again = await run("new-wallet", join(dir, "wallet.mnemonic"), "preprod");
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(/wallet\.mnemonic already exists/);
    expect(again.stdout).toBe("");
  });
});
