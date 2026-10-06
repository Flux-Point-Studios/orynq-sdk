// run.ts's deploy phase, offline: each run is its own process over a copy of the real run.ts,
// whose ./endpoints.js and ../src/index.js are offline.ts (the submit package with its wallet,
// prover and chain replaced). A failure in one run must leave a deploy the next run finishes and
// records as the one that landed, which the evidence gate requires.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, it } from "vitest";
import { removeScratch, scratch } from "./fixture.js";
import type { OfflineChain } from "./offline.js";

const HERE = new URL("..", import.meta.url).pathname;
const OFFLINE = new URL("./offline.ts", import.meta.url).pathname;
const MINUTE = 60_000;

function rehearsal() {
  const root = scratch("deploy");
  const home = `${root}/home`;
  mkdirSync(`${root}/rehearsal/bundles`, { recursive: true });
  mkdirSync(`${root}/src`);
  mkdirSync(`${home}/.secrets/orynq-midnight-preprod`, { recursive: true });
  chmodSync(`${home}/.secrets`, 0o700);
  chmodSync(`${home}/.secrets/orynq-midnight-preprod`, 0o700);
  copyFileSync(`${HERE}run.ts`, `${root}/rehearsal/run.ts`);
  for (const file of ["gate.mjs", "wallets.json"]) symlinkSync(`${HERE}${file}`, `${root}/rehearsal/${file}`);
  symlinkSync(OFFLINE, `${root}/rehearsal/endpoints.ts`);
  symlinkSync(OFFLINE, `${root}/src/index.ts`);
  writeFileSync(`${root}/rehearsal/bundles/index.json`, "[]");
  const chainFile = `${root}/chain.json`;
  writeFileSync(chainFile, JSON.stringify({ aheadMs: 0, sent: [], landed: {} } satisfies OfflineChain));
  const chain = (): OfflineChain => JSON.parse(readFileSync(chainFile, "utf8"));
  const rawFile = `${root}/rehearsal/evidence/raw.json`;
  const raw = () => JSON.parse(readFileSync(rawFile, "utf8"));
  return {
    async run(fault = "") {
      const child = spawn(process.execPath, ["--import", "tsx", "run.ts", "deploy"], {
        cwd: `${root}/rehearsal`,
        env: { ...process.env, HOME: home, OFFLINE_CHAIN: chainFile, OFFLINE_FAULT: fault },
        timeout: 120_000,
      });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (output += chunk));
      const [status] = await once(child, "close");
      return { status: status as number | null, output };
    },
    raw,
    editRaw: (edit: (raw: Record<string, any>) => Record<string, any>) => writeFileSync(rawFile, JSON.stringify(edit(raw()))),
    chain,
    advance: (millis: number) => writeFileSync(chainFile, JSON.stringify({ ...chain(), aheadMs: chain().aheadMs + millis })),
    journal() {
      const db = new DatabaseSync(`${home}/.secrets/orynq-midnight-preprod/journal-deploy.sqlite`, { readOnly: true });
      const rows = db.prepare("select tx_hash, state from attempts order by id").all();
      db.close();
      return rows;
    },
  };
}

// The deploy as the evidence gate requires it: prepared, landed and read back as one transaction,
// at the address the chain holds.
const recorded = (chain: OfflineChain, txHash: string) => {
  const address = chain.landed[txHash]!.address;
  return { txHash, address, prepared: { txHash, address }, readback: { byteEqual: true, immutable: true } };
};

afterAll(removeScratch);

// Each test runs its own rehearsal in its own directory, so they run side by side.
describe.concurrent("run.ts deploy", () => {
  it("deploys, records the landed deploy as the one it prepared and reads it back", async ({ expect }) => {
    const r = rehearsal();
    expect(await r.run()).toMatchObject({ status: 0 });
    const [sent] = r.chain().sent;
    expect(r.raw().deploy).toMatchObject(recorded(r.chain(), sent!));
    expect(r.raw().deploy).toMatchObject({ dustBefore: String(10n ** 16n), dustAfter: String(10n ** 16n), landedAfterMs: expect.any(Number), prepared: { prepareMs: expect.any(Number) } });
    expect(r.journal()).toEqual([{ tx_hash: sent, state: "landed" }]);
  });

  it("after a run that failed once the node held the deploy, before it recorded the landing, the next run finishes that deploy and sends nothing", async ({ expect }) => {
    const r = rehearsal();
    const failed = await r.run("lose-read");
    expect(failed.status, failed.output).toBe(1);
    expect(failed.output).toMatch(/HTTP 502/);
    const [sent] = r.chain().sent;
    expect(r.raw().deploy).toMatchObject({ prepared: { txHash: sent } });
    expect(r.raw().deploy.txHash).toBeUndefined();

    const rerun = await r.run();
    expect(rerun.status, rerun.output).toBe(0);
    expect(r.raw().deploy).toMatchObject({ ...recorded(r.chain(), sent!), dustBefore: String(10n ** 16n), landedAfterMs: null });
    expect(r.chain().sent).toEqual([sent]);
    expect(r.journal()).toEqual([{ tx_hash: sent, state: "landed" }]);
  });

  it("replaces a prepared record that names other bytes than the journalled deploy, such as bytes a refused rerun prepared, with that deploy's", async ({ expect }) => {
    const r = rehearsal();
    expect(await r.run("lose-read")).toMatchObject({ status: 1 });
    const [sent] = r.chain().sent;
    r.editRaw((raw) => ({ ...raw, deploy: { prepared: { ...raw.deploy.prepared, txHash: "0f".repeat(32), address: "0e".repeat(32) } } }));

    const rerun = await r.run();
    expect(rerun.status, rerun.output).toBe(0);
    expect(r.raw().deploy).toMatchObject(recorded(r.chain(), sent!));
    expect(r.raw().deploy.prepared).not.toHaveProperty("prepareMs");
    expect(r.raw().deploy).not.toHaveProperty("dustBefore");
    expect(r.chain().sent).toEqual([sent]);
  });

  it("records the landing before the wallet's balance after it, so a run whose wallet then stops syncing leaves the next run only the readback", async ({ expect }) => {
    const r = rehearsal();
    const failed = await r.run("lose-sync");
    expect(failed.status, failed.output).toBe(1);
    expect(failed.output).toMatch(/did not sync within 600 s/);
    const [sent] = r.chain().sent;
    expect(r.raw().deploy).toMatchObject({ txHash: sent, prepared: { txHash: sent } });

    const rerun = await r.run();
    expect(rerun.status, rerun.output).toBe(0);
    expect(r.raw().deploy).toMatchObject(recorded(r.chain(), sent!));
    expect(r.chain().sent).toEqual([sent]);
  });

  it("sends the bytes a proxy refused again, unchanged, while the chain has not reached their TTL", async ({ expect }) => {
    const r = rehearsal();
    expect(await r.run("refuse-broadcast")).toMatchObject({ status: 1, output: expect.stringMatching(/HTTP 403/) });
    const [refused] = r.chain().sent;
    r.advance(10 * MINUTE);

    const rerun = await r.run();
    expect(rerun.status, rerun.output).toBe(0);
    expect(r.raw().deploy).toMatchObject(recorded(r.chain(), refused!));
    expect(r.chain().sent).toEqual([refused, refused]);
    expect(r.journal()).toEqual([{ tx_hash: refused, state: "landed" }]);
  });

  it("between the refused bytes' TTL and that TTL plus the margin, sends them again, which the node refuses, and prepares nothing new", async ({ expect }) => {
    const r = rehearsal();
    expect(await r.run("refuse-broadcast")).toMatchObject({ status: 1 });
    const [refused] = r.chain().sent;
    const prepared = r.raw().deploy.prepared;
    r.advance(15 * MINUTE + 4 * MINUTE);

    const rerun = await r.run();
    expect(rerun.status, rerun.output).toBe(1);
    expect(rerun.output).toContain(`offline node: author_submitExtrinsic failed: {"code":1010,"message":"Invalid Transaction","data":"the TTL is behind the chain's time"}`);
    expect(r.chain().sent).toEqual([refused, refused]);
    expect(r.raw().deploy).toEqual({ prepared, dustBefore: String(10n ** 16n) });
    expect(r.journal()).toEqual([{ tx_hash: refused, state: "pending" }]);
  });

  it("deploys new bytes, and records those, once the chain has carried the refused ones past their TTL", async ({ expect }) => {
    const r = rehearsal();
    expect(await r.run("refuse-broadcast")).toMatchObject({ status: 1 });
    const [refused] = r.chain().sent;
    r.advance(15 * MINUTE + 5 * MINUTE + 1_000);

    const rerun = await r.run();
    expect(rerun.status, rerun.output).toBe(0);
    const [, deployed] = r.chain().sent;
    expect(deployed).not.toBe(refused);
    expect(r.raw().deploy).toMatchObject(recorded(r.chain(), deployed!));
    expect(r.journal()).toEqual([
      { tx_hash: refused, state: "failed" },
      { tx_hash: deployed, state: "landed" },
    ]);
  });
});
