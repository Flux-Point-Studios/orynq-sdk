/**
 * @summary Round-2 hardening regression tests for process-trace (#58, #59).
 *
 *  1. eip712 governance verifier must pin/validate the attacker-controlled
 *     `event.eip712.{domain,primaryType,types}` against the expected
 *     governance-attestation schema — an unexpected domain/primaryType is
 *     rejected even when the raw signature "verifies".
 *  2. verifyBundle must also verify the publicView model-manifest fields (the
 *     shared artifact an external verifier reads), not just privateRun's — a
 *     fabricated publicView.modelManifestHash must fail.
 */

import { describe, it, expect } from "vitest";
import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
  verifyBundle,
  verifyGovernanceAttestations,
  createEip712GovernanceVerifier,
} from "../index.js";
import type { TraceBundle, TraceRun } from "../index.js";

const EXPECTED_DOMAIN = { name: "Orynq", version: "1" };
const EXPECTED_TYPES = {
  Attestation: [
    { name: "role", type: "string" },
    { name: "policyRef", type: "string" },
    { name: "decisionRef", type: "string" },
    { name: "runId", type: "string" },
  ],
};

async function eip712Bundle(bindingOverrides: Record<string, unknown>): Promise<TraceBundle> {
  const run = await createTrace({ agentId: "agent-1" });
  const span = addSpan(run, { name: "approve", visibility: "public" });
  await addEvent(run, span.id, {
    kind: "governance-attestation",
    visibility: "public",
    role: "compliance",
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
        role: "compliance",
        policyRef: "sha256:policy",
        decisionRef: "decision-1",
        runId: run.id,
      },
      ...bindingOverrides,
    },
  });
  await closeSpan(run, span.id);
  return finalizeTrace(run);
}

describe("eip712 domain/primaryType pinning (#58)", () => {
  it("rejects an unexpected primaryType even when the raw signature verifies", async () => {
    const bundle = await eip712Bundle({ primaryType: "EvilType" });
    const verifier = createEip712GovernanceVerifier({
      verifyTypedData: async () => true, // signature is 'valid' over attacker data
      expectedDomain: EXPECTED_DOMAIN,
      expectedPrimaryType: "Attestation",
      expectedTypes: EXPECTED_TYPES,
    });
    const summaries = await verifyGovernanceAttestations(bundle, {
      verifiers: { eip712: verifier },
    });
    expect(summaries[0]!.verified).toBe(false);
  });

  it("rejects an unexpected domain (attacker swaps verifyingContract/chainId)", async () => {
    const bundle = await eip712Bundle({
      domain: { name: "Orynq", version: "1", chainId: 1, verifyingContract: "0xevil" },
    });
    const verifier = createEip712GovernanceVerifier({
      verifyTypedData: async () => true,
      expectedDomain: EXPECTED_DOMAIN,
      expectedPrimaryType: "Attestation",
      expectedTypes: EXPECTED_TYPES,
    });
    const summaries = await verifyGovernanceAttestations(bundle, {
      verifiers: { eip712: verifier },
    });
    expect(summaries[0]!.verified).toBe(false);
  });

  it("accepts the expected domain + primaryType", async () => {
    const bundle = await eip712Bundle({});
    const verifier = createEip712GovernanceVerifier({
      verifyTypedData: async () => true,
      expectedDomain: EXPECTED_DOMAIN,
      expectedPrimaryType: "Attestation",
      expectedTypes: EXPECTED_TYPES,
    });
    const summaries = await verifyGovernanceAttestations(bundle, {
      verifiers: { eip712: verifier },
    });
    expect(summaries[0]!.verified).toBe(true);
  });
});

describe("publicView model-manifest verification (#59)", () => {
  async function manifestBundle(): Promise<TraceBundle> {
    const run: TraceRun = await createTrace({
      agentId: "agent-m",
      manifest: {
        modelHash: "sha256:" + "1".repeat(64),
        modelId: "gpt-x",
        framework: "acme",
      },
    });
    const span = addSpan(run, { name: "work", visibility: "public" });
    await addEvent(run, span.id, { kind: "command", command: "go", visibility: "public" });
    await closeSpan(run, span.id);
    return finalizeTrace(run);
  }

  it("an honest bundle with a pinned manifest verifies", async () => {
    const bundle = await manifestBundle();
    expect(bundle.publicView.modelManifestHash).toBeDefined();
    const result = await verifyBundle(bundle, { });
    expect(result.checks.modelManifestValid).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("a fabricated publicView.modelManifestHash fails verification", async () => {
    const bundle = await manifestBundle();
    const forged = JSON.parse(JSON.stringify(bundle)) as TraceBundle;
    // privateRun manifest is left honest; only the shared publicView field an
    // external verifier reads is fabricated.
    forged.publicView.modelManifestHash = "f".repeat(64);

    const result = await verifyBundle(forged);
    expect(result.checks.modelManifestValid).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("a fabricated publicView.modelManifest (recomputes to a different hash) fails", async () => {
    const bundle = await manifestBundle();
    const forged = JSON.parse(JSON.stringify(bundle)) as TraceBundle;
    (forged.publicView.modelManifest as Record<string, unknown>) = {
      modelHash: "sha256:" + "9".repeat(64),
      modelId: "EVIL",
      framework: "attacker",
    };

    const result = await verifyBundle(forged);
    expect(result.checks.modelManifestValid).toBe(false);
    expect(result.valid).toBe(false);
  });
});
