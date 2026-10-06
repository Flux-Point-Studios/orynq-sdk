import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthorKeyFile, createSaltKeyFile } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { registryOperator, type OperatorOptions } from "../src/operator.js";
import { createWalletMnemonicFile } from "../src/keys.js";
import { openWallet } from "../src/wallet.js";
import { chain, deployed, fresh, wallet } from "./fakes.js";
import { prover } from "./prover.js";

// The real FPS mainnet keys never leave their 0600 files, so the identities an operator off
// mainnet refuses are replaced, for this suite, by stand-ins made here.
const mainnet = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAuthorKeyFile, createSaltKeyFile } = await import("@fluxpointstudios/orynq-sdk-anchors-midnight");
  const dir = mkdtempSync(join(tmpdir(), "orynq-mainnet-stand-in-"));
  const authorKeyFile = join(dir, "author-relay.key");
  const saltKeyFile = join(dir, "salt.key");
  return { dir, authorKeyFile, saltKeyFile, authorKey: createAuthorKeyFile(authorKeyFile), saltKeyId: createSaltKeyFile(saltKeyFile) };
});
vi.mock("../src/custody.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/custody.js")>()),
  MAINNET_AUTHOR_KEYS: [mainnet.authorKey],
  MAINNET_SALT_KEY_IDS: [mainnet.saltKeyId],
}));

const root = mkdtempSync(join(tmpdir(), "orynq-custody-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(mainnet.dir, { recursive: true, force: true });
});

const copyOf = (file: string, name: string) => {
  const copy = join(root, name);
  copyFileSync(file, copy);
  chmodSync(copy, 0o600);
  return copy;
};
const operator = (overrides: Partial<OperatorOptions>) => {
  const net = chain();
  const journalPath = fresh("journal.sqlite");
  const w = wallet(net, () => journalPath);
  const op = registryOperator({ network: "preprod", wallet: w, source: net.source, prover, journalPath, authorKeyFile: "", registry: deployed.address, pollMillis: 1, ...overrides });
  return { op, wallet: w };
};
const entry = () => ({ rootHash: "11".repeat(32), manifestHash: "22".repeat(32), merkleRoot: "33".repeat(32) });

// Runs `fn` in a process without Claude Code's environment, as deci at his own terminal is.
const withoutClaudeCode = <T>(fn: () => T): T => {
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) if (name === "CLAUDECODE" || name.startsWith("CLAUDE_CODE_")) delete process.env[name];
  try {
    return fn();
  } finally {
    Object.assign(process.env, saved);
  }
};

describe("off mainnet, the FPS mainnet keys are refused by what they are, wherever the file lives", () => {
  it("an operator refuses a copy of the mainnet author key, and loads any other key from the same place", () => {
    const copy = copyOf(mainnet.authorKeyFile, "relay-copy.key");
    expect(() => operator({ authorKeyFile: copy })).toThrow(`${copy} holds the FPS mainnet author key ${mainnet.authorKey}; a preprod operator never loads it`);
    const other = join(root, "relay-other.key");
    createAuthorKeyFile(other);
    expect(() => operator({ authorKeyFile: other }).op.close()).not.toThrow();
  });

  it("an operator refuses a copy of the mainnet salt key before preparing anything", async () => {
    const author = join(root, "author-for-salt.key");
    createAuthorKeyFile(author);
    const copy = copyOf(mainnet.saltKeyFile, "salt-copy.key");
    const { op, wallet: w } = operator({ authorKeyFile: author, saltKeyFile: copy });
    await expect(op.anchorHiding(entry(), "44".repeat(32))).rejects.toThrow(`${copy} holds the FPS mainnet salt key ${mainnet.saltKeyId}; a preprod operator never uses it`);
    expect(w.submitted).toHaveLength(0);
    op.close();
  });

  it("a mainnet operator, in a process without Claude Code's environment, loads the mainnet author key", () => {
    expect(withoutClaudeCode(() => operator({ network: "mainnet", authorKeyFile: mainnet.authorKeyFile }).op.authorKey)).toBe(mainnet.authorKey);
  });
});

describe("off mainnet, nothing is opened from the mainnet secrets directory, however the path reaches it", () => {
  const home = join(root, "home");
  const secrets = join(home, ".secrets", "orynq-midnight-mainnet");
  let savedHome: string | undefined;
  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = savedHome;
  });
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const author = join(secrets, "author-relay.key");
  createAuthorKeyFile(author);
  createSaltKeyFile(join(secrets, "salt.key"));
  createWalletMnemonicFile(join(secrets, "mnemonic.txt"));
  symlinkSync(secrets, join(root, "alias"));
  const elsewhere = join(root, "elsewhere.key");
  createAuthorKeyFile(elsewhere);

  it("an operator refuses an author key or salt key file there, by its path, its symlinked directory or a .. path", () => {
    for (const path of [author, join(root, "alias", "author-relay.key"), join(secrets, "..", "orynq-midnight-mainnet", "author-relay.key")]) {
      expect(() => operator({ authorKeyFile: path })).toThrow(`${path} lies in the FPS mainnet secrets directory; a preprod process never opens it`);
    }
    const salt = join(root, "alias", "salt.key");
    expect(() => operator({ authorKeyFile: elsewhere, saltKeyFile: salt })).toThrow(`${salt} lies in the FPS mainnet secrets directory; a preprod process never opens it`);
  });

  it("openWallet refuses a mnemonic file there before reading it", async () => {
    const mnemonicFile = join(root, "alias", "mnemonic.txt");
    await expect(openWallet({ network: "preprod", mnemonicFile, endpoints: undefined as never, source: undefined as never, zkDir: "/nonexistent" })).rejects.toThrow(
      `${mnemonicFile} lies in the FPS mainnet secrets directory; a preprod process never opens it`,
    );
  });

  it("a mainnet operator, in a process without Claude Code's environment, loads its key from there", () => {
    expect(() => withoutClaudeCode(() => operator({ network: "mainnet", authorKeyFile: author }).op.close())).not.toThrow();
  });
});
