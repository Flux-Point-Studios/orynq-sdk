import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { afterDeployRegistry, deployIntent, intentSha256 } from "../confirm.js";
import { admit, confirmedDust } from "../gate.js";
import { LIMITS } from "../limits.js";
import { ENTRIES, HOUR, PLACEHOLDER, iso, stateRoot } from "./helpers.js";

const NOW = Date.parse("2026-10-20T18:00:00Z");
const DEPLOY = deployIntent(LIMITS.payer, "0.01");
const runner = () => stateRoot({ now: () => NOW });
const refused = (r: ReturnType<typeof runner>, id: string, now = NOW) => {
  const verdict = admit(r.paths, id, now);
  if (verdict.ok) throw new Error(`admitted ${id}`);
  return verdict.reason;
};
afterEach(() => vi.unstubAllEnvs());

describe("admit: the approval gate", () => {
  it("admits deploy intent bf35fa0c under a 24-hour chat approval: one transaction under the 0.01 DUST cap", () => {
    const r = runner();
    const id = r.approve(DEPLOY);
    expect(id).toBe("bf35fa0c");
    expect(admit(r.paths, id, NOW)).toMatchObject({ ok: true, id, action: "deploy", intent: DEPLOY, transactions: 1, maxFee: 10n ** 13n, expiresAt: NOW - 60_000 + 24 * HOUR });
  });

  it("admits an after-deploy anchors intent whose template holds exactly its entries: one transaction per entry", () => {
    const r = runner();
    const intent = r.anchors();
    const id = r.approve(intent);
    expect(admit(r.paths, id, NOW)).toMatchObject({ ok: true, action: "anchors", intent, transactions: 2, maxFee: 10n ** 13n });
  });

  it("refuses an intent that is missing, unreadable or not the one its id names", () => {
    const r = runner();
    expect(refused(r, "bf35fa0c")).toBe(`no intent ${r.files.intent("bf35fa0c")}`);
    const id = r.approve(DEPLOY);
    writeFileSync(r.files.intent(id), "{ not json");
    expect(refused(r, id)).toBe(`${r.files.intent(id)} is not JSON`);
    writeFileSync(r.files.intent(id), JSON.stringify({ ...DEPLOY, maxFeeDust: "0.001" }));
    expect(refused(r, id)).toMatch(new RegExp(`^${r.files.intent(id)} hashes to [0-9a-f]{64}, which is not intent bf35fa0c$`));
    expect(refused(r, "BF35FA0C")).toBe('"BF35FA0C" is not an intent id: 8 lowercase hex characters');
  });

  it("refuses an intent with no approval", () => {
    const r = runner();
    const id = r.approve(DEPLOY, null);
    expect(refused(r, id)).toBe(`no approval ${r.files.approval(id)}`);
  });

  it("refuses an approval naming another intent's sha256", () => {
    const r = runner();
    const id = r.approve(DEPLOY, { intent_sha256: "bf35fa0c" + "0".repeat(56) });
    expect(refused(r, id)).toBe(`the approval names intent sha256 bf35fa0c${"0".repeat(56)}, but ${r.files.intent(id)} hashes to ${intentSha256(DEPLOY)}`);
  });

  it("refuses an approval that is not exactly deci's, in chat, for this intent", () => {
    const r = runner();
    const id = r.approve(DEPLOY, { approver: "codex" });
    expect(refused(r, id)).toBe('the approval is not deci\'s in chat: approver "codex", approved_via "chat"');
    r.approve(DEPLOY, { approved_via: "terminal" });
    expect(refused(r, id)).toBe('the approval is not deci\'s in chat: approver "deci", approved_via "terminal"');
    r.approve(DEPLOY, { intent_id: "34941c71" });
    expect(refused(r, id)).toBe('the approval names intent "34941c71", not bf35fa0c');
    r.approve(DEPLOY, { note: "also approve the rest" });
    expect(refused(r, id)).toBe('the approval has field "note"; it takes intent_id, intent_sha256, approved_at, expires_at, approved_via and approver');
    r.approve(DEPLOY, { expires_at: "tomorrow" });
    expect(refused(r, id)).toBe('the approval\'s expires_at "tomorrow" is not an ISO 8601 time with Z or a ±hh:mm offset');
    // Times Date.parse reads that are not ISO 8601 are refused too.
    r.approve(DEPLOY, { expires_at: "Tue, 20 Oct 2026 20:00:00 GMT" });
    expect(refused(r, id)).toBe('the approval\'s expires_at "Tue, 20 Oct 2026 20:00:00 GMT" is not an ISO 8601 time with Z or a ±hh:mm offset');
    r.approve(DEPLOY, { approved_at: "2026-10-20" });
    expect(refused(r, id)).toBe('the approval\'s approved_at "2026-10-20" is not an ISO 8601 time with Z or a ±hh:mm offset');
    r.approve(DEPLOY, { approved_at: NOW - HOUR });
    expect(refused(r, id)).toBe(`the approval's approved_at ${NOW - HOUR} is not an ISO 8601 time with Z or a ±hh:mm offset`);
    writeFileSync(r.files.approval(id), "[]");
    expect(refused(r, id)).toBe("the approval is not a JSON object");
  });

  it("refuses an approval once it expires, and one that is approved in the future or lasts longer than 24 hours", () => {
    const r = runner();
    const id = r.approve(DEPLOY, { approved_at: iso(NOW - 2 * HOUR), expires_at: iso(NOW) });
    expect(admit(r.paths, id, NOW - 1)).toMatchObject({ ok: true });
    expect(admit(r.paths, id, NOW)).toEqual({ ok: false, expired: true, reason: `the approval expired at ${iso(NOW)}`, intentSha256: intentSha256(DEPLOY), approvalSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    r.approve(DEPLOY, { approved_at: iso(NOW + 1), expires_at: iso(NOW + HOUR) });
    expect(refused(r, id)).toBe(`the approval was given at ${iso(NOW + 1)}, after now (${iso(NOW)})`);
    r.approve(DEPLOY, { approved_at: iso(NOW - HOUR), expires_at: iso(NOW + 23 * HOUR + 1) });
    expect(refused(r, id)).toBe(`the approval runs from ${iso(NOW - HOUR)} to ${iso(NOW + 23 * HOUR + 1)}, longer than 24 h`);
    r.approve(DEPLOY, { approved_at: iso(NOW - HOUR), expires_at: iso(NOW + 23 * HOUR) });
    expect(admit(r.paths, id, NOW)).toMatchObject({ ok: true });
    r.approve(DEPLOY, { approved_at: iso(NOW), expires_at: iso(NOW + HOUR) });
    expect(admit(r.paths, id, NOW)).toMatchObject({ ok: true });
  });

  it("refuses an approval already used", () => {
    const r = runner();
    const id = r.approve(DEPLOY);
    writeFileSync(r.files.used(id), JSON.stringify({ at: iso(NOW - HOUR), outcome: "done" }));
    expect(refused(r, id)).toBe("approval bf35fa0c was already used");
  });

  it("refuses an approval-scoped used marker while leaving a replacement eligible", () => {
    const r = runner();
    const id = r.approve(DEPLOY);
    const admitted = admit(r.paths, id, NOW);
    expect(admitted.ok).toBe(true);
    writeFileSync(`${r.files.used(id)}.${admitted.approvalSha256}`, "{}");
    expect(admit(r.paths, id, NOW)).toMatchObject({ ok: false, reason: expect.stringContaining("already used") });
    r.approve(DEPLOY, { expires_at: iso(NOW + HOUR) });
    expect(admit(r.paths, id, NOW)).toMatchObject({ ok: true });
  });

  it("keeps a used approval used when its file is rewritten with other whitespace, key order or offset", () => {
    const r = runner();
    const id = r.approve(DEPLOY);
    writeFileSync(r.files.used(id, r.approvalSha256(id)), "{}");
    const approval = JSON.parse(readFileSync(r.files.approval(id), "utf8"));
    expect([approval.approved_at, approval.expires_at]).toEqual(["2026-10-20T17:59:00.000Z", "2026-10-21T17:59:00.000Z"]);
    for (const rewritten of [
      `${JSON.stringify(approval, null, 4)}\n`,
      JSON.stringify(Object.fromEntries(Object.entries(approval).reverse())),
      JSON.stringify({ ...approval, approved_at: "2026-10-20T11:59:00-06:00", expires_at: "2026-10-21T17:59:00Z" }),
    ]) {
      writeFileSync(r.files.approval(id), rewritten);
      expect([rewritten, admit(r.paths, id, NOW)]).toMatchObject([rewritten, { ok: false, reason: `approval ${id} was already used` }]);
    }
    // Any other time makes it another approval.
    for (const change of [{ expires_at: iso(NOW + HOUR) }, { approved_at: iso(NOW - 30_000) }]) {
      writeFileSync(r.files.approval(id), JSON.stringify({ ...approval, ...change }));
      expect([change, admit(r.paths, id, NOW)]).toMatchObject([change, { ok: true }]);
    }
  });

  // Date.parse reads a time without an offset in the process's zone (America/Denver on Gemtek),
  // which would move both the 24-hour window and the approval's identity with TZ.
  it.each(["America/Denver", "UTC"])("refuses approval times that name no offset under TZ=%s, at every instant", (tz) => {
    vi.stubEnv("TZ", tz);
    const r = runner();
    const start = Date.parse("2026-10-20T17:59:00Z");
    const verdicts = (change: Record<string, string>) => {
      const id = r.approve(DEPLOY, change);
      // Just after approval, and two and seven hours after the expiry the writer meant.
      return [start + 60_000, start + 26 * HOUR, start + 31 * HOUR].map((at) => {
        const verdict = admit(r.paths, id, at);
        return verdict.ok ? "admitted" : verdict.reason;
      });
    };
    for (const [change, field] of [
      [{ approved_at: "2026-10-20T17:59:00", expires_at: "2026-10-21T17:59:00" }, "approved_at"],
      [{ approved_at: "2026-10-20T17:59:00.123456" }, "approved_at"],
      [{ expires_at: "2026-10-21T17:59:00" }, "expires_at"],
      [{ expires_at: "2026-10-21T17:59" }, "expires_at"],
      [{ expires_at: "2026-10-21T17:59:00+0000" }, "expires_at"],
      [{ expires_at: "2026-10-21T17:59:00+00" }, "expires_at"],
      [{ expires_at: "2026-10-21 17:59:00Z" }, "expires_at"],
      [{ expires_at: "2026-10-21T17:59:00z" }, "expires_at"],
    ] as [Record<string, string>, "approved_at" | "expires_at"][]) {
      const reason = `the approval's ${field} ${JSON.stringify(change[field])} is not an ISO 8601 time with Z or a ±hh:mm offset`;
      expect([change, verdicts(change)]).toEqual([change, [reason, reason, reason]]);
    }
    expect(verdicts({})).toEqual(["admitted", "the approval expired at 2026-10-21T17:59:00.000Z", "the approval expired at 2026-10-21T17:59:00.000Z"]);
  });

  it("reads approval times with Z or an offset as the same instants in every zone, so a used approval stays used when TZ changes", () => {
    const r = runner();
    const id = r.approve(DEPLOY, { approved_at: "2026-10-20T11:59:00.5-06:00", expires_at: "2026-10-21T17:59:00Z" });
    const zones = ["America/Denver", "UTC", "Asia/Kolkata"];
    const admitted = zones.map((tz) => {
      vi.stubEnv("TZ", tz);
      return admit(r.paths, id, NOW);
    });
    for (const verdict of admitted) expect(verdict).toMatchObject({ ok: true, expiresAt: Date.parse("2026-10-21T17:59:00Z"), approvalSha256: admitted[0]!.approvalSha256 });
    writeFileSync(r.files.used(id, admitted[0]!.approvalSha256), "{}");
    for (const tz of zones) {
      vi.stubEnv("TZ", tz);
      expect([tz, admit(r.paths, id, NOW)]).toMatchObject([tz, { ok: false, reason: `approval ${id} was already used` }]);
    }
  });

  it("refuses a legacy NO whose approval identity cannot be recovered", () => {
    const r = runner();
    const id = r.approve(DEPLOY);
    appendFileSync(r.files.audit, `${JSON.stringify({ at: iso(NOW), intent: id, event: "no", problems: ["payer mismatch"] })}\n`);
    expect(admit(r.paths, id, NOW)).toMatchObject({ ok: false, reason: expect.stringContaining("already used") });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["another action", { ...DEPLOY, action: "deploy a mutable registry on Midnight MAINNET" }, 'action "deploy a mutable registry on Midnight MAINNET" is not allowlisted'],
    ["another network", { ...DEPLOY, network: "preprod" }, 'the deploy\'s network is "preprod", not the allowlisted one'],
    ["another authority", { ...DEPLOY, authority: "committee [] (0 members), threshold 0, counter 0" }, 'the deploy\'s authority is "committee [] (0 members), threshold 0, counter 0", not the allowlisted one'],
    ["another verifier key", { ...DEPLOY, verifierKeys: { ...DEPLOY.verifierKeys, anchor: "ee".repeat(32) } }, "the deploy's verifierKeys is"],
    ["another payer", { ...DEPLOY, payer: "mn_addr1other" }, 'the deploy\'s payer is "mn_addr1other", not the allowlisted one'],
    ["a field the deploy intent does not have", { ...DEPLOY, registry: "ab".repeat(32) }, "the deploy intent has fields action, network, authority, verifierKeys, payer, maxFeeDust, registry; it takes action, network, authority, verifierKeys, payer, maxFeeDust"],
    ["a missing field", { action: DEPLOY.action, network: DEPLOY.network }, "the deploy intent has fields action, network; it takes action, network, authority, verifierKeys, payer, maxFeeDust"],
  ])("refuses a deploy intent with %s", (_, intent, reason) => {
    const r = runner();
    expect(refused(r, r.approve(intent))).toContain(reason);
  });

  it("refuses an anchors intent whose entries, plan, registry or author keys are not the allowlisted ones", () => {
    const r = runner();
    expect(refused(r, r.approve(r.anchors({ authorKeys: ["77".repeat(32)] })))).toBe(`the anchors' authorKeys is ["${"77".repeat(32)}"], not the allowlisted one`);
    expect(refused(r, r.approve(r.anchors({ entries: [ENTRIES[0]] as never })))).toBe(`the intent's entries are not exactly those of ${r.template}`);
    expect(refused(r, r.approve(r.anchors({ planSha256: "00".repeat(32) })))).toBe(`${r.template} hashes to ${r.anchors().planSha256}, not the intent's planSha256 ${"00".repeat(32)}`);
    expect(refused(r, r.approve(r.anchors({ plan: `${r.template}.missing` })))).toBe(`no plan ${r.template}.missing`);
    expect(refused(r, r.approve(r.anchors({ registry: afterDeployRegistry("/elsewhere/deploy.sqlite", r.paths.planOut) })))).toBe(
      `the anchors' registry "${afterDeployRegistry("/elsewhere/deploy.sqlite", r.paths.planOut)}" is neither 64 hex characters nor the registry ${r.paths.deployJournal} records as landed`,
    );
    expect(refused(r, r.approve(r.anchors({ registry: "ab".repeat(32) })))).toBe(`the anchors' registry ${"ab".repeat(32)} is not the registry ${r.template} names, ${PLACEHOLDER}`);
    expect(refused(r, r.approve(r.anchors({ payer: "mn_addr1other" })))).toBe('the anchors\' payer is "mn_addr1other", not the allowlisted one');
  });

  it("refuses an anchors intent of more entries than one approval may write", () => {
    const r = runner();
    const entries = Array.from({ length: 9 }, (_, i) => ({ ...ENTRIES[0]!, label: `entry-${i}`, rootHash: i.toString(16).padStart(64, "0") }));
    writeFileSync(r.template, JSON.stringify({ registry: PLACEHOLDER, entries }));
    expect(refused(r, r.approve(r.anchors()))).toBe("the intent writes 9 anchors, more than the 8 one approval may write");
    writeFileSync(r.template, JSON.stringify({ registry: PLACEHOLDER, entries: entries.slice(0, 8) }));
    expect(admit(r.paths, r.approve(r.anchors()), NOW)).toMatchObject({ ok: true, transactions: 8 });
  });

  it("refuses a fee cap over the per-transaction cap, or one that is not a DUST amount", () => {
    const r = runner();
    expect(refused(r, r.approve(deployIntent(LIMITS.payer, "0.010000000000001")))).toBe("the fee cap 0.010000000000001 DUST is over the per-transaction cap 0.01 DUST");
    expect(refused(r, r.approve(deployIntent(LIMITS.payer, "1e-3")))).toBe('the fee cap "1e-3" is not a DUST amount');
    expect(refused(r, r.approve({ ...DEPLOY, maxFeeDust: 0.01 }))).toBe("the fee cap 0.01 is not a DUST amount");
    expect(refused(r, r.approve(r.anchors({ maxFeeDustPerAnchor: "0.02" })))).toBe("the fee cap 0.02 DUST is over the per-transaction cap 0.01 DUST");
    expect(admit(r.paths, r.approve(deployIntent(LIMITS.payer, "0.009")), NOW)).toMatchObject({ ok: true, maxFee: 9n * 10n ** 12n });
  });

  it("refuses an intent whose maximum, with what other intents confirmed in the last 24 hours, is over the daily cap", () => {
    const r = runner();
    const id = r.approve(DEPLOY);
    r.confirmed("34941c71", "a1".repeat(32), "0.05");
    r.confirmed("34941c71", "a2".repeat(32), "0.04");
    expect(admit(r.paths, id, NOW)).toMatchObject({ ok: true });
    r.confirmed("34941c71", "a3".repeat(32), "0.000000000000001");
    expect(refused(r, id)).toBe("0.090000000000001 DUST reserved by other intents for the rolling 24 h window and this intent's maximum 0.01 DUST come to more than the 0.1 DUST daily cap");
  });

  it("counts toward the daily cap each other intent's transaction once, and only within the last 24 hours", () => {
    const r = runner();
    const id = r.approve(DEPLOY);
    r.confirmed("34941c71", "a1".repeat(32), "0.05");
    r.confirmed("34941c71", "a1".repeat(32), "0.05");
    r.confirmed("bf35fa0c", "a2".repeat(32), "0.05");
    r.confirmed("34941c71", "a3".repeat(32), "0.05", NOW - 24 * HOUR);
    r.confirmed("34941c71", "a4".repeat(32), "0.04", NOW - 24 * HOUR + 1);
    // Only confirmations count: a NO and a run's other events carry no fee.
    appendFileSync(r.files.audit, `${JSON.stringify({ at: iso(NOW - HOUR), intent: "34941c71", event: "no", item: "deploy", tx_hash: "a5".repeat(32), problems: ["payer"] })}\n`);
    appendFileSync(r.files.audit, `${JSON.stringify({ at: iso(NOW - HOUR), intent: "34941c71", event: "run-start", attempt: 1 })}\n`);
    expect(confirmedDust(r.paths.root, NOW - 24 * HOUR, id)).toBe(9n * 10n ** 13n);
    expect(admit(r.paths, id, NOW)).toMatchObject({ ok: true });
    expect(confirmedDust(r.paths.root, NOW - 24 * HOUR - 1)).toBe(19n * 10n ** 13n);
  });

  it("refuses when a confirmation's time names no offset, rather than read it in the runner's zone", () => {
    for (const times of [
      { at: "2026-10-20T17:00:00" },
      { at: "2026-10-20T17:00:00", valid_until: iso(NOW - HOUR) },
      { at: iso(NOW - HOUR), valid_until: "2026-10-20T17:10:00" },
    ]) {
      const r = runner();
      const id = r.approve(DEPLOY);
      appendFileSync(r.files.audit, `${JSON.stringify({ intent: "34941c71", event: "confirm", item: "deploy", tx_hash: "a1".repeat(32), fee_dust: "0.01", ...times })}\n`);
      expect([times, refused(r, id)]).toEqual([times, "the confirmation audit holds an invalid time or fee"]);
    }
  });

  it("counts repeated confirmations of the same transaction once, retaining the largest fee", () => {
    const r = runner();
    r.confirmed("first", "a1".repeat(32), "0.01");
    r.confirmed("second", "a1".repeat(32), "0.02");
    r.confirmed("third", "a1".repeat(32), "0.01");
    expect(confirmedDust(r.paths.root, NOW - 24 * HOUR)).toBe(2n * 10n ** 13n);
  });

  it("retains a first and repeated zero-fee confirmation as zero rather than undefined", () => {
    const r = runner();
    r.confirmed("first", "a1".repeat(32), "0");
    r.confirmed("second", "a1".repeat(32), "0");
    expect(confirmedDust(r.paths.root, NOW - 24 * HOUR)).toBe(0n);
  });

  it("cannot keep a historical provider-injected deadline reserved indefinitely", () => {
    const r = runner();
    r.approve(DEPLOY);
    appendFileSync(r.files.audit, `${JSON.stringify({ at: iso(NOW), intent: "other", event: "confirm", item: "deploy", tx_hash: "a1".repeat(32), fee_dust: "0.01", valid_until: "9999-12-31T23:59:59Z" })}\n`);
    expect(confirmedDust(r.paths.root, NOW - 24 * HOUR)).toBe(10n ** 13n);
    expect(confirmedDust(r.paths.root, NOW + HOUR + 1)).toBe(0n);
  });

  it("refuses when the audit log does not read back, rather than undercount what was confirmed", () => {
    const r = runner();
    const id = r.approve(DEPLOY);
    appendFileSync(r.files.audit, '{"at":"2026-10-20T17:00:00.000Z","intent":"34941c71","event":"confirm"');
    expect(refused(r, id)).toBe(`${r.files.audit} line 1 is not JSON`);
  });
});
