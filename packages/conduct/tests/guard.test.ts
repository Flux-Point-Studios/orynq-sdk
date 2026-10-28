import {
  buildAllowlistRoot,
  mandateCommitmentHex,
  ZERO_ROOT_32,
  type MandateV1,
} from "../src/index.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GuardAction, GuardEvent } from "../src/index.js";
import { GuardConfigError, MandateGuard, MemoryGuardLog } from "../src/index.js";
import { record } from "./fixtures/record.js";

interface JsonAction {
  kind: "payment" | "egress";
  asset?: string;
  amount?: string;
  counterparty?: string;
  destination?: string;
  timestamp: string;
}

interface JsonCase {
  name: string;
  capAmount?: string;
  sequence: { action: JsonAction; expect: string }[];
}

interface Vectors {
  mandateParams: {
    asset: string;
    capAmount: string;
    windowSeconds: string;
    notBefore: string;
    notAfter: string;
    committeeId: string;
    threshold: string;
    committeeSize: string;
  };
  counterpartyAllowlist: string[];
  egressAllowlist: string[];
  cases: JsonCase[];
  denyAllEgressCases: JsonCase[];
}

const vectors: Vectors = JSON.parse(
  readFileSync(new URL("./fixtures/guard-vectors.json", import.meta.url), "utf8"),
);

function fixtureMandate(egressMode: 0n | 1n): MandateV1 {
  const p = vectors.mandateParams;
  return {
    schemaVersion: 1n,
    mandateId: new Uint8Array(16).fill(0x51),
    principalDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    agentDid: "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG",
    didFormatVersion: 0n,
    spendCap: {
      asset: p.asset,
      amount: BigInt(p.capAmount),
      windowSeconds: BigInt(p.windowSeconds),
    },
    counterpartyAllowlistRoot: buildAllowlistRoot(vectors.counterpartyAllowlist),
    egressPolicy:
      egressMode === 1n
        ? { mode: 1n, allowlistRoot: buildAllowlistRoot(vectors.egressAllowlist) }
        : { mode: 0n, allowlistRoot: new Uint8Array(ZERO_ROOT_32) },
    approvedMeasurementSetRoot: new Uint8Array(32).fill(0x44),
    validityWindow: { notBefore: BigInt(p.notBefore), notAfter: BigInt(p.notAfter) },
    disclosurePolicy: {
      committeeId: p.committeeId,
      threshold: BigInt(p.threshold),
      committeeSize: BigInt(p.committeeSize),
    },
  };
}

function toAction(j: JsonAction): GuardAction {
  if (j.kind === "payment") {
    return {
      kind: "payment",
      asset: j.asset as string,
      amount: BigInt(j.amount as string),
      counterparty: j.counterparty as string,
      timestamp: BigInt(j.timestamp),
    };
  }
  return {
    kind: "egress",
    destination: j.destination as string,
    timestamp: BigInt(j.timestamp),
  };
}

function runCase(c: JsonCase, egressMode: 0n | 1n, events: GuardEvent[] = []): void {
  let now = 0n;
  const mandate = fixtureMandate(egressMode);
  const guard = new MandateGuard({
    now: () => now,
    mandate: { ...mandate, spendCap: { ...mandate.spendCap, amount: BigInt(c.capAmount ?? vectors.mandateParams.capAmount) } },
    counterpartyAllowlist: vectors.counterpartyAllowlist,
    ...(egressMode === 1n ? { egressAllowlist: vectors.egressAllowlist } : {}),
    history: "fresh",
    onEvent: record(events),
  });
  for (const [i, step] of c.sequence.entries()) {
    now = BigInt(step.action.timestamp);
    const evaluated = guard.evaluate(toAction(step.action));
    expect(evaluated.allowed ? "ALLOW" : evaluated.reason).toBe(step.expect);
    const decision = guard.enforce(toAction(step.action));
    const got = decision.allowed ? "ALLOW" : decision.reason;
    expect(got, `step ${i}: ${step.action.kind} @ ${step.action.timestamp}`).toBe(
      step.expect,
    );
  }
}

describe("guard verdict fixtures", () => {
  for (const c of vectors.cases) {
    it(c.name, () => runCase(c, 1n));
  }
  for (const c of vectors.denyAllEgressCases) {
    it(c.name, () => runCase(c, 0n));
  }
});

describe("guard trace events", () => {
  it("emits one event per enforcement, allowed and denied, in seq order", () => {
    const events: GuardEvent[] = [];
    const c = vectors.cases.find((x) => x.name.startsWith("denied attempt"));
    runCase(c as JsonCase, 1n, events);
    expect(events.map((e) => e.type)).toEqual([
      "orynq.conduct.guard.action.v1",
      "orynq.conduct.guard.denial.v1",
      "orynq.conduct.guard.action.v1",
    ]);
    expect(events.map((e) => e.seq)).toEqual([0n, 1n, 2n]);
    const denial = events[1];
    expect(denial?.type).toBe("orynq.conduct.guard.denial.v1");
    if (denial?.type === "orynq.conduct.guard.denial.v1") {
      expect(denial.reason).toBe("SPEND_CAP_EXCEEDED");
      expect(denial.actionKind).toBe("payment");
    }
    for (const e of events) {
      expect(e.actionDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(e.mandateCommitment).toBe(mandateCommitmentHex(fixtureMandate(1n)));
    }
  });

  it("distinct actions carry distinct digests; identical actions carry identical digests", () => {
    const events: GuardEvent[] = [];
    const guard = new MandateGuard({
    now: () => 1_500_000n,
      mandate: fixtureMandate(1n),
      counterpartyAllowlist: vectors.counterpartyAllowlist,
      egressAllowlist: vectors.egressAllowlist,
      history: "fresh",
      onEvent: record(events),
    });
    const pay: GuardAction = {
      kind: "payment",
      asset: "lovelace",
      amount: 1n,
      counterparty: "addr_test1_alpha_supplier",
      timestamp: 1_500_000n,
    };
    guard.enforce(pay);
    guard.enforce({ ...pay });
    guard.enforce({ ...pay, amount: 2n });
    expect(events[0]?.actionDigest).toBe(events[1]?.actionDigest);
    expect(events[0]?.actionDigest).not.toBe(events[2]?.actionDigest);
  });
});

describe("guard construction binds allowlists to the mandate roots", () => {
  it("rejects a counterparty list that does not hash to the committed root", () => {
    expect(
      () =>
        new MandateGuard({
    now: () => 1_500_000n,
          mandate: fixtureMandate(1n),
          counterpartyAllowlist: [...vectors.counterpartyAllowlist, "addr_test1_extra"],
          egressAllowlist: vectors.egressAllowlist,
          history: "fresh",
        }),
    ).toThrowError(GuardConfigError);
  });

  it("rejects a tampered egress list", () => {
    expect(
      () =>
        new MandateGuard({
    now: () => 1_500_000n,
          mandate: fixtureMandate(1n),
          counterpartyAllowlist: vectors.counterpartyAllowlist,
          egressAllowlist: ["exfil.example.org"],
          history: "fresh",
        }),
    ).toThrowError(GuardConfigError);
  });

  it("requires an egress list in allowlist mode and forbids one in deny-all mode", () => {
    expect(
      () =>
        new MandateGuard({
    now: () => 1_500_000n,
          mandate: fixtureMandate(1n),
          counterpartyAllowlist: vectors.counterpartyAllowlist,
          history: "fresh",
        }),
    ).toThrowError(GuardConfigError);
    expect(
      () =>
        new MandateGuard({
    now: () => 1_500_000n,
          mandate: fixtureMandate(0n),
          counterpartyAllowlist: vectors.counterpartyAllowlist,
          egressAllowlist: vectors.egressAllowlist,
          history: "fresh",
        }),
    ).toThrowError(GuardConfigError);
  });

  it("evaluate() is pure: it never accrues spend", () => {
    const log = new MemoryGuardLog();
    const guard = new MandateGuard({
    now: () => 1_500_000n,
      mandate: fixtureMandate(1n),
      counterpartyAllowlist: vectors.counterpartyAllowlist,
      egressAllowlist: vectors.egressAllowlist,
      history: "fresh",
      onEvent: (e, previous) => log.append(e, previous),
    });
    const pay: GuardAction = {
      kind: "payment",
      asset: "lovelace",
      amount: 10_000_000n,
      counterparty: "addr_test1_alpha_supplier",
      timestamp: 1_500_000n,
    };
    expect(guard.evaluate(pay).allowed).toBe(true);
    expect(guard.evaluate(pay).allowed).toBe(true);
    expect(guard.spentInWindow(1_500_000n)).toBe(0n);
    expect(guard.enforce(pay).allowed).toBe(true);
    expect(guard.spentInWindow(1_500_000n)).toBe(10_000_000n);
    expect(guard.evaluate({ ...pay, amount: 1n }).allowed).toBe(false);
  });
});

describe("denial rule texts", () => {
  it("each denial reason carries its fixed rule text", () => {
    const allowlist = new MandateGuard({
      mandate: fixtureMandate(1n), counterpartyAllowlist: vectors.counterpartyAllowlist, egressAllowlist: vectors.egressAllowlist, history: "fresh",
    });
    const denyAll = new MandateGuard({ mandate: fixtureMandate(0n), counterpartyAllowlist: vectors.counterpartyAllowlist, history: "fresh" });
    const pay: GuardAction = { kind: "payment", asset: "lovelace", amount: 1n, counterparty: "addr_test1_alpha_supplier", timestamp: 1_500_000n };
    const decisions = [
      allowlist.evaluate({ ...pay, timestamp: 999_999n }),
      allowlist.evaluate({ ...pay, timestamp: 2_000_000n }),
      allowlist.evaluate({ ...pay, asset: "tdust" }),
      allowlist.evaluate({ ...pay, counterparty: "addr_test1_mallory" }),
      allowlist.evaluate({ ...pay, amount: 10_000_001n }),
      denyAll.evaluate({ kind: "egress", destination: "api.example.com", timestamp: 1_500_000n }),
      allowlist.evaluate({ kind: "egress", destination: "exfil.example.org", timestamp: 1_500_000n }),
    ];
    expect(Object.fromEntries(decisions.map(d => (d.allowed ? ["ALLOW", ""] : [d.reason, d.rule])))).toEqual({
      MANDATE_NOT_YET_VALID: "timestamp precedes mandate validity",
      MANDATE_EXPIRED: "timestamp reaches or exceeds mandate expiry",
      ASSET_MISMATCH: "asset is not the mandated asset",
      COUNTERPARTY_NOT_ALLOWED: "counterparty is not in the mandate allowlist",
      SPEND_CAP_EXCEEDED: "payment exceeds the remaining window spend cap",
      EGRESS_DENIED: "mandate egress policy is deny-all",
      EGRESS_NOT_ALLOWED: "destination is not in the egress allowlist",
    });
  });
});
