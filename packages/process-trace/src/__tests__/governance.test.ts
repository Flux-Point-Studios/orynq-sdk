/**
 * @summary Tests for governance attestations (issue #58).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
  verifyBundle,
  addGovernanceAttestation,
  createSr25519GovernanceSigner,
  createEd25519GovernanceSigner,
  verifyGovernanceAttestations,
  createEip712GovernanceVerifier,
  governanceAttestationPreimage,
} from "../index.js";
import type { TraceRun, TraceBundle, GovernanceAttestationEvent } from "../index.js";

const SEED_A = "0x" + "11".repeat(32);
const SEED_B = "0x" + "22".repeat(32);

async function buildAttestedBundle(scheme: "sr25519" | "ed25519"): Promise<TraceBundle> {
  const run: TraceRun = await createTrace({ agentId: "agent-1" });
  const span = addSpan(run, { name: "release", visibility: "public" });
  const decision = await addEvent(run, span.id, {
    kind: "decision",
    decision: "ship model v2",
    visibility: "public",
  });

  const signer =
    scheme === "sr25519"
      ? await createSr25519GovernanceSigner({ seed: SEED_A })
      : await createEd25519GovernanceSigner({ seed: SEED_A });

  await addGovernanceAttestation(run, span.id, {
    role: "release-authority",
    policyRef: "sha256:policy-doc-hash",
    decisionRef: decision.id,
    signer,
  });

  await closeSpan(run, span.id);
  return finalizeTrace(run);
}

describe("governanceAttestationPreimage", () => {
  it("is deterministic and order-sensitive", () => {
    const a = governanceAttestationPreimage({
      role: "compliance",
      policyRef: "p",
      decisionRef: "d",
      signedAt: "2026-01-01T00:00:00.000Z",
    });
    const b = governanceAttestationPreimage({
      role: "compliance",
      policyRef: "p",
      decisionRef: "d",
      signedAt: "2026-01-01T00:00:00.000Z",
    });
    const c = governanceAttestationPreimage({
      role: "compliance",
      policyRef: "p",
      decisionRef: "d2",
      signedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
    expect(Buffer.from(a)).not.toEqual(Buffer.from(c));
  });
});

describe("addGovernanceAttestation + verify (sr25519)", () => {
  let bundle: TraceBundle;

  beforeEach(async () => {
    bundle = await buildAttestedBundle("sr25519");
  });

  it("records a governance-attestation event with the expected shape", () => {
    const events = bundle.privateRun.events.filter(
      (e): e is GovernanceAttestationEvent => e.kind === "governance-attestation"
    );
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.role).toBe("release-authority");
    expect(ev.attestor.signatureScheme).toBe("sr25519");
    expect(ev.attestor.address.length).toBeGreaterThan(0);
    expect(ev.signature.startsWith("0x")).toBe(true);
    expect(ev.visibility).toBe("public");
  });

  it("the underlying bundle still verifies (event hashes intact)", async () => {
    const result = await verifyBundle(bundle);
    expect(result.valid).toBe(true);
  });

  it("verifyGovernanceAttestations returns verified=true", async () => {
    const summaries = await verifyGovernanceAttestations(bundle);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.verified).toBe(true);
    expect(summaries[0]!.scheme).toBe("sr25519");
    expect(summaries[0]!.role).toBe("release-authority");
  });

  it("verifyBundle({ governance: true }) sets governanceValid", async () => {
    const result = await verifyBundle(bundle, { governance: true });
    expect(result.checks.governanceValid).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("flags a tampered signature", async () => {
    const tampered = JSON.parse(JSON.stringify(bundle)) as TraceBundle;
    const ev = tampered.privateRun.events.find(
      (e) => e.kind === "governance-attestation"
    ) as GovernanceAttestationEvent;
    // Flip a hex nibble in the signature so it no longer verifies.
    ev.signature = ev.signature.slice(0, -1) + (ev.signature.endsWith("0") ? "1" : "0");

    const summaries = await verifyGovernanceAttestations(tampered);
    expect(summaries[0]!.verified).toBe(false);

    const result = await verifyBundle(tampered, { governance: true });
    expect(result.checks.governanceValid).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("rejects a signature from a different attestor address", async () => {
    const otherSigner = await createSr25519GovernanceSigner({ seed: SEED_B });
    const tampered = JSON.parse(JSON.stringify(bundle)) as TraceBundle;
    const ev = tampered.privateRun.events.find(
      (e) => e.kind === "governance-attestation"
    ) as GovernanceAttestationEvent;
    ev.attestor.address = otherSigner.address; // signature no longer matches the claimed signer

    const summaries = await verifyGovernanceAttestations(tampered);
    expect(summaries[0]!.verified).toBe(false);
  });
});

describe("addGovernanceAttestation + verify (ed25519)", () => {
  it("verifies an ed25519 attestation", async () => {
    const bundle = await buildAttestedBundle("ed25519");
    const summaries = await verifyGovernanceAttestations(bundle);
    expect(summaries[0]!.verified).toBe(true);
    expect(summaries[0]!.scheme).toBe("ed25519");
  });
});

describe("governance replay resistance (#58)", () => {
  it("preimage binds runId so an attestation cannot replay into another trace", () => {
    const a = governanceAttestationPreimage({
      role: "compliance",
      policyRef: "p",
      decisionRef: "d",
      signedAt: "2026-01-01T00:00:00.000Z",
      runId: "run-A",
    });
    const b = governanceAttestationPreimage({
      role: "compliance",
      policyRef: "p",
      decisionRef: "d",
      signedAt: "2026-01-01T00:00:00.000Z",
      runId: "run-B",
    });
    expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
  });

  it("a genuine attestation copied into a different trace fails", async () => {
    const donor = await buildAttestedBundle("sr25519");
    const donorEvent = donor.privateRun.events.find(
      (e) => e.kind === "governance-attestation"
    ) as GovernanceAttestationEvent;

    // In the donor trace it verifies.
    const honest = await verifyGovernanceAttestations(donor);
    expect(honest[0]!.verified).toBe(true);

    // Build a victim trace and splice the donor's genuine attestation into it.
    const victimRun = await createTrace({ agentId: "agent-2" });
    const span = addSpan(victimRun, { name: "release", visibility: "public" });
    await addEvent(victimRun, span.id, {
      kind: "decision",
      decision: "unrelated decision",
      visibility: "public",
    });
    // Splice the genuine (donor-signed) attestation directly into the victim run.
    await addEvent(victimRun, span.id, {
      kind: "governance-attestation",
      visibility: "public",
      role: donorEvent.role,
      policyRef: donorEvent.policyRef,
      decisionRef: donorEvent.decisionRef,
      attestor: donorEvent.attestor,
      signature: donorEvent.signature,
      signedAt: donorEvent.signedAt,
    });
    await closeSpan(victimRun, span.id);
    const victim = await finalizeTrace(victimRun);

    const replayed = await verifyGovernanceAttestations(victim);
    expect(replayed[0]!.verified).toBe(false);
  });
});

describe("eip712 governance verification", () => {
  it("marks eip712 unverified when no verifier is registered", async () => {
    const run = await createTrace({ agentId: "agent-1" });
    const span = addSpan(run, { name: "approve", visibility: "public" });
    // Construct an eip712 attestation directly (caller-supplied signature + binding).
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
        domain: { name: "Orynq", version: "1" },
        types: {
          Attestation: [
            { name: "role", type: "string" },
            { name: "policyRef", type: "string" },
            { name: "decisionRef", type: "string" },
            { name: "runId", type: "string" },
          ],
        },
        primaryType: "Attestation",
        // The signed message MUST carry the event's own claim + trace context.
        message: {
          role: "compliance",
          policyRef: "sha256:policy",
          decisionRef: "decision-1",
          runId: run.id,
        },
      },
    });
    await closeSpan(run, span.id);
    const bundle = await finalizeTrace(run);

    const noVerifier = await verifyGovernanceAttestations(bundle);
    expect(noVerifier[0]!.verified).toBe(false);
    expect(noVerifier[0]!.error).toMatch(/no verifier/i);

    // With an injected verifier (mocked viem.verifyTypedData), it passes.
    const verifier = createEip712GovernanceVerifier({
      verifyTypedData: async (args) => {
        expect(args.primaryType).toBe("Attestation");
        expect(args.address).toBe("0x1111111111111111111111111111111111111111");
        return true;
      },
    });
    const withVerifier = await verifyGovernanceAttestations(bundle, {
      verifiers: { eip712: verifier },
    });
    expect(withVerifier[0]!.verified).toBe(true);
  });

  it("rejects a forged eip712 whose signed message.role != event.role", async () => {
    const run = await createTrace({ agentId: "agent-1" });
    const span = addSpan(run, { name: "approve", visibility: "public" });
    // Attacker holds a signature over a message claiming role "data-steward"
    // but records the event as the higher-privilege "release-authority".
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
        domain: { name: "Orynq", version: "1" },
        types: {
          Attestation: [
            { name: "role", type: "string" },
            { name: "policyRef", type: "string" },
            { name: "decisionRef", type: "string" },
            { name: "runId", type: "string" },
          ],
        },
        primaryType: "Attestation",
        message: {
          role: "data-steward", // != event.role
          policyRef: "sha256:policy",
          decisionRef: "decision-1",
          runId: run.id,
        },
      },
    });
    await closeSpan(run, span.id);
    const bundle = await finalizeTrace(run);

    // Even with a verifier that accepts the raw signature, the field-binding
    // check must reject it.
    const verifier = createEip712GovernanceVerifier({
      verifyTypedData: async () => true,
    });
    const summaries = await verifyGovernanceAttestations(bundle, {
      verifiers: { eip712: verifier },
    });
    expect(summaries[0]!.verified).toBe(false);
  });
});
