import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { computeEventHash } from "@fluxpointstudios/orynq-sdk-process-trace";
import { ACTION_DIGEST_DOMAIN, actionDigestHex, buildAllowlistRoot, MandateGuard, mandateCommitmentHex, toProcessTraceEvent, type GuardAction, type GuardEvent, type MandateV1 } from "../src/index.js";
import { record } from "./fixtures/record.js";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/action-vectors.json", import.meta.url), "utf8"));
for (const v of vectors.cases) {
  it(`F5 action digest known answer: ${v.name}`, () => {
    const a = { ...v.action, timestamp: BigInt(v.action.timestamp), ...(v.action.kind === "payment" ? { amount: BigInt(v.action.amount) } : {}) } as GuardAction;
    expect(ACTION_DIGEST_DOMAIN).toBe("orynq:conduct:guard:action:v1|");
    expect(createHash("sha256").update("orynq:conduct:guard:action:v1|").update(Buffer.from(v.cborHex, "hex")).digest("hex")).toBe(v.digestHex);
    expect(actionDigestHex(a)).toBe(v.digestHex);
  });
}
it("F5 trace data binds the exact action digest and mandate commitment for allow and deny", async () => {
  const events: GuardEvent[] = [];
  const mandate: MandateV1 = {
    schemaVersion: 1n, mandateId: new Uint8Array(16), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321", didFormatVersion: 0n,
    spendCap: { asset: "lovelace", amount: 10n, windowSeconds: 3600n },
    counterpartyAllowlistRoot: buildAllowlistRoot(["supplier"]), egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) },
    approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: 0n, notAfter: 100_000n },
    disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n },
  };
  const guard = new MandateGuard({ mandate, counterpartyAllowlist: ["supplier"], now: () => 7200n, history: "fresh", onEvent: record(events) });
  const action = { ...vectors.cases[0].action, amount: 6n, timestamp: 7200n } as GuardAction;
  expect(guard.enforce(action).allowed).toBe(true);
  expect(guard.enforce(action).allowed).toBe(false);
  for (const e of events) {
    const trace = toProcessTraceEvent(e, { id: "event", seq: Number(e.seq), timestamp: "2026-10-27T00:00:00.000Z", visibility: "private" });
    expect(trace.data.actionDigest).toBe(vectors.cases[0].digestHex);
    expect(trace.data.mandateCommitment).toBe(mandateCommitmentHex(mandate));
    expect(trace.data.enforcedAt).toBe("7200");
    expect(trace.data.action).toEqual(vectors.cases[0].action);
    await expect(computeEventHash(trace)).resolves.toMatch(/^[0-9a-f]{64}$/);
  }
});
