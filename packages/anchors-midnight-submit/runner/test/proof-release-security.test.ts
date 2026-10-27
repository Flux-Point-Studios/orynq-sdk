import { readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import { openJournal } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { buildProofDeploy, proofProvider, PROOF_PINS } from "@fluxpointstudios/orynq-sdk-midnight-prover";
import { withFixtureProof } from "../../../midnight-prover/tests/fixture-prover.js";
import { stateRoot } from "./helpers.js";
import { fresh } from "../../test/fakes.js";
import { runIntent } from "../run.js";
import { admit } from "../gate.js";
import { proofReleaseIntent, proofReleaseStatements } from "../proof-release-intent.js";
import { proofReleaseJournal } from "../../src/proof-release.js";
import { ensureRunnerRoot } from "../state.js";

const intent = proofReleaseIntent();
const hex = (c: string) => c.repeat(32);
// A landed pinned deploy in the proofs journal, so call summaries can name its address.
async function landedDeploy(root: string) {
  const path = proofReleaseJournal(root); openJournal(path).close();
  const { tx, address } = buildProofDeploy("mainnet", new Date(Date.now() + 600e3));
  const fin = (await tx.prove(withFixtureProof(proofProvider("unused")), L.CostModel.initialCostModel())).bind();
  const db = new DatabaseSync(path);
  db.prepare("insert into attempts (key, tx_hash, bytes, ttl_ms, state, height, block_hash) values (?, ?, ?, ?, ?, ?, ?)").run(["mainnet", "proof-deploy", "", 0, PROOF_PINS.initialStateSha256, ""].join("/"), fin.transactionHash(), fin.serialize(), Date.now() + 600e3, "landed", 7, hex("ab"));
  db.close();
  return address;
}
const summary = (o: { label: string; contract: string; txHash: string; notAfter: number; fee?: string; statement?: unknown; authority?: string }) => [
  `network ${intent.network}`, "runtime 1000300", "DUST balance 20 DUST", "final bytes 8000", `label ${o.label}`, `contract ${o.contract}`, `code hash ${intent.codeHash}`, `initial state ${intent.initialStateSha256}`, `authority ${o.authority ?? intent.authority}`,
  ...(o.statement ? [`statement ${JSON.stringify(o.statement)}`] : []), `paid from ${intent.payer}`, `fee (declared) ${o.fee ?? "0.000000000000002"} DUST`,
  `valid until ${new Date(o.notAfter * 1000).toISOString()}`, `proof tx hash ${o.txHash}`].join("\n");
async function drive(prompts: { label: string; summary: string; txHash: string; verb?: string }[], setup?: (root: ReturnType<typeof stateRoot>) => Promise<void>, existing?: ReturnType<typeof stateRoot>, existingId?: string) {
  const root = existing ?? stateRoot();
  ensureRunnerRoot(root.paths.root);
  if (setup) await setup(root);
  const id = existingId ?? root.approve(intent);
  const record = fresh("record.jsonl");
  const status = await runIntent({ paths: root.paths, id, cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, PROOF_TEST_SCENARIO: JSON.stringify({ record, prompts }) }, backoffMs: [10], tool: () => [process.execPath, "--import", "tsx", "runner/test/fake-proof-tool.ts"] });
  const typed = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  return { status, typed, root, id };
}
const now = () => Math.floor(Date.now() / 1000);

describe("proofs action cannot be widened at confirmation", () => {
  it("CONTROL: confirms a pinned deploy summary and the exact synthetic calls", async () => {
    let addr = "";
    const na = now() + 1800; const [cap, roll] = proofReleaseStatements(na);
    const r = await drive([], async root => { addr = await landedDeploy(root.paths.root); });
    // Run again with prompts naming the landed deploy (the address is only known after setup).
    const r2 = await drive([
      { label: "proveCapability", txHash: hex("c1"), summary: summary({ label: "proveCapability", contract: addr, txHash: hex("c1"), notAfter: na, statement: cap }) },
      { label: "proveRolling1", txHash: hex("c2"), summary: summary({ label: "proveRolling1", contract: addr, txHash: hex("c2"), notAfter: na, statement: roll }) },
    ], undefined, r.root, r.root.approve({ ...intent, maxFeeDust: "0.010" }));
    expect(r2.typed).toEqual([{ label: "proveCapability", ok: true }, { label: "proveRolling1", ok: true }]);
  });
  it.each([
    ["a non-synthetic statement (a real user's presentation)", (addr: string, na: number) => ({ label: "proveCapability", contract: addr, txHash: hex("d1"), notAfter: na, statement: { ...proofReleaseStatements(na)[0], contextDigest: hex("77") } })],
    ["a call to another contract", (_: string, na: number) => ({ label: "proveCapability", contract: hex("ee"), txHash: hex("d2"), notAfter: na, statement: proofReleaseStatements(na)[0] })],
    ["a fee above 0.01 DUST", (addr: string, na: number) => ({ label: "proveCapability", contract: addr, txHash: hex("d3"), notAfter: na, statement: proofReleaseStatements(na)[0], fee: "0.010000000000001" })],
    ["a deadline beyond one hour", (addr: string) => ({ label: "proveCapability", contract: addr, txHash: hex("d4"), notAfter: now() + 7200, statement: proofReleaseStatements(now() + 7200)[0] })],
    ["an unknown label", (addr: string, na: number) => ({ label: "proveSomethingElse", contract: addr, txHash: hex("d5"), notAfter: na, statement: proofReleaseStatements(na)[0] })],
    ["a deploy with a different authority", (_: string, na: number) => ({ label: "deploy", contract: hex("dd"), txHash: hex("d6"), notAfter: na, authority: "committee [k] (1 members), threshold 1, counter 0" })],
  ])("answers NO to %s", async (_name, make) => {
    let addr = "";
    const base = await drive([], async root => { addr = await landedDeploy(root.paths.root); });
    const na = now() + 1800; const s = make(addr, na);
    const r = await drive([{ label: s.label, txHash: s.txHash, summary: summary(s as any) }], undefined, base.root, base.root.approve({ ...intent, maxFeeDust: "0.009" }));
    expect(r.typed).toEqual([{ label: s.label, ok: false }]);
    expect(r.status.state).toBe("refused");
  });
  it("answers NO to a second deploy in the same attempt and to a DEPLOY-verb prompt", { timeout: 300_000 }, async () => {
    const na = now() + 1800;
    const d1 = { label: "deploy", txHash: hex("e1"), summary: summary({ label: "deploy", contract: hex("e9"), txHash: hex("e1"), notAfter: na }) };
    const d2 = { label: "deploy", txHash: hex("e2"), summary: summary({ label: "deploy", contract: hex("ea"), txHash: hex("e2"), notAfter: na }) };
    const r = await drive([d1, d2]);
    expect(r.typed).toEqual([{ label: "deploy", ok: true }, { label: "deploy", ok: false }]);
    const v = await drive([{ ...d1, txHash: hex("e3"), verb: "DEPLOY", summary: summary({ label: "deploy", contract: hex("eb"), txHash: hex("e3"), notAfter: na }) }]);
    expect(v.typed).toEqual([{ label: "deploy", ok: false }]);
  });
  it("cannot be replayed: the same approval is spent after the run", async () => {
    const r = await drive([]);
    expect(admit(r.root.paths, r.id, Date.now()).ok).toBe(false);
    expect((admit(r.root.paths, r.id, Date.now()) as { reason: string }).reason).toMatch(/already used/);
  });
  it.each([
    ["an extra field", { ...intent, plan: "/tmp/x" }],
    ["reordered fields", Object.fromEntries(Object.entries(intent).reverse())],
    ["a third statement", { ...intent, statements: [...intent.statements, intent.statements[0]] }],
    ["swapped statement order", { ...intent, statements: [...intent.statements].reverse() }],
    ["another network", { ...intent, network: "preprod" }],
    ["another verifier key", { ...intent, verifierKeys: { ...intent.verifierKeys, proveCapability: hex("00") } }],
    ["a non-numeric fee cap", { ...intent, maxFeeDust: "1e-2" }],
    ["a negative fee cap", { ...intent, maxFeeDust: "-0.01" }],
  ])("refuses admission of an intent with %s", (_n, changed) => {
    const root = stateRoot();
    expect(admit(root.paths, root.approve(changed as Record<string, unknown>), Date.now()).ok).toBe(false);
  });
  it("refuses an approval longer than 24 hours", () => {
    const root = stateRoot();
    const t = Date.now() - 60_000;
    const id = root.approve(intent, { approved_at: new Date(t).toISOString(), expires_at: new Date(t + 24 * 3600_000 + 1000).toISOString() });
    expect(admit(root.paths, id, Date.now()).ok).toBe(false);
  });
});
