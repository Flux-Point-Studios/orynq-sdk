/**
 * @summary Round-3 hardening regression tests for process-trace governance (#58).
 *
 *  1. eip712 schema pins are MANDATORY. An attacker signs an EMPTY `Attestation`
 *     struct (`types:{Attestation:[]}`) with their own key and carries
 *     role/policyRef/decisionRef/runId as UNTYPED message extras — viem verifies
 *     the empty struct and the field-binding post-check reads never-signed
 *     fields. The verifier must reject unless the primaryType's declared type
 *     fields actually include role/policyRef/decisionRef/runId.
 *  2. Governance attestations require an authorized-attestor allow-list. An
 *     attestation from an unlisted signer must NOT count toward a passing
 *     verdict, and with no allow-list governance verification must fail closed.
 */

import { describe, it, expect } from "vitest";
import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
  verifyBundle,
  addGovernanceAttestation,
  createSr25519GovernanceSigner,
  verifyGovernanceAttestations,
  createEip712GovernanceVerifier,
} from "../index.js";
import type { TraceBundle, GovernanceAttestationEvent } from "../index.js";

const SEED_A = "0x" + "11".repeat(32);
const SEED_B = "0x" + "22".repeat(32);

const EXPECTED_DOMAIN = { name: "Orynq", version: "1" };
const EXPECTED_TYPES = {
  Attestation: [
    { name: "role", type: "string" },
    { name: "policyRef", type: "string" },
    { name: "decisionRef", type: "string" },
    { name: "runId", type: "string" },
  ],
};

async function eip712Bundle(binding: Record<string, unknown>): Promise<TraceBundle> {
  const run = await createTrace({ agentId: "agent-1" });
  const span = addSpan(run, { name: "approve", visibility: "public" });
  await addEvent(run, span.id, {
    kind: "governance-attestation",
    visibility: "public",
    role: "release-authority",
    policyRef: "sha256:policy",
    decisionRef: "decision-1",
    attestor: {
      address: "0x1111111111111111111111111111111111111111",
      signatureScheme: "eip712",
    },
    signature: "0x" + "ab".repeat(65),
    signedAt: new Date().toISOString(),
    eip712: {
      domain: EXPECTED_DOMAIN,
      types: EXPECTED_TYPES,
      primaryType: "Attestation",
      message: {
        role: "release-authority",
        policyRef: "sha256:policy",
        decisionRef: "decision-1",
        runId: run.id,
      },
      ...binding,
    },
  });
  await closeSpan(run, span.id);
  return finalizeTrace(run);
}

describe("eip712 schema pins are mandatory (#58 round-3)", () => {
  it("rejects an EMPTY Attestation struct that carries fields as untyped extras", async () => {
    // The signed struct declares NO fields; role/policyRef/decisionRef/runId ride
    // as untyped message extras the signature does not commit to.
    const bundle = await eip712Bundle({
      types: { Attestation: [] },
    });
    const verifier = createEip712GovernanceVerifier({
      verifyTypedData: async () => true, // empty struct 'verifies' with attacker key
      expectedDomain: EXPECTED_DOMAIN,
      expectedPrimaryType: "Attestation",
      expectedTypes: EXPECTED_TYPES,
    });
    const summaries = await verifyGovernanceAttestations(bundle, {
      verifiers: { eip712: verifier },
      authorizedAttestors: ["0x1111111111111111111111111111111111111111"],
    });
    expect(summaries[0]!.verified).toBe(false);
  });

  it("throws at construction when the schema pins are omitted", () => {
    expect(() =>
      // @ts-expect-error — pins are now mandatory
      createEip712GovernanceVerifier({ verifyTypedData: async () => true })
    ).toThrow(/expectedTypes|expectedDomain|expectedPrimaryType|required/i);
  });

  it("throws when the pinned primaryType omits a required field", () => {
    expect(() =>
      createEip712GovernanceVerifier({
        verifyTypedData: async () => true,
        expectedDomain: EXPECTED_DOMAIN,
        expectedPrimaryType: "Attestation",
        expectedTypes: {
          Attestation: [
            { name: "role", type: "string" },
            { name: "policyRef", type: "string" },
            // decisionRef + runId missing → signature would not commit to them
          ],
        },
      })
    ).toThrow(/decisionRef|runId|must include/i);
  });

  it("accepts a correctly-typed genuine attestation", async () => {
    const bundle = await eip712Bundle({});
    const verifier = createEip712GovernanceVerifier({
      verifyTypedData: async () => true,
      expectedDomain: EXPECTED_DOMAIN,
      expectedPrimaryType: "Attestation",
      expectedTypes: EXPECTED_TYPES,
    });
    const summaries = await verifyGovernanceAttestations(bundle, {
      verifiers: { eip712: verifier },
      authorizedAttestors: ["0x1111111111111111111111111111111111111111"],
    });
    expect(summaries[0]!.verified).toBe(true);
  });
});

describe("governance requires an authorized-attestor allow-list (#58 round-3)", () => {
  async function attestedBundle(): Promise<{ bundle: TraceBundle; attestor: string }> {
    const run = await createTrace({ agentId: "agent-1" });
    const span = addSpan(run, { name: "release", visibility: "public" });
    const decision = await addEvent(run, span.id, {
      kind: "decision",
      decision: "ship model v2",
      visibility: "public",
    });
    const signer = await createSr25519GovernanceSigner({ seed: SEED_A });
    await addGovernanceAttestation(run, span.id, {
      role: "release-authority",
      policyRef: "sha256:policy-doc-hash",
      decisionRef: decision.id,
      signer,
    });
    await closeSpan(run, span.id);
    return { bundle: await finalizeTrace(run), attestor: signer.address };
  }

  it("an attestation from an UNLISTED signer is not authorized", async () => {
    const { bundle } = await attestedBundle();
    const otherSigner = await createSr25519GovernanceSigner({ seed: SEED_B });
    const summaries = await verifyGovernanceAttestations(bundle, {
      authorizedAttestors: [otherSigner.address], // genuine signer NOT listed
    });
    expect(summaries[0]!.verified).toBe(false);
    expect(summaries[0]!.authorized).toBe(false);
  });

  it("an attestation from an ALLOW-LISTED signer verifies", async () => {
    const { bundle, attestor } = await attestedBundle();
    const summaries = await verifyGovernanceAttestations(bundle, {
      authorizedAttestors: [attestor],
    });
    expect(summaries[0]!.verified).toBe(true);
    expect(summaries[0]!.authorized).toBe(true);
  });

  it("with NO allow-list, governance fails closed and does not pass the bundle", async () => {
    const { bundle } = await attestedBundle();
    // A genuine self-signed attestation with a valid signature — but nobody said
    // this key is a real release-authority. It must not fold into a pass.
    const summaries = await verifyGovernanceAttestations(bundle);
    expect(summaries[0]!.verified).toBe(false);
    expect(summaries[0]!.authorized).toBe(false);

    const result = await verifyBundle(bundle, { governance: true });
    expect(result.checks.governanceValid).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("verifyBundle with an allow-list folds a real sign-off into valid", async () => {
    const { bundle, attestor } = await attestedBundle();
    const result = await verifyBundle(bundle, {
      governance: { authorizedAttestors: [attestor] },
    });
    expect(result.checks.governanceValid).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("an unlisted signer fails the bundle", async () => {
    const { bundle } = await attestedBundle();
    const other = await createSr25519GovernanceSigner({ seed: SEED_B });
    const result = await verifyBundle(bundle, {
      governance: { authorizedAttestors: [other.address] },
    });
    expect(result.checks.governanceValid).toBe(false);
    expect(result.valid).toBe(false);
  });
});
