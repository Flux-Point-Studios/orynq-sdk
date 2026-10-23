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
  const retiredKeyFile = join(dir, "retired.key");
  return { dir, authorKeyFile, saltKeyFile, retiredKeyFile, retiredKey: createAuthorKeyFile(retiredKeyFile), authorKey: createAuthorKeyFile(authorKeyFile), saltKeyId: createSaltKeyFile(saltKeyFile) };
});
vi.mock("../src/custody.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/custody.js")>()),
  MAINNET_AUTHOR_KEYS: [mainnet.authorKey],
  RETIRED_AUTHOR_KEYS: [mainnet.retiredKey],
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
  return registryOperator({ network: "preprod", wallet: wallet(net, () => journalPath), source: net.source, prover, journalPath, authorKeyFile: "", registry: deployed.address, pollMillis: 1, ...overrides });
};

// Runs `fn` with `env` added to the process's environment, then restores it as it was.
const withEnv = <T>(env: Record<string, string>, fn: () => T): T => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
  }
};
// Runs `fn` in a process without Claude Code or Codex environment, as deci at his own terminal is.
const withoutAgents = <T>(fn: () => T): T =>
  withEnv({}, () => {
    for (const name of Object.keys(process.env)) if (name === "CLAUDECODE" || name.startsWith("CLAUDE_CODE_") || name.startsWith("CODEX_")) delete process.env[name];
    return fn();
  });

it("refuses retired author identities for both writer roles before opening a journal", () => {
  for (const authorRole of ["relay", "batch"] as const) {
    expect(() => operator({ authorKeyFile: mainnet.retiredKeyFile, authorRole })).toThrow(/retired author key/);
  }
});

describe("off mainnet, the FPS mainnet keys are refused by what they are, wherever the file lives", () => {
  it("an operator refuses a copy of the mainnet author key, and loads any other key from the same place", () => {
    const copy = copyOf(mainnet.authorKeyFile, "relay-copy.key");
    expect(() => operator({ authorKeyFile: copy })).toThrow(`${copy} holds the FPS mainnet author key ${mainnet.authorKey}; a preprod operator never loads it`);
    const other = join(root, "relay-other.key");
    createAuthorKeyFile(other);
    expect(() => operator({ authorKeyFile: other }).close()).not.toThrow();
  });

  it("an operator refuses a copy of the mainnet salt key as it loads it, before preparing anything", () => {
    const author = join(root, "author-for-salt.key");
    createAuthorKeyFile(author);
    const copy = copyOf(mainnet.saltKeyFile, "salt-copy.key");
    expect(() => operator({ authorKeyFile: author, saltKeyFile: copy })).toThrow(`${copy} holds the FPS mainnet salt key ${mainnet.saltKeyId}; a preprod operator never uses it`);
  });
});

describe("on mainnet, an operator writes only under the FPS mainnet keys, by what they are", () => {
  it("loads the mainnet author and salt keys in a process without Claude Code or Codex environment", () => {
    const op = withoutAgents(() => operator({ network: "mainnet", authorKeyFile: mainnet.authorKeyFile, saltKeyFile: mainnet.saltKeyFile }));
    expect(op.authorKey).toBe(mainnet.authorKey);
    op.close();
  });

  it("refuses to load them in a process that carries Claude Code or Codex environment, which off mainnet loads any other key", () => {
    const other = join(root, "preprod-in-agent.key");
    createAuthorKeyFile(other);
    for (const env of [{ CODEX_THREAD_ID: "" }, { CODEX_SESSION_ID: "1" }, { CODEX_CI: "1" }, { CODEX_MANAGED_BY_NPM: "1" }, { CODEX_MANAGED_BY_OTHER: "" }, { CLAUDECODE: "1" }, { CLAUDE_CODE_ENTRYPOINT: "cli" }]) {
      expect(() => withoutAgents(() => withEnv(env, () => operator({ network: "mainnet", authorKeyFile: mainnet.authorKeyFile, saltKeyFile: mainnet.saltKeyFile })))).toThrow(
        "registryOperator refuses to load a mainnet author key in a process that carries Claude Code or Codex environment",
      );
      expect(() => withoutAgents(() => withEnv(env, () => operator({ authorKeyFile: other }).close()))).not.toThrow();
    }
  });

  it("refuses any other author key as it loads it, before preparing anything", () => {
    const other = join(root, "not-the-relay.key");
    const key = createAuthorKeyFile(other);
    expect(() => withoutAgents(() => operator({ network: "mainnet", authorKeyFile: other, saltKeyFile: mainnet.saltKeyFile }))).toThrow(
      `${other} holds author key ${key}, not an FPS mainnet author key (${mainnet.authorKey}); a mainnet operator writes under no other`,
    );
  });

  it("refuses any other salt key as it loads it, before preparing anything", () => {
    const other = join(root, "not-the-salt.key");
    const id = createSaltKeyFile(other);
    expect(() => withoutAgents(() => operator({ network: "mainnet", authorKeyFile: mainnet.authorKeyFile, saltKeyFile: other }))).toThrow(
      `${other} holds salt key ${id}, not an FPS mainnet salt key (${mainnet.saltKeyId}); a mainnet operator derives no kind-2 salt from any other`,
    );
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
  copyFileSync(mainnet.authorKeyFile, author);
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

  it("a mainnet operator, in a process without Claude Code or Codex environment, loads its key from there", () => {
    expect(() => withoutAgents(() => operator({ network: "mainnet", authorKeyFile: author }).close())).not.toThrow();
  });
});
