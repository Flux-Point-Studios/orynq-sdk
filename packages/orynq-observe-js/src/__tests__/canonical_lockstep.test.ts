/**
 * Byte-pin lockstep test: the SDK's submit-path encoder MUST produce bytes
 * byte-identical to the canonical schema codec for every TEE tier + null.
 *
 * The SDK is a thin wrapper around the canonical
 * `@fluxpointstudios/orynq-sdk-anchors-materios` codec; this test is the
 * harness that decides when the alignment is correct.
 */

import { describe, expect, it } from "vitest";
import {
  type AiCapabilityObservationV1,
  TEE_TIERS,
  canonicalCborPreImageAiCapabilityObservationV1,
  canonicalContentHashAiCapabilityObservationV1,
} from "@fluxpointstudios/orynq-sdk-anchors-materios";

import { canonicalCbor, canonicalContentHash } from "../canonical";

const PROMPT_HASH = "a".repeat(64);
const RESPONSE_HASH = "b".repeat(64);
const MODEL_HASH = "c".repeat(64);
const TEE_EVIDENCE = "de".repeat(48);
const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

function baselineRecord(): AiCapabilityObservationV1 {
  return {
    schemaVersion: "ai_capability_observation_v1",
    model: {
      name: "claude-opus-4-7",
      version: "20260201",
      hash: MODEL_HASH,
    },
    capability: {
      taxonomyId: "AUTO-MONEY-001",
      severity: "high",
    },
    observation: {
      promptHash: PROMPT_HASH,
      responseHash: RESPONSE_HASH,
      artifactRef: "ipfs://QmSomeCidHere",
      occurredAt: "2026-01-15T12:34:56Z",
    },
    observer: {
      ss58: SS58,
      context: "scripted regression run",
      teeAttestation: {
        tier: "Acurast",
        evidence: TEE_EVIDENCE,
      },
    },
  };
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("SDK ↔ canonical-schema byte lockstep", () => {
  it("baseline record encodes byte-identical bytes", () => {
    const rec = baselineRecord();
    const sdkBytes = canonicalCbor(rec);
    const schemaBytes = canonicalCborPreImageAiCapabilityObservationV1(rec);
    expect(bytesEq(sdkBytes, schemaBytes)).toBe(true);
    expect(canonicalContentHash(rec)).toBe(
      canonicalContentHashAiCapabilityObservationV1(rec),
    );
  });

  it("absent TEE attestation encodes as CBOR null (0xf6)", () => {
    const rec = baselineRecord();
    rec.observer.teeAttestation = null;
    const sdkBytes = canonicalCbor(rec);
    const schemaBytes = canonicalCborPreImageAiCapabilityObservationV1(rec);
    expect(bytesEq(sdkBytes, schemaBytes)).toBe(true);
    // The encoded teeAttestation value must be the single byte 0xf6.
    // Locate it by sweeping the bytes for the sentinel — easier than parsing.
    expect(sdkBytes).toContain(0xf6);
  });

  for (const tier of TEE_TIERS) {
    it(`tier="${tier}" encodes byte-identical bytes`, () => {
      const rec = baselineRecord();
      rec.observer.teeAttestation = { tier, evidence: TEE_EVIDENCE };
      const sdkBytes = canonicalCbor(rec);
      const schemaBytes = canonicalCborPreImageAiCapabilityObservationV1(rec);
      expect(bytesEq(sdkBytes, schemaBytes)).toBe(true);
      expect(canonicalContentHash(rec)).toBe(
        canonicalContentHashAiCapabilityObservationV1(rec),
      );
    });
  }

  it("all-nulls record encodes byte-identical bytes", () => {
    const rec: AiCapabilityObservationV1 = {
      schemaVersion: "ai_capability_observation_v1",
      model: { name: "anon-model", version: "v0", hash: null },
      capability: { taxonomyId: "TEST-001", severity: "low" },
      observation: {
        promptHash: PROMPT_HASH,
        responseHash: RESPONSE_HASH,
        artifactRef: null,
        occurredAt: "2026-05-27T00:00:00Z",
      },
      observer: {
        ss58: SS58,
        context: "no tee, no artifact, no model hash",
        teeAttestation: null,
      },
    };
    expect(bytesEq(canonicalCbor(rec), canonicalCborPreImageAiCapabilityObservationV1(rec))).toBe(
      true,
    );
  });

  for (const deadTier of [
    "None",
    "Intel_TDX",
    "ARM_TrustZone",
    "AMD_SEV_SNP",
    "ReproducibleBuild",
  ]) {
    it(`builder rejects dead tier string "${deadTier}"`, async () => {
      const { Observation, ObservationError } = await import("../observation");
      const obs = new Observation({
        modelName: "m",
        modelVersion: "v",
        taxonomyId: "t",
        severity: "low",
        observerContext: "x",
      }).addEvidence({ prompt: "p", response: "r" });
      expect(() =>
        obs.attestTee({
          // @ts-expect-error — intentionally testing dead enum values
          tier: deadTier,
          evidence: TEE_EVIDENCE,
        }),
      ).toThrow(ObservationError);
    });
  }
});
