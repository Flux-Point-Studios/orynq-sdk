import { describe, expect, it } from "vitest";
import { proofReleaseIntent, proofReleaseStatements } from "../proof-release-intent.js";
import { checkProofReleaseSummary } from "../confirm.js";
import { admit } from "../gate.js";
import { stateRoot } from "./helpers.js";
import { runIntent } from "../run.js";

describe("proof contract release admission", () => {
  it("refuses a zero exit without three landed, pinned transactions", async () => {
    const root = stateRoot();
    const id = root.approve(proofReleaseIntent());
    const status = await runIntent({ paths: root.paths, id, cwd: process.cwd(), env: { PATH: process.env.PATH }, tool: () => [process.execPath, "-e", "process.exit(0)"] });
    expect(status.state).toBe("refused");
    expect(status.refusals.at(-1)?.reason).toMatch(/three landed/);
  });
  it("admits exactly a deploy and the first proof of each circuit", () => {
    const root = stateRoot();
    const id = root.approve(proofReleaseIntent());
    expect(admit(root.paths, id, Date.now())).toMatchObject({ ok: true, action: "proofs", transactions: 3, maxFee: 10_000_000_000_000n });
  });
  it.each(["codeHash", "initialStateSha256", "payer"] as const)("refuses another %s", field => {
    const root = stateRoot();
    const id = root.approve({ ...proofReleaseIntent(), [field]: "wrong" });
    expect(admit(root.paths, id, Date.now()).ok).toBe(false);
  });
  it("refuses changed proof statements", () => {
    const root = stateRoot();
    const intent = proofReleaseIntent();
    const id = root.approve({ ...intent, statements: intent.statements.slice(0, 1) });
    expect(admit(root.paths, id, Date.now()).ok).toBe(false);
  });
  it("retains the per-transaction and daily caps", () => {
    const root = stateRoot();
    expect(admit(root.paths, root.approve({ ...proofReleaseIntent(), maxFeeDust: "0.010000000000001" }), Date.now()).ok).toBe(false);
    root.confirmed("other", "ff".repeat(32), "0.08");
    expect(admit(root.paths, root.approve(proofReleaseIntent()), Date.now()).ok).toBe(false);
  });
  it("checks exact call facts, address, fee and deadline at confirmation", () => {
    const intent = proofReleaseIntent();
    const notAfter = Math.floor(Date.now() / 1000) + 600;
    const statement = proofReleaseStatements(notAfter)[0]!;
    const hash = "ab".repeat(32);
    const summary = [
      `network ${intent.network}`, `label proveCapability`, `contract ${"cd".repeat(32)}`,
      `code hash ${intent.codeHash}`, `initial state ${intent.initialStateSha256}`,
      `statement ${JSON.stringify(statement)}`, `paid from ${intent.payer}`,
      "fee (declared) 0.000000000000002 DUST", `valid until ${new Date(notAfter * 1000).toISOString()}`, `proof tx hash ${hash}`,
    ].join("\n");
    const check = (s = summary) => checkProofReleaseSummary(intent, "cd".repeat(32), s, hash.slice(0, 16));
    expect(check().problems).toEqual([]);
    expect(check(summary.replace(intent.codeHash, "ef".repeat(32))).problems.length).toBeGreaterThan(0);
    expect(check(summary.replace("contract " + "cd".repeat(32), "contract " + "cc".repeat(32))).problems.length).toBeGreaterThan(0);
    expect(check(summary.replace(statement.contextDigest, "00".repeat(32))).problems.length).toBeGreaterThan(0);
    expect(check(summary.replace("0.000000000000002 DUST", "0.02 DUST")).problems.length).toBeGreaterThan(0);
    const lateDeploy = summary.replace("label proveCapability", "label deploy")
      .replace(new Date(notAfter * 1000).toISOString(), new Date((notAfter + 7200) * 1000).toISOString()) + `\nauthority ${intent.authority}`;
    expect(check(lateDeploy).problems).toContain("proof deadline is outside the next hour");
  });
});
