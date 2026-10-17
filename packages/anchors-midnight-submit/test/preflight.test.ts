import { describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import * as L from "@midnight-ntwrk/ledger-v8";
import {
  REGISTRY_VERIFIER_KEY_SHA256,
  buildRegistryDeploy,
  createAuthorKeyFile,
  createSaltKeyFile,
  deriveSalt,
  entryCommitment,
  hiddenDigest,
  hidingCommitment,
  readAuthorSecret,
  registryInitialState,
  type MidnightSource,
} from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { chainView, openJournal } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { MAINNET_AUTHOR_KEYS } from "../src/custody.js";
import { NETWORK_IDENTITY, anchorSummary, assertChainIdentity, confirmOnTerminal, confirmationToken, deploySummary } from "../src/preflight.js";
import { registryDeployer, type PreparedDeploy } from "../src/deployer.js";
import type { PreparedAnchor } from "../src/operator.js";
import { batchOver, ledgerNode } from "../../anchors-midnight/src/__tests__/ledger-node.js";
import { chain, fresh, hex, mutableDeploy, wallet } from "./fakes.js";
import type { OfflineChain } from "./offline.js";
import { prover } from "./prover.js";

const source = (answers: Record<string, unknown>) =>
  ({
    operator: "test",
    node: {
      async call(method: string, params: unknown[] = []) {
        const key = `${method}${JSON.stringify(params)}`;
        if (!(key in answers)) throw new Error(`unexpected ${key}`);
        return answers[key];
      },
    },
  }) as unknown as MidnightSource;
const mainnet = {
  "system_chain[]": "Midnight Mainnet",
  "chain_getBlockHash[0]": "0x1941ca8e2bb88146c14dea084d3be7eb6e96ca7135429c543848b628124f2854",
  "state_getRuntimeVersion[]": { specVersion: 1000300, transactionVersion: 3 },
  "midnight_ledgerVersion[]": "8.1.1",
};

describe("assertChainIdentity", () => {
  it("pins each network's chain name and genesis block", () => {
    expect(NETWORK_IDENTITY.mainnet).toEqual({ chain: "Midnight Mainnet", genesis: "1941ca8e2bb88146c14dea084d3be7eb6e96ca7135429c543848b628124f2854" });
    expect(NETWORK_IDENTITY.preprod).toEqual({ chain: "Midnight Preprod", genesis: "df831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b" });
  });

  it("accepts Midnight mainnet and reports what it read", async () => {
    expect(await assertChainIdentity(source(mainnet), "mainnet")).toEqual({ chain: "Midnight Mainnet", genesis: mainnet["chain_getBlockHash[0]"].slice(2), specVersion: 1000300, ledgerVersion: "8.1.1" });
  });

  it.each([
    ["a chain of another name", { "system_chain[]": "Midnight Preprod" }, /the node serves Midnight Preprod, not Midnight Mainnet/],
    ["another genesis", { "chain_getBlockHash[0]": `0x${"11".repeat(32)}` }, /genesis 1111.* is not Midnight Mainnet's 1941ca8e/],
    ["an unknown runtime", { "state_getRuntimeVersion[]": { specVersion: 1000400 } }, /runs runtime 1000400, which is not one this submitter knows/],
  ])("refuses %s", async (_, change, error) => {
    await expect(assertChainIdentity(source({ ...mainnet, ...change }), "mainnet")).rejects.toThrow(error);
  });
});

const prepared: PreparedDeploy = {
  network: "mainnet",
  address: "ab".repeat(32),
  txHash: "0123456789abcdef".repeat(4),
  bytes: new Uint8Array([1, 2, 3]),
  ttl: new Date("2026-10-04T12:00:00Z"),
  runtime: 1000300,
  authority: { committee: 0, threshold: 1, counter: "0" },
  verifierKeys: { ...REGISTRY_VERIFIER_KEY_SHA256 },
  declaredFee: 1_234_567_000_000n,
  payer: "mn_addr1payer",
};

describe("the deploy summary a human approves", () => {
  const summary = (deploy: PreparedDeploy) =>
    deploySummary({
      chain: { chain: "Midnight Mainnet", genesis: "1941ca8e".padEnd(64, "0"), specVersion: 1000300, ledgerVersion: "8.1.1" },
      wallet: { dust: "mn_dust1example" },
      dust: 25_500_000_000_000_000n,
      prepared: deploy,
    });

  it("names the network, the contract address, the verifier keys, the authority form, the fee and the DUST balance", () => {
    const text = summary(prepared);
    for (const expected of [
      "network          mainnet (Midnight Mainnet, genesis 1941ca8e",
      "runtime          1000300, ledger 8.1.1",
      `contract address ${"ab".repeat(32)}`,
      `deploy tx hash   ${prepared.txHash}`,
      `anchor           vk sha256 ${REGISTRY_VERIFIER_KEY_SHA256.anchor}`,
      `anchor_hiding    vk sha256 ${REGISTRY_VERIFIER_KEY_SHA256.anchor_hiding}`,
      "authority        committee [] (0 members), threshold 1, counter 0: no maintenance update can ever apply",
      "fee (declared)   0.001234567 DUST, all of it burned",
      "DUST balance     25.5 DUST at mn_dust1example",
      "paid from        mn_addr1payer",
      "valid until      2026-10-04T12:00:00.000Z",
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("shows a deploy resumed from the journal as the journal holds it, and what confirming then does", () => {
    expect(summary(prepared)).not.toContain("resumed");
    expect(summary({ ...prepared, journal: { state: "landed", broadcasts: 1, expired: false } })).toMatch(/^journal {10}resumed: these bytes landed; confirming sends nothing and reads the deploy back\n/);
    expect(summary({ ...prepared, journal: { state: "pending", broadcasts: 2, expired: false } })).toMatch(/^journal {10}resumed: these bytes were sent 2 times and have not landed; confirming waits for them and sends nothing new\n/);
    expect(summary({ ...prepared, journal: { state: "pending", broadcasts: 1, expired: false } })).toContain("these bytes were sent 1 time and have not landed");
    expect(summary({ ...prepared, journal: { state: "pending", broadcasts: 0, expired: false } })).toMatch(/^journal {10}resumed: no send of these bytes ever returned; confirming sends them again\n/);
  });

  it("shows a journalled deploy past its TTL as expired, whatever its sends, and confirming it as sending nothing", () => {
    for (const broadcasts of [0, 2]) {
      expect(summary({ ...prepared, journal: { state: "pending", broadcasts, expired: true } })).toMatch(
        /^journal {10}resumed: these bytes expired at 2026-10-04T12:00:00.000Z and the chain does not show them landed; confirming sends nothing and waits until the chain lands or retires them\n/,
      );
    }
  });

  it("names the wallet that paid the bytes, which for a resumed deploy is the one the journal recorded", () => {
    expect(summary({ ...prepared, journal: { state: "landed", broadcasts: 1, expired: false } })).toContain("paid from        mn_addr1payer\n");
    const { payer: _, ...unrecorded } = prepared;
    expect(summary({ ...unrecorded, journal: { state: "landed", broadcasts: 1, expired: false } })).toContain("paid from        a wallet the journal did not record\n");
  });

  it("asks for a token bound to these exact bytes", () => {
    expect(confirmationToken(prepared)).toBe("DEPLOY 0123456789abcdef");
  });
});

const anchor: PreparedAnchor = {
  network: "mainnet",
  registry: "ab".repeat(32),
  author: "6a".repeat(32),
  kind: 1,
  commitment: "c1".repeat(32),
  attribute: "00".repeat(32),
  txHash: "fedcba9876543210".repeat(4),
  bytes: new Uint8Array([1, 2, 3, 4]),
  ttl: new Date("2026-10-15T12:00:00Z"),
  declaredFee: 1_000n,
  payer: "mn_addr1payer",
};

describe("the anchor summary a human approves", () => {
  const summary = (prepared: PreparedAnchor) =>
    anchorSummary({
      entry: { rootHash: "0x" + "A1".repeat(32), manifestHash: "b2".repeat(32) },
      chain: { chain: "Midnight Mainnet", genesis: "1941ca8e".padEnd(64, "0"), specVersion: 1000300, ledgerVersion: "8.1.3" },
      wallet: { dust: "mn_dust1example" },
      dust: 25_500_000_000_000_000n,
      label: "git-head",
      prepared,
    });

  it("names the label, kind, registry, commitment, author key, transaction, fee and DUST balance, and no attribute for kind 1", () => {
    expect(summary(anchor)).toBe(
      [
        "network          mainnet (Midnight Mainnet, genesis 1941ca8e00000000000000000000000000000000000000000000000000000000)",
        "runtime          1000300, ledger 8.1.3",
        "label            git-head",
        "kind             1: anchor(), a public commitment to the entry",
        `registry         ${"ab".repeat(32)}`,
        `commitment       ${"c1".repeat(32)}`,
        `root hash        ${"a1".repeat(32)}`,
        `manifest hash    ${"b2".repeat(32)}`,
        `merkle root      ${"00".repeat(32)}`,
        `author key       ${"6a".repeat(32)}`,
        `anchor tx hash   ${anchor.txHash}`,
        "fee (declared)   0.000000000001 DUST, all of it burned",
        "DUST balance     25.5 DUST at mn_dust1example",
        "paid from        mn_addr1payer",
        "valid until      2026-10-15T12:00:00.000Z",
        "final bytes      4",
      ].join("\n"),
    );
  });

  it("shows a kind-2 anchor's published attribute", () => {
    const text = summary({ ...anchor, kind: 2, attribute: "a7".repeat(32) });
    expect(text).toContain("kind             2: anchor_hiding(), a hiding commitment the attribute is bound to\n");
    expect(text).toContain(`commitment       ${"c1".repeat(32)}\nattribute        ${"a7".repeat(32)}\nauthor key       `);
  });

  it("shows an anchor resumed from the journal as the journal holds it, and what confirming then does", () => {
    expect(summary({ ...anchor, journal: { state: "landed", broadcasts: 1, expired: false } })).toMatch(/^journal {10}resumed: these bytes landed; confirming sends nothing and reads the anchor back\n/);
    expect(summary({ ...anchor, journal: { state: "pending", broadcasts: 0, expired: false } })).toMatch(/^journal {10}resumed: no send of these bytes ever returned; confirming sends them again\n/);
    expect(summary({ ...anchor, journal: { state: "pending", broadcasts: 0, expired: true } })).toMatch(/^journal {10}resumed: these bytes expired at 2026-10-15T12:00:00.000Z/);
  });

  it("asks for a token bound to these exact bytes", () => {
    expect(confirmationToken(anchor)).toBe("ANCHOR fedcba9876543210");
  });
});

// A terminal stand-in: a stream that says it is a TTY and carries what the human typed.
const terminal = (typed: string, isTTY = true) => {
  const input = Object.assign(new PassThrough(), { isTTY });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  setImmediate(() => input.end(typed));
  return { input, output };
};
const human = { PATH: "/usr/bin" };

describe("confirmOnTerminal", () => {
  it.each(["DEPLOY", "ANCHOR"])("rejects a well-formed %s token naming other bytes", async (verb) => {
    expect(await confirmOnTerminal({ ...terminal(`${verb} 0123456789abcdee\n`), token: `${verb} 0123456789abcdef`, env: human })).toBe(false);
  });

  it("is true only when the human types the exact token", async () => {
    expect(await confirmOnTerminal({ ...terminal("DEPLOY 0123456789abcdef\n"), token: "DEPLOY 0123456789abcdef", env: human })).toBe(true);
    expect(await confirmOnTerminal({ ...terminal("deploy 0123456789abcdef\n"), token: "DEPLOY 0123456789abcdef", env: human })).toBe(false);
    expect(await confirmOnTerminal({ ...terminal("yes\n"), token: "DEPLOY 0123456789abcdef", env: human })).toBe(false);
    expect(await confirmOnTerminal({ ...terminal(""), token: "DEPLOY 0123456789abcdef", env: human })).toBe(false);
  });

  it("refuses input that is not an interactive terminal, even carrying the token", async () => {
    await expect(confirmOnTerminal({ ...terminal("DEPLOY 0123456789abcdef\n", false), token: "DEPLOY 0123456789abcdef", env: human })).rejects.toThrow(/needs deci at an interactive terminal/);
  });

  it("refuses a process that carries Claude Code or Codex environment, even at a terminal with the token", async () => {
    for (const env of [{ CLAUDECODE: "1" }, { CLAUDE_CODE_ENTRYPOINT: "cli" }]) {
      await expect(confirmOnTerminal({ ...terminal("DEPLOY 0123456789abcdef\n"), token: "DEPLOY 0123456789abcdef", env })).rejects.toThrow(/this process carries Claude Code or Codex environment; deci confirms a mainnet deploy himself/);
    }
  });

  it.each(["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_CI", "CODEX_MANAGED_BY_NPM", "CODEX_MANAGED_BY_OTHER"])("refuses Codex marker %s even when empty", async (name) => {
    await expect(confirmOnTerminal({ ...terminal("DEPLOY 0123456789abcdef\n"), token: "DEPLOY 0123456789abcdef", env: { [name]: "" } })).rejects.toThrow("Claude Code or Codex environment");
  });

  it("names what it confirms in its refusals", async () => {
    const token = "ANCHOR fedcba9876543210";
    await expect(confirmOnTerminal({ ...terminal(`${token}\n`), token, env: { CLAUDECODE: "1" }, what: "a mainnet anchor" })).rejects.toThrow(
      "this process carries Claude Code or Codex environment; deci confirms a mainnet anchor himself, at his own terminal",
    );
    await expect(confirmOnTerminal({ ...terminal(`${token}\n`, false), token, env: human, what: "a mainnet anchor" })).rejects.toThrow("needs deci at an interactive terminal; a pipe or a file cannot confirm a mainnet anchor");
  });
});

// Every input is a path that does not exist, so a run that gets past the gates stops at its first
// read, before any network request.
const NOWHERE = ["--mnemonic", "/nonexistent/mnemonic.txt", "--wallet-record", "/nonexistent/wallet.json", "--blockfrost", "/nonexistent/blockfrost.project_id", "--zk", "/nonexistent/zk", "--journal", "/nonexistent/journal.sqlite"];
const humanEnvironment = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, MIDNIGHT_PP: process.env.MIDNIGHT_PP });
const quoted = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

// `script` given `inputs`, with `env`, its stdin and stdout pipes, or a pseudo-terminal from util-linux script.
function runMainnet(script: string, env: NodeJS.ProcessEnv, terminal: "pipe" | "pty", inputs: string[]) {
  const command = [process.execPath, "--import", "tsx", fileURLToPath(new URL(`../scripts/${script}.ts`, import.meta.url)), ...inputs];
  const [file, args] = terminal === "pty" ? ["script", ["-qec", command.map(quoted).join(" "), "/dev/null"]] : [command[0]!, command.slice(1)];
  return new Promise<{ code: number; out: string }>((resolve) =>
    execFile(file, args, { env, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, out: stdout + stderr })),
  );
}
const deployMainnet = (env: NodeJS.ProcessEnv, terminal: "pipe" | "pty") => runMainnet("deploy-mainnet", env, terminal, NOWHERE);

describe("scripts/deploy-mainnet.ts", () => {
  it.each(["deploy-mainnet", "anchor-mainnet"])("--pre-authorize preserves agent and pipe refusals in %s", async (script) => {
    const flags = [...NOWHERE, "--pre-authorize"];
    const agent = await runMainnet(script, { ...humanEnvironment(), CODEX_SESSION_ID: "" }, "pty", flags);
    expect(agent.out).toContain("Claude Code or Codex environment");
    const pipe = await runMainnet(script, humanEnvironment(), "pipe", flags);
    expect(pipe.out).toContain("interactive terminal");
    expect(agent.out + pipe.out).not.toContain("nonexistent");
  });
  it.each(["deploy-mainnet", "anchor-mainnet"])("refuses Codex before any file read in %s", async (script) => {
    for (const name of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_CI", "CODEX_MANAGED_BY_NPM", "CODEX_MANAGED_BY_OTHER"]) {
      const r = await runMainnet(script, { ...humanEnvironment(), [name]: "" }, "pty", NOWHERE);
      expect(r.code).toBe(1);
      expect(r.out).toContain("Claude Code or Codex environment");
      expect(r.out).not.toContain("nonexistent");
    }
  });

  it("refuses before reading anything when its input and output are not a terminal", async () => {
    const r = await deployMainnet(humanEnvironment(), "pipe");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/deploy-mainnet: needs deci at an interactive terminal/);
    expect(r.out).not.toMatch(/nonexistent/);
  });

  it("refuses at a terminal when the process carries Claude Code or Codex environment", async () => {
    const r = await deployMainnet({ ...humanEnvironment(), CLAUDECODE: "1" }, "pty");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/deploy-mainnet: this process carries Claude Code or Codex environment; deci runs a mainnet deploy himself, at his own terminal/);
    expect(r.out).not.toMatch(/nonexistent/);
  });

  it("is passed by any process of deci's that drops that environment and drives a pty: the gates stop accidents, not code running as deci", async () => {
    const r = await deployMainnet(humanEnvironment(), "pty");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/deploy-mainnet: ENOENT: no such file or directory, open '\/nonexistent\/blockfrost\.project_id'/);
  });
});

const MINUTE = 60_000;
const PROMPT = /Type exactly "((?:PREAUTHORIZE (?:DEPLOY|ANCHORS)|DEPLOY|ANCHOR) [0-9a-f]{16})"/g;
const PACKAGE = new URL("..", import.meta.url).pathname;

// `script` itself (deploy-mainnet unless named), copied with the module it shares beside a
// src/index.ts that is test/offline.ts, so it runs every gate in a pseudo-terminal and sends
// through the submit package over an offline mainnet, with the flags `flags` names beside it. At
// each confirmation prompt, `answer` types its reply to the token the script asks for, and
// `watch` sees the output so far whenever more arrives.
function offlineMainnet(script = "deploy-mainnet", flags: (root: string) => string[] = () => []) {
  const root = fresh(script);
  mkdirSync(`${root}/scripts`, { recursive: true });
  mkdirSync(`${root}/src`);
  for (const file of [`${script}.ts`, "mainnet-session.ts"]) copyFileSync(`${PACKAGE}scripts/${file}`, `${root}/scripts/${file}`);
  symlinkSync(`${PACKAGE}test/offline.ts`, `${root}/src/index.ts`);
  symlinkSync(`${PACKAGE}node_modules`, `${root}/node_modules`);
  writeFileSync(`${root}/package.json`, JSON.stringify({ type: "module" }));
  const chainFile = `${root}/chain.json`;
  writeFileSync(chainFile, JSON.stringify({ network: "mainnet", aheadMs: 0, sent: [], landed: {}, discarded: [] } satisfies OfflineChain));
  // The recorded wallet the next run opens, named `name`.
  const walletRecord = (name: string) => writeFileSync(`${root}/wallet.json`, JSON.stringify({ addresses: { unshielded: `mn_addr1${name}`, shielded: `mn_shield-addr1${name}`, dust: `mn_dust1${name}` } }));
  walletRecord("offline");
  const journalPath = `${root}/state/${script === "deploy-mainnet" ? "deploy" : "anchors"}.sqlite`;
  // The offline wallet, prover and endpoints never open the mnemonic, ZK or Blockfrost paths.
  const inputs = ["--mnemonic", "/nonexistent/mnemonic.txt", "--wallet-record", "wallet.json", "--blockfrost", "/nonexistent/blockfrost.project_id", "--zk", "/nonexistent/zk"];
  const command = [process.execPath, "--import", "tsx", `scripts/${script}.ts`, ...inputs, "--journal", journalPath, "--dust-floor", "1", ...flags(root)];
  const chain = (): OfflineChain => JSON.parse(readFileSync(chainFile, "utf8"));
  // Renamed over the chain file whole, as test/offline.ts writes it, since the script reads it at any moment.
  const save = (change: Partial<OfflineChain>) => {
    writeFileSync(`${chainFile}.test`, JSON.stringify({ ...chain(), ...change }));
    renameSync(`${chainFile}.test`, chainFile);
  };
  return {
    async run(answer: (token: string) => string | Promise<string>, fault = "", watch: (output: string) => void = () => undefined) {
      const child = spawn("script", ["-qec", command.map(quoted).join(" "), "/dev/null"], { cwd: root, env: { ...humanEnvironment(), OFFLINE_CHAIN: chainFile, OFFLINE_FAULT: fault }, timeout: 120_000 });
      let output = "";
      const tokens: string[] = [];
      child.stdout.on("data", (chunk) => {
        output += chunk;
        for (const [, token] of [...output.matchAll(PROMPT)].slice(tokens.length)) {
          tokens.push(token!);
          void Promise.resolve(answer(token!)).then((reply) => child.stdin.write(`${reply}\n`));
        }
        watch(output);
      });
      const [status] = await once(child, "close");
      return { status: status as number | null, output: output.replaceAll("\r\n", "\n"), token: tokens[0], tokens };
    },
    floor: (value: string) => { command[command.indexOf("--dust-floor") + 1] = value; },
    root,
    chain,
    update: save,
    journalPath,
    walletRecord,
    advance: (millis: number) => save({ aheadMs: chain().aheadMs + millis }),
    lagNode: (nodeLags: boolean) => save({ nodeLags }),
    // How many times the runs so far closed the wallet, and whether one left the journal open:
    // SQLite removes the write-ahead log when the last connection to the database closes.
    closes: () => ({ wallet: chain().walletCloses ?? 0, journalLeftOpen: existsSync(`${journalPath}-wal`) }),
    journal() {
      const db = new DatabaseSync(journalPath, { readOnly: true });
      const rows = db.prepare("select tx_hash, state from attempts order by id").all();
      db.close();
      return rows;
    },
  };
}

// Preprod as a view of it reads a journal: an indexer that has never seen a mainnet transaction,
// whose newest block, which the node holds, is `aheadMs` past the host's clock, and a node that
// holds no contract.
const preprodView = (aheadMs: number) => {
  const head = { height: 1000, hash: "cd".repeat(32), timestamp: Date.now() + aheadMs };
  const now = Buffer.alloc(8);
  now.writeBigUInt64LE(BigInt(head.timestamp));
  const ledger = ledgerNode({ blocks: [head.hash], contracts: () => undefined });
  const call = async (method: string, params: unknown[] = []) => {
    if (method === "chain_getBlockHash") return `0x${head.hash}`;
    if (method === "state_getStorage") return `0x${now.toString("hex")}`;
    if (method === "midnight_zswapStateRoot" || method === "midnight_contractState") return ledger.call("preprod", method, params);
    throw new Error(`preprod node: unexpected ${method}`);
  };
  const node = { call, batch: batchOver(call) };
  return chainView({ operator: "preprod", node, indexer: { transactions: async () => [], head: async () => head } } as unknown as MidnightSource, "preprod");
};

// Each test runs its own script in its own directory, so they run side by side.
describe.concurrent("scripts/deploy-mainnet.ts over an offline mainnet", () => {
  it("a wallet record changed after authorization sends nothing", async () => {
    const m = offlineMainnet("deploy-mainnet", () => ["--pre-authorize"]);
    const r = await m.run((token) => { m.walletRecord("changed"); return token; });
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("payer mismatch");
    expect(m.chain().sent).toEqual([]);
    expect(m.chain().discarded).toHaveLength(1);
  });

  it("pre-authorization rejects surrounding whitespace", async () => {
    const m = offlineMainnet("deploy-mainnet", () => ["--pre-authorize"]);
    const r = await m.run((token) => ` ${token} `);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("not pre-authorized");
    expect(m.chain().sent).toEqual([]);
  });
  it("never reports deployment inclusion from an indexer without the exact block bytes", async () => {
    const m = offlineMainnet("deploy-mainnet", () => ["--pre-authorize"]);
    const r = await m.run((token) => token, "foreign-block");
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("does not carry the deploy's bytes");
    expect(r.output).not.toContain("deployed and read back");
  });
  it("pre-authorizes before sync and sends without a second prompt", async () => {
    const m = offlineMainnet("deploy-mainnet", () => ["--pre-authorize"]);
    const r = await m.run((token) => token);
    expect(r.status, r.output).toBe(0);
    expect(r.tokens).toHaveLength(1);
    expect(r.token).toMatch(/^PREAUTHORIZE DEPLOY [0-9a-f]{16}$/);
    expect(r.output.indexOf("PREAUTHORIZE")).toBeLessThan(r.output.indexOf("Syncing the wallet"));
    expect(r.output).toContain("pre-authorized at");
    expect(m.chain().sent).toHaveLength(1);
    const resumed = await m.run((token) => token);
    expect(resumed.status, resumed.output).toBe(0);
    expect(resumed.tokens).toHaveLength(1);
    expect(m.chain().sent).toHaveLength(1);
  });

  it("a wrong pre-authorization phrase sends nothing and never syncs", async () => {
    const m = offlineMainnet("deploy-mainnet", () => ["--pre-authorize"]);
    const r = await m.run(() => "no");
    expect(r.output).toContain("not pre-authorized");
    expect(r.output).not.toContain("Syncing the wallet");
    expect(m.chain().sent).toEqual([]);
  });
  it("sends the bytes it summarized once their token is typed, and reads the registry back from the node", async ({ expect }) => {
    const m = offlineMainnet();
    const r = await m.run((token) => token);
    expect(r.status, r.output).toBe(0);
    const [sent] = m.chain().sent;
    expect(r.token).toBe(`DEPLOY ${sent!.slice(0, 16)}`);
    expect(r.output).toContain(`deploy tx hash   ${sent}`);
    expect(r.output).not.toContain("resumed");
    expect(r.output).toContain("deployed and read back from the node");
    expect(m.journal()).toEqual([{ tx_hash: sent, state: "landed" }]);
  });

  it("reports the run's own failure when closing the wallet fails too, and that failure alone otherwise", async ({ expect }) => {
    const m = offlineMainnet();
    const both = await m.run((token) => token, "refuse-broadcast,fail-close");
    expect(both.status, both.output).toBe(1);
    expect(both.output).toContain("deploy-mainnet: offline node: HTTP 403: Forbidden; closing the wallet failed: offline wallet: the facade did not stop");
    const closing = await m.run((token) => token, "fail-close");
    expect(closing.status, closing.output).toBe(1);
    expect(closing.output).toContain("deployed and read back from the node");
    expect(closing.output).toContain("deploy-mainnet: closing the wallet failed: offline wallet: the facade did not stop");
    expect(m.closes()).toEqual({ wallet: 2, journalLeftOpen: false });
  });

  it("discards the prepared bytes and sends nothing when anything but the token is typed", async ({ expect }) => {
    const m = offlineMainnet();
    const r = await m.run(() => "yes");
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("deploy-mainnet: not confirmed; the prepared bytes were discarded and nothing was sent");
    expect(m.chain()).toMatchObject({ sent: [], discarded: [expect.stringMatching(new RegExp(`^${r.token!.slice(7)}`))] });
    expect(m.journal()).toEqual([]);
  });

  it("discards the prepared bytes and sends nothing when chain time passes their TTL while the prompt waits for the token", async ({ expect }) => {
    const m = offlineMainnet();
    const r = await m.run((token) => {
      m.advance(16 * MINUTE);
      return token;
    });
    expect(r.status, r.output).toBe(1);
    expect(r.output).toMatch(/deploy-mainnet: chain time passed the prepared deploy's TTL \S+ while it awaited confirmation; its bytes were discarded and nothing was sent; rerun to prepare new bytes/);
    expect(m.chain()).toMatchObject({ sent: [], discarded: [expect.stringMatching(new RegExp(`^${r.token!.slice(7)}`))] });
    expect(m.journal()).toEqual([]);
  });

  it("after a run that failed between the broadcast and its readback, shows the journalled deploy again, asks for its token, and finishes it without sending again", async ({ expect }) => {
    const m = offlineMainnet();
    const failed = await m.run((token) => token, "lose-read");
    expect(failed.status, failed.output).toBe(1);
    expect(failed.output).toMatch(/deploy-mainnet: offline indexer: HTTP 502: Bad Gateway/);
    const [sent] = m.chain().sent;

    const rerun = await m.run((token) => token);
    expect(rerun.status, rerun.output).toBe(0);
    expect(rerun.output).toContain("journal          resumed: these bytes landed; confirming sends nothing and reads the deploy back");
    expect(rerun.output).toContain(`deploy tx hash   ${sent}`);
    expect(rerun.token).toBe(failed.token);
    expect(rerun.output).toContain("deployed and read back from the node");
    expect(m.chain()).toMatchObject({ sent: [sent], discarded: [] });
    expect(m.journal()).toEqual([{ tx_hash: sent, state: "landed" }]);
  });

  it("after a run that failed between the broadcast and its readback, resumes that deploy though a preprod reconcile of the same journal file ran past its TTL plus the margin", async ({ expect }) => {
    const m = offlineMainnet();
    const failed = await m.run((token) => token, "lose-read");
    expect(failed.status, failed.output).toBe(1);
    const [sent] = m.chain().sent;
    m.advance(20 * MINUTE + 1_000);
    const shared = openJournal(m.journalPath);
    expect(await shared.reconcile(preprodView(m.chain().aheadMs))).toEqual([]);
    shared.close();

    const rerun = await m.run((token) => token);
    expect(rerun.status, rerun.output).toBe(0);
    expect(rerun.output).toContain("journal          resumed: these bytes landed; confirming sends nothing and reads the deploy back");
    expect(rerun.token).toBe(failed.token);
    expect(m.chain()).toMatchObject({ sent: [sent], discarded: [] });
    expect(m.journal()).toEqual([{ tx_hash: sent, state: "landed" }]);
  });

  it("once the chain is past the TTL plus the margin of a deploy whose broadcast a proxy refused, retires it, then shows new bytes, asks for their token and deploys them", async ({ expect }) => {
    const m = offlineMainnet();
    expect(await m.run((token) => token, "refuse-broadcast")).toMatchObject({ status: 1 });
    const [refused] = m.chain().sent;
    m.advance(15 * MINUTE + 5 * MINUTE + 1_000);

    const rerun = await m.run((token) => token);
    expect(rerun.status, rerun.output).toBe(0);
    const [, deployed] = m.chain().sent;
    expect(deployed).not.toBe(refused);
    expect(rerun.token).toBe(`DEPLOY ${deployed!.slice(0, 16)}`);
    expect(rerun.output).not.toContain("resumed");
    expect(rerun.output).toContain("deployed and read back from the node");
    expect(m.journal()).toEqual([
      { tx_hash: refused, state: "failed" },
      { tx_hash: deployed, state: "landed" },
    ]);
  });

  it("finishes a deploy that landed while its readback failed though the wallet is now under the DUST floor: the floor applies only when bytes may be sent", async ({ expect }) => {
    const m = offlineMainnet();
    expect(await m.run((token) => token, "lose-read")).toMatchObject({ status: 1 });
    const [sent] = m.chain().sent;
    const rerun = await m.run((token) => token, "low-dust");
    expect(rerun.status, rerun.output).toBe(0);
    expect(rerun.output).toContain("journal          resumed: these bytes landed; confirming sends nothing and reads the deploy back");
    expect(rerun.output).toContain("DUST balance     0.5 DUST at mn_dust1offline");
    expect(rerun.output).toContain("deployed and read back from the node");
    expect(m.chain()).toMatchObject({ sent: [sent], discarded: [] });
    expect(m.journal()).toEqual([{ tx_hash: sent, state: "landed" }]);
  });

  it("under the DUST floor, prepares no deploy and resends no journalled bytes, refusing before any summary", async ({ expect }) => {
    const m = offlineMainnet();
    const fresh = await m.run((token) => token, "low-dust");
    expect(fresh.status, fresh.output).toBe(1);
    expect(fresh.output).toContain("deploy-mainnet: the wallet holds 0.5 DUST, below the 1 DUST floor");
    expect([fresh.token, fresh.output.includes("deploy tx hash")]).toEqual([undefined, false]);
    expect(m.chain()).toMatchObject({ sent: [], discarded: [] });
    expect(m.journal()).toEqual([]);

    expect(await m.run((token) => token, "refuse-broadcast")).toMatchObject({ status: 1 });
    const [refused] = m.chain().sent;
    const resend = await m.run((token) => token, "low-dust");
    expect(resend.status, resend.output).toBe(1);
    expect(resend.output).toContain("deploy-mainnet: the wallet holds 0.5 DUST, below the 1 DUST floor");
    expect(resend.token).toBeUndefined();
    expect(m.chain()).toMatchObject({ sent: [refused], discarded: [] });
  });

  it("refuses a resumed deploy confirmed once the chain is past its TTL plus the margin, sending nothing, and says to rerun", async ({ expect }) => {
    const m = offlineMainnet();
    expect(await m.run((token) => token, "refuse-broadcast")).toMatchObject({ status: 1 });
    const [refused] = m.chain().sent;
    m.advance(10 * MINUTE);
    const late = await m.run((token) => {
      m.advance(11 * MINUTE);
      return token;
    });
    expect(late.status, late.output).toBe(1);
    expect(late.output).toContain("journal          resumed: no send of these bytes ever returned; confirming sends them again");
    expect(late.output).toContain("deploy-mainnet: the journalled deploy expired without landing; rerun to prepare new bytes");
    expect(late.output).not.toContain("UNIQUE");
    expect(m.chain()).toMatchObject({ sent: [refused], discarded: [] });
    expect(m.journal()).toEqual([{ tx_hash: refused, state: "failed" }]);
  });

  it("shows a journalled deploy past its TTL as expired and paid by the wallet that journalled it, applies no DUST floor to it, and once confirmed sends nothing and waits until the chain retires it", async ({ expect }) => {
    const m = offlineMainnet();
    expect(await m.run((token) => token, "refuse-broadcast")).toMatchObject({ status: 1 });
    const [refused] = m.chain().sent;
    m.advance(16 * MINUTE);
    m.walletRecord("other");
    const r = await m.run((token) => {
      setTimeout(() => m.advance(5 * MINUTE), 1_000);
      return token;
    }, "low-dust");
    expect(r.status, r.output).toBe(1);
    expect(r.output).toMatch(/journal {10}resumed: these bytes expired at \S+ and the chain does not show them landed; confirming sends nothing and waits until the chain lands or retires them\n/);
    expect(r.output).toContain("paid from        mn_addr1offline\n");
    expect(r.output).toContain("DUST balance     0.5 DUST at mn_dust1other\n");
    expect(r.output).toContain("deploy-mainnet: the journalled deploy expired without landing; rerun to prepare new bytes");
    expect(m.chain()).toMatchObject({ sent: [refused], discarded: [] });
    expect(m.journal()).toEqual([{ tx_hash: refused, state: "failed" }]);
  });

  it("shows a journalled deploy past its TTL as expired and, confirmed while the node lacks the indexer's newest block, sends nothing and waits until the chain retires it", async ({ expect }) => {
    const m = offlineMainnet();
    expect(await m.run((token) => token, "refuse-broadcast")).toMatchObject({ status: 1 });
    const [refused] = m.chain().sent;
    m.advance(16 * MINUTE);
    const r = await m.run((token) => {
      m.lagNode(true);
      setTimeout(() => {
        m.lagNode(false);
        m.advance(5 * MINUTE);
      }, 1_000);
      return token;
    });
    expect(r.status, r.output).toBe(1);
    expect(r.output).toMatch(/journal {10}resumed: these bytes expired at \S+ and the chain does not show them landed; confirming sends nothing and waits until the chain lands or retires them\n/);
    expect(r.output).toContain("deploy-mainnet: the journalled deploy expired without landing; rerun to prepare new bytes");
    expect(m.chain()).toMatchObject({ sent: [refused], discarded: [] });
    expect(m.journal()).toEqual([{ tx_hash: refused, state: "failed" }]);
  });

  it("refuses a resumed deploy no send of which returned, confirmed while the node lacks the indexer's newest block, sending nothing, and leaves it journalled", async ({ expect }) => {
    const m = offlineMainnet();
    expect(await m.run((token) => token, "refuse-broadcast")).toMatchObject({ status: 1 });
    const [refused] = m.chain().sent;
    m.advance(10 * MINUTE);
    const r = await m.run((token) => {
      m.lagNode(true);
      return token;
    });
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("journal          resumed: no send of these bytes ever returned; confirming sends them again");
    expect(r.output).toContain("deploy-mainnet: the mainnet node does not hold the indexer's newest block, so chain time is unknown and the journalled bytes may be past their TTL; nothing was sent");
    expect(m.chain()).toMatchObject({ sent: [refused], discarded: [] });
    expect(m.journal()).toEqual([{ tx_hash: refused, state: "pending" }]);
  });

  it("closes the journal and the wallet on every way out, with its exit code: declined, refused under the DUST floor, failed, declined on resume, deployed", async ({ expect }) => {
    const m = offlineMainnet();
    const exits: Array<number | null> = [];
    const run = async (answer: (token: string) => string, fault: string, said: string) => {
      const r = await m.run(answer, fault);
      expect(r.output).toContain(said);
      exits.push(r.status);
      expect(m.closes()).toEqual({ wallet: exits.length, journalLeftOpen: false });
    };
    await run(() => "no", "", "deploy-mainnet: not confirmed; the prepared bytes were discarded and nothing was sent");
    await run((token) => token, "low-dust", "deploy-mainnet: the wallet holds 0.5 DUST, below the 1 DUST floor");
    await run((token) => token, "refuse-broadcast", "deploy-mainnet: offline node: HTTP 403: Forbidden");
    await run(() => "no", "", "deploy-mainnet: not confirmed; nothing was sent, and the journalled deploy stays in the journal");
    await run((token) => token, "", "deployed and read back from the node");
    expect(exits).toEqual([1, 1, 1, 1, 0]);
  });

  it("refuses journalled bytes that deploy a state other than the registry's before any summary or token", async ({ expect }) => {
    const m = offlineMainnet();
    expect(await m.run((token) => token, "refuse-broadcast")).toMatchObject({ status: 1 });
    const [refused] = m.chain().sent;
    const db = new DatabaseSync(m.journalPath);
    db.prepare("update attempts set bytes = ?").run((await mutableDeploy("mainnet")).serialize());
    db.close();
    const r = await m.run((token) => token);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toMatch(/deploy-mainnet: .*threshold must be exactly 1, got 0/);
    expect([r.token, r.output.includes("deploy tx hash"), r.output.includes("resumed")]).toEqual([undefined, false, false]);
    expect(m.chain()).toMatchObject({ sent: [refused], discarded: [] });
  });

  it("sends a journalled deploy whose broadcast a proxy refused again only once its token is typed again, and leaves it journalled when it is not", async ({ expect }) => {
    const m = offlineMainnet();
    expect(await m.run((token) => token, "refuse-broadcast")).toMatchObject({ status: 1, output: expect.stringMatching(/deploy-mainnet: offline node: HTTP 403: Forbidden/) });
    const [refused] = m.chain().sent;
    m.advance(10 * MINUTE);

    const declined = await m.run(() => "no");
    expect(declined.status, declined.output).toBe(1);
    expect(declined.output).toContain("journal          resumed: no send of these bytes ever returned; confirming sends them again");
    expect(declined.output).toContain(`deploy tx hash   ${refused}`);
    expect(declined.output).toContain("deploy-mainnet: not confirmed; nothing was sent, and the journalled deploy stays in the journal");
    expect(m.chain()).toMatchObject({ sent: [refused], discarded: [] });
    expect(m.journal()).toEqual([{ tx_hash: refused, state: "pending" }]);

    const confirmed = await m.run((token) => token);
    expect(confirmed.status, confirmed.output).toBe(0);
    expect(confirmed.token).toBe(`DEPLOY ${refused!.slice(0, 16)}`);
    expect(m.chain()).toMatchObject({ sent: [refused, refused], discarded: [] });
    expect(m.journal()).toEqual([{ tx_hash: refused, state: "landed" }]);
  });
});

// Every anchor-mainnet input is a path that does not exist, so a run that gets past the gates
// stops at its first read, the plan, before any network request.
const ANCHOR_NOWHERE = [
  ...NOWHERE,
  "--plan",
  "/nonexistent/plan.json",
  "--deploy-journal",
  "/nonexistent/deploy.sqlite",
  "--author-key",
  "/nonexistent/author.key",
  "--salt-key",
  "/nonexistent/salt.key",
  "--results",
  "/nonexistent/results.json",
];

describe("scripts/anchor-mainnet.ts", () => {
  it("refuses before reading anything when its input and output are not a terminal", async () => {
    const r = await runMainnet("anchor-mainnet", humanEnvironment(), "pipe", ANCHOR_NOWHERE);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/anchor-mainnet: needs deci at an interactive terminal; a pipe or a file cannot confirm a mainnet anchor/);
    expect(r.out).not.toMatch(/nonexistent/);
  });

  it("refuses at a terminal when the process carries Claude Code or Codex environment", async () => {
    for (const env of [{ CLAUDECODE: "1" }, { CLAUDE_CODE_ENTRYPOINT: "cli" }]) {
      const r = await runMainnet("anchor-mainnet", { ...humanEnvironment(), ...env }, "pty", ANCHOR_NOWHERE);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/anchor-mainnet: this process carries Claude Code or Codex environment; deci writes mainnet anchors himself, at his own terminal/);
      expect(r.out).not.toMatch(/nonexistent/);
    }
  });

  it("is passed by any process of deci's that drops that environment and drives a pty, which then reads the plan first", async () => {
    const r = await runMainnet("anchor-mainnet", humanEnvironment(), "pty", ANCHOR_NOWHERE);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/anchor-mainnet: ENOENT: no such file or directory, open '\/nonexistent\/plan\.json'/);
  });

  it("refuses an unknown flag, a missing plan, a flag whose value is another flag and a flag given twice before reading anything", async () => {
    const typo = await runMainnet("anchor-mainnet", humanEnvironment(), "pty", [...ANCHOR_NOWHERE, "--dust-flor", "50"]);
    expect([typo.code, typo.out]).toEqual([1, expect.stringContaining("anchor-mainnet: unknown flag --dust-flor")]);
    const planless = await runMainnet("anchor-mainnet", humanEnvironment(), "pty", NOWHERE);
    expect([planless.code, planless.out]).toEqual([1, expect.stringContaining("anchor-mainnet: --plan is required")]);
    const valueless = await runMainnet("anchor-mainnet", humanEnvironment(), "pty", ["--plan", "--journal", "/nonexistent/journal.sqlite"]);
    expect([valueless.code, valueless.out]).toEqual([1, expect.stringContaining("anchor-mainnet: --plan needs a value, not the flag --journal")]);
    const twice = await runMainnet("anchor-mainnet", humanEnvironment(), "pty", [...ANCHOR_NOWHERE, "--dust-floor", "50", "--dust-floor", "5"]);
    expect([twice.code, twice.out]).toEqual([1, expect.stringContaining("anchor-mainnet: --dust-floor is given twice")]);
    expect(typo.out + planless.out + valueless.out + twice.out).not.toMatch(/nonexistent/);
  });
});

const randomHash = () => randomBytes(32).toString("hex");
const planEntries = () => [
  { label: "git-head", kind: 1, rootHash: randomHash(), manifestHash: randomHash(), merkleRoot: randomHash() },
  { label: "hidden-suite", kind: 2, rootHash: randomHash(), manifestHash: randomHash(), merkleRoot: randomHash(), attribute: randomHash() },
];
// FPS's mainnet registry as deploy-mainnet leaves its journal: deployed through registryDeployer,
// sent and landed. Every anchor test copies that journal as its deploy journal.
const FPS_DEPLOY = await (async () => {
  const net = chain();
  const journalPath = fresh("mainnet-deploy.sqlite");
  const deployer = registryDeployer({ network: "mainnet", wallet: wallet(net, () => journalPath), source: net.source, prover, journalPath, pollMillis: 1 });
  const { address } = await deployer.submit(await deployer.prepare());
  deployer.close();
  return { journalPath, address };
})();
const REGISTRY = FPS_DEPLOY.address;
type PlanEntry = ReturnType<typeof planEntries>[number] & { attribute?: string };

// anchor-mainnet over an offline mainnet whose node holds `state` at REGISTRY (none when null),
// deployed before the run as FPS's deploy journal records, with throwaway author and salt keys it
// pins as the FPS mainnet keys and a plan of `entries` for `registry`.
function offlineAnchors({ state = registryInitialState(), entries = planEntries() as unknown[], registry = REGISTRY, preauthorize = false }: { state?: L.ContractState | null; entries?: unknown[]; registry?: string; preauthorize?: boolean } = {}) {
  const m = offlineMainnet("anchor-mainnet", (root) => [
    "--plan",
    `${root}/plan.json`,
    "--deploy-journal",
    `${root}/state/deploy.sqlite`,
    "--author-key",
    `${root}/author.key`,
    "--salt-key",
    `${root}/salt.key`,
    "--results",
    `${root}/state/results.json`,
    ...(preauthorize ? ["--pre-authorize"] : []),
  ]);
  const deployJournal = `${m.root}/state/deploy.sqlite`;
  mkdirSync(`${m.root}/state`, { mode: 0o700 });
  copyFileSync(FPS_DEPLOY.journalPath, deployJournal);
  chmodSync(deployJournal, 0o600);
  const author = createAuthorKeyFile(`${m.root}/author.key`);
  const saltKeyId = createSaltKeyFile(`${m.root}/salt.key`);
  const deployed = state === null ? {} : { ["d0".repeat(32)]: { raw: "", height: 400, address: REGISTRY, state: hex(state.serialize()) } };
  m.update({ landed: deployed, fpsKeys: { authorKeys: [author], saltKeyIds: [saltKeyId] } });
  writeFileSync(`${m.root}/plan.json`, JSON.stringify({ registry, entries }));
  const resultsPath = `${m.root}/state/results.json`;
  return {
    ...m,
    entries: entries as PlanEntry[],
    deployJournal,
    author,
    saltKeyId,
    saltKey: readAuthorSecret(`${m.root}/salt.key`),
    resultsPath,
    results: () => (existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : null),
    // The transactions the node was handed, past the registry's deploy.
    sent: () => m.chain().sent,
  };
}

const kind2Commitment = (e: PlanEntry, saltKey: Uint8Array) => {
  const digest = hiddenDigest(e, e.attribute!);
  return hex(hidingCommitment(digest, deriveSalt(saltKey, digest)));
};

describe.concurrent("scripts/anchor-mainnet.ts over an offline mainnet", () => {
  it("pre-authorizes all plan entries once before syncing", async () => {
    const m = offlineAnchors({ preauthorize: true });
    const r = await m.run((token) => token);
    expect(r.status, r.output).toBe(0);
    expect(r.tokens).toHaveLength(1);
    expect(r.token).toMatch(/^PREAUTHORIZE ANCHORS [0-9a-f]{16}$/);
    expect(m.sent()).toHaveLength(m.entries.length);
    expect(m.results()).toHaveLength(m.entries.length);
    const resumed = await m.run((token) => token);
    expect(resumed.status, resumed.output).toBe(0);
    expect(m.sent()).toHaveLength(m.entries.length);
  });

  it("a plan changed after authorization sends nothing", async () => {
    const m = offlineAnchors({ preauthorize: true });
    const r = await m.run((token) => {
      writeFileSync(`${m.root}/plan.json`, JSON.stringify({ registry: REGISTRY, entries: m.entries }, null, 2));
      return token;
    });
    expect(r.status, r.output).toBe(1);
    expect(m.sent()).toEqual([]);
  });
  it("rejects a token naming other bytes and discards the unconfirmed anchor", async ({ expect }) => {
    const m = offlineAnchors();
    const r = await m.run((token) => token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"));
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("not confirmed; the prepared bytes were discarded");
    expect(m.sent()).toEqual([]);
    expect(m.chain().discarded).toHaveLength(1);
    expect(m.results()).toBeNull();
  });

  it("records a label once when another run records the same landed anchor during confirmation", async ({ expect }) => {
    const m = offlineAnchors({ entries: planEntries().slice(0, 1) });
    expect((await m.run((token) => token)).status).toBe(0);
    rmSync(m.resultsPath);
    let other: Awaited<ReturnType<typeof m.run>>;
    const r = await m.run(async (token) => {
      other = await m.run((token) => token);
      return token;
    });
    expect(other!.status, other!.output).toBe(0);
    expect(r.status, r.output).toBe(0);
    expect(m.results()).toHaveLength(1);
    expect(m.sent()).toHaveLength(1);
  });

  it("refuses a conflicting label written during confirmation", async ({ expect }) => {
    const m = offlineAnchors({ entries: planEntries().slice(0, 1) });
    const r = await m.run((token) => {
      writeFileSync(m.resultsPath, JSON.stringify([{ label: "git-head", txHash: "ff".repeat(32) }]));
      return token;
    });
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("already records git-head with another transaction");
    expect(m.results()).toEqual([{ label: "git-head", txHash: "ff".repeat(32) }]);
  });

  it.each(["results", "wallet-record"])("never echoes malformed %s contents", async (target) => {
    const m = offlineAnchors();
    const path = target === "results" ? m.resultsPath : `${m.root}/wallet.json`;
    writeFileSync(path, "fixture-private-content-not-json");
    const r = await m.run((token) => token);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain(`${path === m.resultsPath ? path : "wallet.json"} is not JSON`);
    expect(r.output).not.toContain("fixture-pr");
    expect(m.sent()).toEqual([]);
  });

  it("refuses a results hash different from the journal's landed transaction", async ({ expect }) => {
    const m = offlineAnchors({ entries: planEntries().slice(0, 1) });
    expect((await m.run((token) => token)).status).toBe(0);
    const rows = m.results();
    rows[0].txHash = "ff".repeat(32);
    writeFileSync(m.resultsPath, JSON.stringify(rows));
    const r = await m.run((token) => token);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("which the journal does not hold landed for this entry");
    expect(r.tokens).toEqual([]);
    expect(m.sent()).toHaveLength(1);
  });

  it("refuses non-list results before reading the chain or syncing the wallet", async ({ expect }) => {
    const m = offlineAnchors();
    writeFileSync(m.resultsPath, "{}");
    m.update({ network: "preprod" });
    const r = await m.run((token) => token);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("does not hold a list of anchors");
    expect(r.output).not.toMatch(/Syncing|node serves/);
    expect(m.closes().wallet).toBe(0);
    expect(m.sent()).toEqual([]);
  });

  it.each(["1e3", "0.1234567890123456"])("refuses malformed DUST floor %s with the format diagnostic", async (floor) => {
    const m = offlineAnchors();
    m.floor(floor);
    const r = await m.run((token) => token);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("--dust-floor takes DUST as a decimal number with at most 15 places");
    expect(r.output).not.toContain("Syncing");
    expect(m.sent()).toEqual([]);
  });

  it.each(["0.4", "0.5"])("enforces a 0.5 DUST floor at balance %s", async (balance) => {
    const m = offlineAnchors({ entries: planEntries().slice(0, 1) });
    m.floor("0.5");
    const r = await m.run((token) => token, balance === "0.4" ? "dust-0.4" : "low-dust");
    expect(r.status, r.output).toBe(balance === "0.4" ? 1 : 0);
    if (balance === "0.4") {
      expect(r.output).toContain("holds 0.4 DUST, below the 0.5 DUST floor");
      expect(r.tokens).toEqual([]);
    }
    expect(m.sent()).toHaveLength(balance === "0.4" ? 0 : 1);
  });

  it("anchors each entry of the plan in order once its token is typed, reads each back final from the node, records only public data, and a rerun sends nothing", async ({ expect }) => {
    const m = offlineAnchors();
    const [one, two] = m.entries as [PlanEntry, PlanEntry];
    const r = await m.run((token) => token);
    expect(r.status, r.output).toBe(0);
    const [first, second] = m.sent();
    expect(r.tokens).toEqual([`ANCHOR ${first!.slice(0, 16)}`, `ANCHOR ${second!.slice(0, 16)}`]);
    expect(r.output).toContain(`registry ${REGISTRY} holds the immutable registry`);
    expect(r.output).toContain(
      `label            git-head\nkind             1: anchor(), a public commitment to the entry\nregistry         ${REGISTRY}\ncommitment       ${hex(entryCommitment(one))}\nroot hash        ${one.rootHash}\nmanifest hash    ${one.manifestHash}\nmerkle root      ${one.merkleRoot}\nauthor key       ${m.author}\nanchor tx hash   ${first}\n`,
    );
    expect(r.output).toContain(`label            hidden-suite\nkind             2: anchor_hiding(), a hiding commitment the attribute is bound to\nregistry         ${REGISTRY}\ncommitment       ${kind2Commitment(two, m.saltKey)}\nattribute        ${two.attribute}\n`);
    expect(m.results()).toEqual([
      { label: "git-head", kind: 1, txHash: first, block: 501, blockHash: "ab".repeat(32), commitment: hex(entryCommitment(one)), registry: REGISTRY, author: m.author },
      { label: "hidden-suite", kind: 2, txHash: second, block: 502, blockHash: "ab".repeat(32), commitment: kind2Commitment(two, m.saltKey), attribute: two.attribute, registry: REGISTRY, author: m.author },
    ]);
    expect(statSync(m.resultsPath).mode & 0o777).toBe(0o600);
    const published = readFileSync(m.resultsPath, "utf8") + r.output;
    for (const hidden of [two.rootHash, two.manifestHash, two.merkleRoot, hex(m.saltKey), readFileSync(`${m.root}/author.key`, "utf8").trim()]) expect(published).not.toContain(hidden);
    expect(r.output).toContain(`2 anchors are recorded in ${m.resultsPath}`);
    expect(m.journal()).toEqual([
      { tx_hash: first, state: "landed" },
      { tx_hash: second, state: "landed" },
    ]);

    const again = await m.run((token) => token);
    expect(again.status, again.output).toBe(0);
    expect(again.tokens).toEqual([]);
    expect(again.output).toContain(`git-head: anchored as ${first}, read back and recorded; nothing to send`);
    expect(m.sent()).toEqual([first, second]);
    expect(m.results()).toHaveLength(2);

    // A results file whose anchors the journal no longer holds is never answered with new bytes.
    rmSync(m.journalPath);
    const lost = await m.run((token) => token);
    expect(lost.status, lost.output).toBe(1);
    expect(lost.output).toContain(`anchor-mainnet: ${m.resultsPath} records git-head as ${first}, which the journal does not hold landed for this entry of the plan`);
    expect([lost.tokens, m.sent()]).toEqual([[], [first, second]]);
  });

  it("adds each anchor to the results file as it stands then, keeping the rows another run recorded meanwhile", async ({ expect }) => {
    const m = offlineAnchors({ entries: planEntries().slice(0, 1) });
    const other = { label: "another-run", kind: 1, txHash: "77".repeat(32), block: 9, blockHash: "88".repeat(32), commitment: "99".repeat(32), registry: REGISTRY, author: m.author };
    const r = await m.run((token) => {
      writeFileSync(m.resultsPath, JSON.stringify([other]), { mode: 0o600 });
      return token;
    });
    expect(r.status, r.output).toBe(0);
    expect(m.results()).toEqual([other, expect.objectContaining({ label: "git-head", txHash: m.sent()[0] })]);
    expect(r.output).toContain(`2 anchors are recorded in ${m.resultsPath}`);
  });

  it("discards the prepared bytes and sends and records nothing when anything but the token is typed", async ({ expect }) => {
    const m = offlineAnchors();
    const r = await m.run(() => "yes");
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("anchor-mainnet: not confirmed; the prepared bytes were discarded and nothing was sent");
    expect(m.chain()).toMatchObject({ sent: [], discarded: [expect.stringMatching(new RegExp(`^${r.token!.slice(7)}`))] });
    expect([m.journal(), m.results()]).toEqual([[], null]);
  });

  it("discards the prepared bytes and sends and records nothing when chain time passes their TTL while the prompt waits for the token", async ({ expect }) => {
    const m = offlineAnchors();
    const r = await m.run((token) => {
      m.advance(16 * MINUTE);
      return token;
    });
    expect(r.status, r.output).toBe(1);
    expect(r.output).toMatch(/anchor-mainnet: chain time passed the prepared anchor's TTL \S+ while it awaited confirmation; its bytes were discarded and nothing was sent; rerun to prepare new bytes/);
    expect(m.chain()).toMatchObject({ sent: [], discarded: [expect.stringMatching(new RegExp(`^${r.token!.slice(7)}`))] });
    expect([m.journal(), m.results()]).toEqual([[], null]);
  });

  it("after a run that failed between the broadcast and its readback, shows the journalled anchor again, asks for its token, and finishes it without sending again", async ({ expect }) => {
    const m = offlineAnchors();
    const failed = await m.run((token) => token, "lose-read");
    expect(failed.status, failed.output).toBe(1);
    expect(failed.output).toContain("anchor-mainnet: offline indexer: HTTP 502: Bad Gateway");
    const [sent] = m.sent();
    expect(m.results()).toBeNull();

    const rerun = await m.run((token) => token);
    expect(rerun.status, rerun.output).toBe(0);
    expect(rerun.output).toContain("journal          resumed: these bytes landed; confirming sends nothing and reads the anchor back");
    expect(rerun.tokens[0]).toBe(failed.token);
    expect(m.sent()).toEqual([sent, expect.any(String)]);
    expect(m.results().map((row: { txHash: string }) => row.txHash)).toEqual(m.sent());
  });

  it("records nothing while the node does not show the anchor's block final, and a rerun reads it back without sending again", async ({ expect }) => {
    const m = offlineAnchors({ entries: planEntries().slice(0, 1) });
    let late = false;
    const failed = await m.run(
      (token) => token,
      "unfinal",
      (output) => {
        if (!late && output.includes("waiting until the node finalizes it")) {
          late = true;
          m.advance(11 * MINUTE);
        }
      },
    );
    expect(failed.status, failed.output).toBe(1);
    const [sent] = m.sent();
    expect(failed.output).toContain(`anchor-mainnet: block 501 is not final on the node after 10 minutes; anchor ${sent} landed, and a rerun reads it back`);
    expect(m.results()).toBeNull();

    const rerun = await m.run((token) => token);
    expect(rerun.status, rerun.output).toBe(0);
    expect(rerun.output).toContain("journal          resumed: these bytes landed");
    expect(m.sent()).toEqual([sent]);
    expect(m.results()).toEqual([expect.objectContaining({ label: "git-head", txHash: sent, block: 501 })]);
  });

  it("refuses an anchor whose final block on the node does not carry its bytes, or whose body the node does not hold, and records nothing", async ({ expect }) => {
    const m = offlineAnchors({ entries: planEntries().slice(0, 1) });
    const r = await m.run((token) => token, "foreign-block");
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("anchor-mainnet: the node's block 501 does not carry the anchor's bytes as exactly one Midnight.send_mn_transaction");
    expect(m.results()).toBeNull();

    const bodiless = offlineAnchors({ entries: planEntries().slice(0, 1) });
    const b = await bodiless.run((token) => token, "lose-body");
    expect(b.status, b.output).toBe(1);
    expect(b.output).toContain(`anchor-mainnet: the node holds no body for its final block 501 (${"ab".repeat(32)})`);
    expect(bodiless.results()).toBeNull();
  });

  it("records nothing while the indexer places an anchor in a block other than the node's final block at that height, sending nothing again", async ({ expect }) => {
    const m = offlineAnchors({ entries: planEntries().slice(0, 1) });
    let late = false;
    const f = await m.run(
      (token) => token,
      "fork",
      (output) => {
        if (!late && output.includes("settling git-head afresh from the chain")) {
          late = true;
          m.advance(11 * MINUTE);
        }
      },
    );
    expect(f.status, f.output).toBe(1);
    const [sent] = m.sent();
    expect(f.output).toContain(`the node's final block 501 is ${"00".repeat(32)}, not ${"ab".repeat(32)}; settling git-head afresh from the chain...`);
    expect(f.output).toContain(`anchor-mainnet: the node's final block 501 is ${"00".repeat(32)}, not ${"ab".repeat(32)}, where the indexer places anchor ${sent}`);
    expect([m.sent(), m.results(), m.journal()]).toEqual([[sent], null, [{ tx_hash: sent, state: "landed" }]]);
  });

  // A run that recorded nothing because the node had not finalized its anchor's block in time,
  // which leaves the journal holding the anchor landed in block 501 of BLOCK, as the indexer
  // placed it then.
  const landedUnfinal = async (m: ReturnType<typeof offlineAnchors>) => {
    let late = false;
    const failed = await m.run(
      (token) => token,
      "unfinal",
      (output) => {
        if (!late && output.includes("waiting until the node finalizes it")) {
          late = true;
          m.advance(11 * MINUTE);
        }
      },
    );
    expect(failed.output).toContain("block 501 is not final on the node after 10 minutes");
    expect(m.journal()).toEqual([{ tx_hash: m.sent()[0], state: "landed" }]);
    return m.sent()[0]!;
  };

  it("once the node finalized another block where the journal placed a landed anchor, records the block the anchor landed in since, sending nothing again", async ({ expect }) => {
    const m = offlineAnchors({ entries: planEntries().slice(0, 1) });
    const sent = await landedUnfinal(m);
    const relanded = "ef".repeat(32);
    m.update({ landed: { ...m.chain().landed, [sent]: { ...m.chain().landed[sent]!, height: 640, block: relanded } } });

    const rerun = await m.run((token) => token);
    expect(rerun.status, rerun.output).toBe(0);
    expect(rerun.output).toContain("journal          resumed: these bytes landed");
    expect(rerun.output).toContain(`the node's final block 501 is ${"00".repeat(32)}, not ${"ab".repeat(32)}; settling git-head afresh from the chain...`);
    expect(rerun.output).toContain(`git-head landed in block 640 (${relanded}); waiting until the node finalizes it...`);
    expect(m.sent()).toEqual([sent]);
    expect(m.results()).toEqual([expect.objectContaining({ label: "git-head", txHash: sent, block: 640, blockHash: relanded })]);
    expect(m.journal()).toEqual([{ tx_hash: sent, state: "landed" }]);
  });

  it("once the node finalized another block where the journal placed a landed anchor that never landed again, records nothing, retires it when the chain carries it past its TTL plus the margin, and a rerun anchors new bytes", async ({ expect }) => {
    const m = offlineAnchors({ entries: planEntries().slice(0, 1) });
    const sent = await landedUnfinal(m);
    const { [sent]: _, ...rest } = m.chain().landed;
    m.update({ landed: rest });

    let late = false;
    const orphaned = await m.run(
      (token) => token,
      "",
      (output) => {
        if (!late && output.includes("settling git-head afresh from the chain")) {
          late = true;
          m.advance(10 * MINUTE);
        }
      },
    );
    expect(orphaned.status, orphaned.output).toBe(1);
    expect(orphaned.output).toContain("anchor-mainnet: the journalled anchor expired without landing; rerun to prepare new bytes");
    expect([m.sent(), m.results(), m.journal()]).toEqual([[sent], null, [{ tx_hash: sent, state: "failed" }]]);

    const next = await m.run((token) => token);
    expect(next.status, next.output).toBe(0);
    const [, anchored] = m.sent();
    expect(anchored).not.toBe(sent);
    expect(m.results()).toEqual([expect.objectContaining({ label: "git-head", txHash: anchored })]);
    expect(m.journal()).toEqual([
      { tx_hash: sent, state: "failed" },
      { tx_hash: anchored, state: "landed" },
    ]);
  });

  it("never sends a journalled anchor again once chain time is past its TTL: confirmed then, it waits until the chain retires it and refuses, and a rerun anchors new bytes", async ({ expect }) => {
    const m = offlineAnchors({ entries: planEntries().slice(0, 1) });
    expect(await m.run((token) => token, "refuse-broadcast")).toMatchObject({ status: 1, output: expect.stringContaining("anchor-mainnet: offline node: HTTP 403: Forbidden") });
    const [refused] = m.sent();
    m.advance(10 * MINUTE);
    const late = await m.run((token) => {
      m.advance(6 * MINUTE);
      setTimeout(() => m.advance(5 * MINUTE), 1_000);
      return token;
    });
    expect(late.status, late.output).toBe(1);
    expect(late.output).toContain("journal          resumed: no send of these bytes ever returned; confirming sends them again");
    expect(late.output).toContain("anchor-mainnet: the journalled anchor expired without landing; rerun to prepare new bytes");
    expect(m.sent()).toEqual([refused]);
    expect(m.journal()).toEqual([{ tx_hash: refused, state: "failed" }]);

    const next = await m.run((token) => token);
    expect(next.status, next.output).toBe(0);
    const [, anchored] = m.sent();
    expect(anchored).not.toBe(refused);
    expect(m.results()).toEqual([expect.objectContaining({ txHash: anchored })]);
  });

  it("refuses a registry whose state on the node is not the immutable registry, or an address holding no contract, before the wallet, any key or any byte", async ({ expect }) => {
    const mutable = registryInitialState();
    mutable.maintenanceAuthority = new L.ContractMaintenanceAuthority([], 0, 0n);
    const m = offlineAnchors({ state: mutable });
    const r = await m.run((token) => token);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("anchor-mainnet: threshold must be exactly 1, got 0");
    expect([r.tokens, r.output.includes("Syncing"), m.closes().wallet, m.sent()]).toEqual([[], false, 0, []]);

    const absent = offlineAnchors({ state: null });
    const s = await absent.run((token) => token);
    expect(s.status, s.output).toBe(1);
    expect(s.output).toContain(`anchor-mainnet: the mainnet node holds no contract at ${REGISTRY}`);
    expect([s.tokens, s.output.includes("Syncing"), absent.closes().wallet, absent.sent()]).toEqual([[], false, 0, []]);
  });

  it("refuses a registry that is not FPS's deployment, though the node holds the immutable registry there, before reading the chain or the wallet", async ({ expect }) => {
    const lookalike = buildRegistryDeploy({ networkId: "mainnet", ttl: new Date(Date.now() + 3_600_000) }).address;
    const m = offlineAnchors({ registry: lookalike });
    m.update({ landed: { ...m.chain().landed, ["d1".repeat(32)]: { raw: "", height: 401, address: lookalike, state: hex(registryInitialState().serialize()) } } });
    const r = await m.run((token) => token);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain(
      `anchor-mainnet: registry ${lookalike} is not the FPS mainnet registry: MIDNIGHT_REGISTRIES pins no generation there, and ${m.deployJournal} holds the landed deploy of ${REGISTRY}`,
    );
    expect([r.tokens, r.output.includes("holds the immutable registry"), m.closes().wallet, m.sent()]).toEqual([[], false, 0, []]);

    rmSync(m.deployJournal);
    const s = await m.run((token) => token);
    expect(s.status, s.output).toBe(1);
    expect(s.output).toContain(`anchor-mainnet: registry ${lookalike} is not the FPS mainnet registry: MIDNIGHT_REGISTRIES pins no generation there, and ${m.deployJournal} holds no landed mainnet registry deploy`);
    expect([s.tokens, existsSync(m.deployJournal), m.sent()]).toEqual([[], false, []]);
  });

  it("refuses an author key or a salt key that is not an FPS mainnet key as the operator loads it, before any byte", async ({ expect }) => {
    const m = offlineAnchors();
    m.update({ fpsKeys: { authorKeys: [...MAINNET_AUTHOR_KEYS], saltKeyIds: [m.saltKeyId] } });
    const r = await m.run((token) => token);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain(`anchor-mainnet: ${m.root}/author.key holds author key ${m.author}, not an FPS mainnet author key (${MAINNET_AUTHOR_KEYS[0]}); a mainnet operator writes under no other`);
    expect([r.tokens, m.sent(), m.closes()]).toEqual([[], [], { wallet: 1, journalLeftOpen: false }]);

    const otherSalt = "5a".repeat(32);
    m.update({ fpsKeys: { authorKeys: [m.author], saltKeyIds: [otherSalt] } });
    const s = await m.run((token) => token);
    expect(s.status, s.output).toBe(1);
    expect(s.output).toContain(`anchor-mainnet: ${m.root}/salt.key holds salt key ${m.saltKeyId}, not an FPS mainnet salt key (${otherSalt}); a mainnet operator derives no kind-2 salt from any other`);
    expect([s.tokens, m.sent()]).toEqual([[], []]);
  });

  it("refuses a plan with a field it does not define before reading the chain or the wallet", async ({ expect }) => {
    const [one] = planEntries();
    const m = offlineAnchors({ entries: [{ ...one, salt: randomHash() }] });
    // A node of another chain: a run that read the chain before the plan would refuse it instead.
    m.update({ network: "preprod" });
    const r = await m.run((token) => token);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain(`anchor-mainnet: ${m.root}/plan.json: entries[0]: unknown field "salt"`);
    expect([r.tokens, r.output.includes("Midnight Mainnet, runtime"), m.closes().wallet, m.sent()]).toEqual([[], false, 0, []]);
  });

  it("closes the journal and the wallet on every way out, with its exit code: declined, refused under the DUST floor, failed, declined on resume, anchored", async ({ expect }) => {
    const m = offlineAnchors({ entries: planEntries().slice(0, 1) });
    const exits: Array<number | null> = [];
    const run = async (answer: (token: string) => string, fault: string, said: string) => {
      const r = await m.run(answer, fault);
      expect(r.output).toContain(said);
      exits.push(r.status);
      expect(m.closes()).toEqual({ wallet: exits.length, journalLeftOpen: false });
    };
    await run(() => "no", "", "anchor-mainnet: not confirmed; the prepared bytes were discarded and nothing was sent");
    await run((token) => token, "low-dust", "anchor-mainnet: the wallet holds 0.5 DUST, below the 1 DUST floor");
    await run((token) => token, "refuse-broadcast", "anchor-mainnet: offline node: HTTP 403: Forbidden");
    await run(() => "no", "", "anchor-mainnet: not confirmed; nothing was sent, and the journalled anchor stays in the journal");
    await run((token) => token, "", "1 anchor is recorded in");
    expect(exits).toEqual([1, 1, 1, 1, 0]);
  });
});
