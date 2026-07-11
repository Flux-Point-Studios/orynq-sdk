/**
 * @summary Round-4 hardening for eip712 governance attestations (#58/#77).
 *
 * For the eip712 scheme the signature is over the typed EIP-712 message, not the
 * sr25519/ed25519 preimage — so `signedAt` was neither required in the pinned
 * type nor cross-checked, leaving the attestation timestamp unbound (a signed
 * sign-off could replay/backdate freely). This suite pins:
 *  - the verifier factory REJECTS a pinned type that omits `signedAt`,
 *  - a signed message whose `signedAt` != event.signedAt is rejected,
 *  - a stale attestation (outside the freshness window) is rejected,
 *  - a fresh, fully-bound attestation verifies.
 */

import { describe, it, expect } from "vitest";
import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
  verifyGovernanceAttestations,
  createEip712GovernanceVerifier,
} from "../index.js";
import type { TraceRun, TraceBundle } from "../index.js";

const EIP712_ATTESTOR = "0x1111111111111111111111111111111111111111";
const EIP712_DOMAIN = { name: "Orynq", version: "1" };
const EIP712_TYPES = {
  Attestation: [
    { name: "role", type: "string" },
    { name: "policyRef", type: "string" },
    { name: "decisionRef", type: "string" },
    { name: "runId", type: "string" },
    { name: "signedAt", type: "string" },
  ],
};

async function buildEip712Bundle(opts: {
  eventSignedAt: string;
  messageSignedAt: string;
}): Promise<TraceBundle> {
  const run: TraceRun = await createTrace({ agentId: "agent-g4" });
  const span = addSpan(run, { name: "approve", visibility: "public" });
  await addEvent(run, span.id, {
    kind: "governance-attestation",
    visibility: "public",
    role: "release-authority",
    policyRef: "sha256:policy",
    decisionRef: "decision-1",
    attestor: { address: EIP712_ATTESTOR, signatureScheme: "eip712" },
    signature: "0x" + "ab".repeat(65),
    signedAt: opts.eventSignedAt,
    eip712: {
      domain: EIP712_DOMAIN,
      types: EIP712_TYPES,
      primaryType: "Attestation",
      message: {
        role: "release-authority",
        policyRef: "sha256:policy",
        decisionRef: "decision-1",
        runId: run.id,
        signedAt: opts.messageSignedAt,
      },
    },
  });
  await closeSpan(run, span.id);
  return finalizeTrace(run);
}

describe("eip712 signedAt binding (#77 round-4)", () => {
  it("the factory rejects a pinned type that omits signedAt", () => {
    expect(() =>
      createEip712GovernanceVerifier({
        verifyTypedData: async () => true,
        expectedDomain: EIP712_DOMAIN,
        expectedPrimaryType: "Attestation",
        expectedTypes: {
          Attestation: [
            { name: "role", type: "string" },
            { name: "policyRef", type: "string" },
            { name: "decisionRef", type: "string" },
            { name: "runId", type: "string" },
            // signedAt intentionally omitted
          ],
        },
      })
    ).toThrow(/signedAt/);
  });

  it("rejects an attestation whose signed message.signedAt != event.signedAt", async () => {
    const now = "2026-07-11T00:00:00.000Z";
    const bundle = await buildEip712Bundle({
      eventSignedAt: now,
      messageSignedAt: "2020-01-01T00:00:00.000Z", // backdated in the recorded event
    });
    const verifier = createEip712GovernanceVerifier({
      verifyTypedData: async () => true, // signature accepted; binding must still reject
      expectedDomain: EIP712_DOMAIN,
      expectedPrimaryType: "Attestation",
      expectedTypes: EIP712_TYPES,
      nowMs: Date.parse(now),
    });
    const summaries = await verifyGovernanceAttestations(bundle, {
      verifiers: { eip712: verifier },
      authorizedAttestors: [EIP712_ATTESTOR],
    });
    expect(summaries[0]!.authorized).toBe(true);
    expect(summaries[0]!.verified).toBe(false);
  });

  it("rejects a stale attestation outside the freshness window", async () => {
    const stale = "2020-01-01T00:00:00.000Z";
    const bundle = await buildEip712Bundle({
      eventSignedAt: stale,
      messageSignedAt: stale, // consistent, but far in the past
    });
    const verifier = createEip712GovernanceVerifier({
      verifyTypedData: async () => true,
      expectedDomain: EIP712_DOMAIN,
      expectedPrimaryType: "Attestation",
      expectedTypes: EIP712_TYPES,
      nowMs: Date.parse("2026-07-11T00:00:00.000Z"),
      freshnessToleranceMs: 5 * 60_000, // 5 minutes
    });
    const summaries = await verifyGovernanceAttestations(bundle, {
      verifiers: { eip712: verifier },
      authorizedAttestors: [EIP712_ATTESTOR],
    });
    expect(summaries[0]!.verified).toBe(false);
  });

  it("verifies a fresh, fully-bound attestation", async () => {
    const now = "2026-07-11T00:00:00.000Z";
    const bundle = await buildEip712Bundle({ eventSignedAt: now, messageSignedAt: now });
    const verifier = createEip712GovernanceVerifier({
      verifyTypedData: async () => true,
      expectedDomain: EIP712_DOMAIN,
      expectedPrimaryType: "Attestation",
      expectedTypes: EIP712_TYPES,
      nowMs: Date.parse(now),
      freshnessToleranceMs: 5 * 60_000,
    });
    const summaries = await verifyGovernanceAttestations(bundle, {
      verifiers: { eip712: verifier },
      authorizedAttestors: [EIP712_ATTESTOR],
    });
    expect(summaries[0]!.verified).toBe(true);
  });
});
