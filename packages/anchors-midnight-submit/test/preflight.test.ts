import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { REGISTRY_VERIFIER_KEY_SHA256, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { NETWORK_IDENTITY, assertChainIdentity, confirmOnTerminal, confirmationToken, deploySummary } from "../src/preflight.js";
import type { PreparedDeploy } from "../src/deployer.js";

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
};

describe("the deploy summary a human approves", () => {
  it("names the network, the contract address, the verifier keys, the authority form, the fee and the DUST balance", () => {
    const text = deploySummary({
      chain: { chain: "Midnight Mainnet", genesis: "1941ca8e".padEnd(64, "0"), specVersion: 1000300, ledgerVersion: "8.1.1" },
      wallet: { unshielded: "mn_addr1example", dust: "mn_dust1example" },
      dust: 25_500_000_000_000_000n,
      prepared,
    });
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
      "paid from        mn_addr1example",
      "valid until      2026-10-04T12:00:00.000Z",
    ]) {
      expect(text).toContain(expected);
    }
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

  it("refuses a process an agent drives, even at a terminal with the token", async () => {
    for (const env of [{ CLAUDECODE: "1" }, { CLAUDE_CODE_ENTRYPOINT: "cli" }]) {
      await expect(confirmOnTerminal({ ...terminal("DEPLOY 0123456789abcdef\n"), token: "DEPLOY 0123456789abcdef", env })).rejects.toThrow(/an agent drives this process/);
    }
  });
});

describe("scripts/deploy-mainnet.ts", () => {
  it("refuses before reading any secret when it is not run by a human at a terminal", async () => {
    const script = fileURLToPath(new URL("../scripts/deploy-mainnet.ts", import.meta.url));
    const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
      execFile(process.execPath, ["--import", "tsx", script, "--mnemonic", "/nonexistent/mnemonic.txt"], { encoding: "utf8" }, (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
      ),
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/deploy-mainnet: (needs deci at an interactive terminal|an agent drives this process)/);
    expect(r.stderr).not.toMatch(/nonexistent/);
  });
});
