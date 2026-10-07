import { describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { REGISTRY_VERIFIER_KEY_SHA256, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { chainView, openJournal } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { NETWORK_IDENTITY, assertChainIdentity, confirmOnTerminal, confirmationToken, deploySummary } from "../src/preflight.js";
import type { PreparedDeploy } from "../src/deployer.js";
import { batchOver, ledgerNode } from "../../anchors-midnight/src/__tests__/ledger-node.js";
import { fresh, mutableDeploy } from "./fakes.js";
import type { OfflineChain } from "./offline.js";

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

// A terminal stand-in: a stream that says it is a TTY and carries what the human typed.
const terminal = (typed: string, isTTY = true) => {
  const input = Object.assign(new PassThrough(), { isTTY });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  setImmediate(() => input.end(typed));
  return { input, output };
};
const human = { PATH: "/usr/bin" };

describe("confirmOnTerminal", () => {
  it("is true only when the human types the exact token", async () => {
    expect(await confirmOnTerminal({ ...terminal("DEPLOY 0123456789abcdef\n"), token: "DEPLOY 0123456789abcdef", env: human })).toBe(true);
    expect(await confirmOnTerminal({ ...terminal("deploy 0123456789abcdef\n"), token: "DEPLOY 0123456789abcdef", env: human })).toBe(false);
    expect(await confirmOnTerminal({ ...terminal("yes\n"), token: "DEPLOY 0123456789abcdef", env: human })).toBe(false);
    expect(await confirmOnTerminal({ ...terminal(""), token: "DEPLOY 0123456789abcdef", env: human })).toBe(false);
  });

  it("refuses input that is not an interactive terminal, even carrying the token", async () => {
    await expect(confirmOnTerminal({ ...terminal("DEPLOY 0123456789abcdef\n", false), token: "DEPLOY 0123456789abcdef", env: human })).rejects.toThrow(/needs deci at an interactive terminal/);
  });

  it("refuses a process that carries Claude Code's environment, even at a terminal with the token", async () => {
    for (const env of [{ CLAUDECODE: "1" }, { CLAUDE_CODE_ENTRYPOINT: "cli" }]) {
      await expect(confirmOnTerminal({ ...terminal("DEPLOY 0123456789abcdef\n"), token: "DEPLOY 0123456789abcdef", env })).rejects.toThrow(/this process carries Claude Code's environment; deci confirms a mainnet deploy himself/);
    }
  });
});

// Every input is a path that does not exist, so a run that gets past the gates stops at its first
// read, before any network request.
const NOWHERE = ["--mnemonic", "/nonexistent/mnemonic.txt", "--wallet-record", "/nonexistent/wallet.json", "--blockfrost", "/nonexistent/blockfrost.project_id", "--zk", "/nonexistent/zk", "--journal", "/nonexistent/journal.sqlite"];
const withoutClaudeCode = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "CLAUDECODE" && !name.startsWith("CLAUDE_CODE_")));
const quoted = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

// deploy-mainnet with `env`, its stdin and stdout pipes, or a pseudo-terminal from util-linux script.
function deployMainnet(env: NodeJS.ProcessEnv, terminal: "pipe" | "pty") {
  const command = [process.execPath, "--import", "tsx", fileURLToPath(new URL("../scripts/deploy-mainnet.ts", import.meta.url)), ...NOWHERE];
  const [file, args] = terminal === "pty" ? ["script", ["-qec", command.map(quoted).join(" "), "/dev/null"]] : [command[0]!, command.slice(1)];
  return new Promise<{ code: number; out: string }>((resolve) =>
    execFile(file, args, { env, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, out: stdout + stderr })),
  );
}

describe("scripts/deploy-mainnet.ts", () => {
  it("refuses before reading anything when its input and output are not a terminal", async () => {
    const r = await deployMainnet(withoutClaudeCode(), "pipe");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/deploy-mainnet: needs deci at an interactive terminal/);
    expect(r.out).not.toMatch(/nonexistent/);
  });

  it("refuses at a terminal when the process carries Claude Code's environment", async () => {
    const r = await deployMainnet({ ...withoutClaudeCode(), CLAUDECODE: "1" }, "pty");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/deploy-mainnet: this process carries Claude Code's environment; deci runs a mainnet deploy himself, at his own terminal/);
    expect(r.out).not.toMatch(/nonexistent/);
  });

  it("is passed by any process of deci's that drops that environment and drives a pty: the gates stop accidents, not code running as deci", async () => {
    const r = await deployMainnet(withoutClaudeCode(), "pty");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/deploy-mainnet: ENOENT: no such file or directory, open '\/nonexistent\/blockfrost\.project_id'/);
  });
});

const MINUTE = 60_000;
const PROMPT = /Type exactly "(DEPLOY [0-9a-f]{16})"/;
const PACKAGE = new URL("..", import.meta.url).pathname;

// deploy-mainnet itself, copied beside a src/index.ts that is test/offline.ts, so it runs every
// gate in a pseudo-terminal and deploys through the submit package over an offline mainnet. At
// the confirmation prompt, `answer` types its reply to the token the script asks for.
function offlineMainnet() {
  const root = fresh("deploy-mainnet");
  mkdirSync(`${root}/scripts`, { recursive: true });
  mkdirSync(`${root}/src`);
  copyFileSync(`${PACKAGE}scripts/deploy-mainnet.ts`, `${root}/scripts/deploy-mainnet.ts`);
  symlinkSync(`${PACKAGE}test/offline.ts`, `${root}/src/index.ts`);
  symlinkSync(`${PACKAGE}node_modules`, `${root}/node_modules`);
  writeFileSync(`${root}/package.json`, JSON.stringify({ type: "module" }));
  const chainFile = `${root}/chain.json`;
  writeFileSync(chainFile, JSON.stringify({ network: "mainnet", aheadMs: 0, sent: [], landed: {}, discarded: [] } satisfies OfflineChain));
  // The recorded wallet the next run opens, named `name`.
  const walletRecord = (name: string) => writeFileSync(`${root}/wallet.json`, JSON.stringify({ addresses: { unshielded: `mn_addr1${name}`, shielded: `mn_shield-addr1${name}`, dust: `mn_dust1${name}` } }));
  walletRecord("offline");
  const journalPath = `${root}/state/deploy.sqlite`;
  // The offline wallet, prover and endpoints never open the mnemonic, ZK or Blockfrost paths.
  const inputs = ["--mnemonic", "/nonexistent/mnemonic.txt", "--wallet-record", "wallet.json", "--blockfrost", "/nonexistent/blockfrost.project_id", "--zk", "/nonexistent/zk"];
  const command = [process.execPath, "--import", "tsx", "scripts/deploy-mainnet.ts", ...inputs, "--journal", journalPath, "--dust-floor", "1"];
  const chain = (): OfflineChain => JSON.parse(readFileSync(chainFile, "utf8"));
  return {
    async run(answer: (token: string) => string, fault = "") {
      const child = spawn("script", ["-qec", command.map(quoted).join(" "), "/dev/null"], { cwd: root, env: { ...withoutClaudeCode(), OFFLINE_CHAIN: chainFile, OFFLINE_FAULT: fault }, timeout: 120_000 });
      let output = "";
      let token: string | undefined;
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const asked = token === undefined ? PROMPT.exec(output) : null;
        if (asked) {
          token = asked[1]!;
          child.stdin.write(`${answer(token)}\n`);
        }
      });
      const [status] = await once(child, "close");
      return { status: status as number | null, output: output.replaceAll("\r\n", "\n"), token };
    },
    chain,
    journalPath,
    walletRecord,
    advance: (millis: number) => writeFileSync(chainFile, JSON.stringify({ ...chain(), aheadMs: chain().aheadMs + millis })),
    lagNode: (nodeLags: boolean) => writeFileSync(chainFile, JSON.stringify({ ...chain(), nodeLags })),
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

  it("discards the prepared bytes and sends nothing when anything but the token is typed", async ({ expect }) => {
    const m = offlineMainnet();
    const r = await m.run(() => "yes");
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("deploy-mainnet: not confirmed; the prepared bytes were discarded and nothing was sent");
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
