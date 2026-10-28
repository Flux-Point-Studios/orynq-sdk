import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildAllowlistRoot, compileMandatePredicate, MandateGuard, MemoryGuardLog, PREDICATE_LAYOUT,
  type GuardAction, type MandateV1,
} from "../src/index.js";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/predicate-vectors.json", import.meta.url), "utf8")) as {
  cases: { name: string; egressMode: string; steps: { action: Record<string, string>; priorSpent: string; args: (string | boolean)[]; verdict: string }[] }[];
};
const guardVectors = JSON.parse(readFileSync(new URL("./fixtures/guard-vectors.json", import.meta.url), "utf8")) as {
  mandateParams: Record<string, string>;
  counterpartyAllowlist: string[];
  egressAllowlist: string[];
};

describe("predicate ABI golden sequences", () => {
  for (const vector of vectors.cases) {
    it(vector.name, () => {
      const p = guardVectors.mandateParams;
      const mode = BigInt(vector.egressMode);
      const mandate: MandateV1 = {
        schemaVersion: 1n, mandateId: new Uint8Array(16), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321", didFormatVersion: 0n,
        spendCap: { asset: p.asset!, amount: BigInt(p.capAmount!), windowSeconds: BigInt(p.windowSeconds!) },
        counterpartyAllowlistRoot: buildAllowlistRoot(guardVectors.counterpartyAllowlist),
        egressPolicy: { mode, allowlistRoot: mode === 1n ? buildAllowlistRoot(guardVectors.egressAllowlist) : new Uint8Array(32) },
        approvedMeasurementSetRoot: new Uint8Array(32),
        validityWindow: { notBefore: BigInt(p.notBefore!), notAfter: BigInt(p.notAfter!) },
        disclosurePolicy: { committeeId: p.committeeId!, threshold: BigInt(p.threshold!), committeeSize: BigInt(p.committeeSize!) },
      };
      const lists = { counterpartyAllowlist: guardVectors.counterpartyAllowlist, ...(mode === 1n ? { egressAllowlist: guardVectors.egressAllowlist } : {}) };
      const compiled = compileMandatePredicate(mandate, lists);
      let now = 0n;
      const log = new MemoryGuardLog();
      const guard = new MandateGuard({ mandate, ...lists, now: () => now, history: "fresh", onEvent: (e, previous) => log.append(e, previous) });
      for (const step of vector.steps) {
        const a = step.action;
        const action: GuardAction = a.kind === "payment"
          ? { kind: "payment", asset: a.asset!, amount: BigInt(a.amount!), counterparty: a.counterparty!, timestamp: BigInt(a.timestamp!) }
          : { kind: "egress", destination: a.destination!, timestamp: BigInt(a.timestamp!) };
        const prior = guard.spentInWindow(action.timestamp);
        expect(prior.toString()).toBe(step.priorSpent);
        const args = compiled.buildArgs(action, prior);
        expect(args).toHaveLength(PREDICATE_LAYOUT.length);
        expect(args.map((arg) => typeof arg === "bigint" ? arg.toString() : arg)).toEqual(step.args);
        now = action.timestamp;
        const decision = guard.enforce(action);
        expect(decision.allowed ? "ALLOW" : decision.reason).toBe(step.verdict);
      }
    });
  }
});
