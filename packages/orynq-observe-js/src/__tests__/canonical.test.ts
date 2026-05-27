/**
 * Smoke tests for the SDK's canonical re-export.
 *
 * The SDK's `canonicalCbor` / `canonicalContentHash` delegate to the
 * canonical schema codec in `@fluxpointstudios/orynq-sdk-anchors-materios`.
 * Byte-pin lockstep is covered by `canonical_lockstep.test.ts`; this file
 * just verifies the re-export wires through correctly + the schema constants
 * are surfaced.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  canonicalCbor,
  canonicalContentHash,
  SCHEMA_HASH_HEX,
  SCHEMA_VERSION,
  SEVERITIES,
  TEE_TIERS,
  type AiCapabilityObservationRecord,
} from "../canonical";

const promptHash = createHash("sha256").update("prompt-bytes").digest("hex");
const responseHash = createHash("sha256").update("response-bytes").digest("hex");
const modelHash = createHash("sha256").update("model-bytes").digest("hex");

function goodRecord(): AiCapabilityObservationRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    model: {
      name: "claude-opus-4-7",
      version: "20260201",
      hash: modelHash,
    },
    capability: {
      taxonomyId: "AUTO-MONEY-001",
      severity: "high",
    },
    observation: {
      promptHash,
      responseHash,
      artifactRef: null,
      occurredAt: "2026-01-15T12:34:56Z",
    },
    observer: {
      ss58: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      context: "independent red-team session",
      teeAttestation: null,
    },
  };
}

describe("canonical re-export", () => {
  it("pins the schema version literal", () => {
    expect(SCHEMA_VERSION).toBe("ai_capability_observation_v1");
    expect(SCHEMA_HASH_HEX).toBe(
      createHash("sha256").update(SCHEMA_VERSION).digest("hex"),
    );
  });

  it("pins the severities order", () => {
    expect(SEVERITIES).toEqual(["low", "medium", "high", "critical"]);
  });

  it("pins the TEE tiers", () => {
    expect(TEE_TIERS).toEqual(["ARM-TZ", "Acurast", "SEV-SNP", "build"]);
  });

  it("is deterministic", () => {
    const r1 = canonicalCbor(goodRecord());
    const r2 = canonicalCbor(goodRecord());
    expect(Buffer.from(r1).equals(Buffer.from(r2))).toBe(true);
  });

  it("emits a 5-element outer array (0x85 head)", () => {
    expect(canonicalCbor(goodRecord())[0]).toBe(0x85);
  });

  it("content_hash matches sha256(canonicalCbor)", () => {
    const r = goodRecord();
    const expected = createHash("sha256").update(canonicalCbor(r)).digest("hex");
    expect(canonicalContentHash(r)).toBe(expected);
  });

  it("encodes a CBOR null (0xf6) when teeAttestation is null", () => {
    const r = goodRecord();
    r.observer.teeAttestation = null;
    expect(Array.from(canonicalCbor(r))).toContain(0xf6);
  });

  it("content_hash changes when model.hash flips between null and bytes", () => {
    const r = goodRecord();
    r.model.hash = null;
    const withNull = canonicalContentHash(r);
    r.model.hash = modelHash;
    const withHash = canonicalContentHash(r);
    expect(withNull).not.toBe(withHash);
  });
});
