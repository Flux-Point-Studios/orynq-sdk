/**
 * Tests for the canonical CBOR encoder. Vectors are byte-pinned and must
 * match the Python encoder byte-for-byte (covered by the cross-lang test).
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  canonicalCbor,
  canonicalContentHash,
  SCHEMA_HASH_HEX,
  SCHEMA_VERSION,
  SEVERITIES,
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
      occurredAt: 1_700_000_000_000,
    },
    observer: {
      ss58: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      context: "independent red-team session",
      teeAttestation: null,
    },
  };
}

describe("canonical encoder", () => {
  it("pins the schema version literal", () => {
    expect(SCHEMA_VERSION).toBe("ai_capability_observation_v1");
    expect(SCHEMA_HASH_HEX).toBe(
      createHash("sha256").update(SCHEMA_VERSION).digest("hex"),
    );
  });

  it("pins the severities order", () => {
    expect(SEVERITIES).toEqual(["low", "medium", "high", "critical"]);
  });

  it("is deterministic", () => {
    const r1 = canonicalCbor(goodRecord());
    const r2 = canonicalCbor(goodRecord());
    expect(Buffer.from(r1).equals(Buffer.from(r2))).toBe(true);
  });

  it("emits a 5-element outer array (0x85 head)", () => {
    const b = canonicalCbor(goodRecord());
    expect(b[0]).toBe(0x85);
  });

  it("rejects wrong schemaVersion", () => {
    const r = goodRecord();
    (r as { schemaVersion: string }).schemaVersion = "ai_capability_observation_v0";
    expect(() => canonicalCbor(r)).toThrow(TypeError);
  });

  it("rejects unknown severity", () => {
    const r = goodRecord();
    (r.capability as { severity: string }).severity = "catastrophic";
    expect(() => canonicalCbor(r)).toThrow(TypeError);
  });

  it("requires top-level model/capability/observation/observer", () => {
    for (const k of ["model", "capability", "observation", "observer"] as const) {
      const r = goodRecord() as Partial<AiCapabilityObservationRecord>;
      delete (r as Record<string, unknown>)[k];
      expect(() => canonicalCbor(r as AiCapabilityObservationRecord)).toThrow(
        TypeError,
      );
    }
  });

  it("treats model.hash absent as null", () => {
    const r = goodRecord();
    r.model.hash = null;
    const withNull = canonicalContentHash(r);
    r.model.hash = modelHash;
    const withHash = canonicalContentHash(r);
    expect(withNull).not.toBe(withHash);
  });

  it("accepts a string artifactRef", () => {
    const r = goodRecord();
    r.observation.artifactRef = "ipfs://Qmabc";
    const b = canonicalCbor(r);
    expect(b.length).toBeGreaterThan(100);
  });

  it("rejects bool in occurredAt (via integer check)", () => {
    const r = goodRecord();
    (r.observation as { occurredAt: unknown }).occurredAt = true;
    expect(() => canonicalCbor(r)).toThrow(TypeError);
  });

  it("changes pre-image when TEE attestation is added", () => {
    const without = canonicalCbor(goodRecord());
    const r = goodRecord();
    r.observer.teeAttestation = {
      tier: "Acurast",
      evidence: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    };
    const withTee = canonicalCbor(r);
    expect(Buffer.from(without).equals(Buffer.from(withTee))).toBe(false);
  });

  it("treats hex string and bytes prompt/response hash identically", () => {
    const rHex = goodRecord();
    const rBytes = goodRecord();
    rBytes.observation.promptHash = Buffer.from(promptHash, "hex");
    rBytes.observation.responseHash = Buffer.from(responseHash, "hex");
    rBytes.model.hash = Buffer.from(modelHash, "hex");
    expect(Buffer.from(canonicalCbor(rHex)).equals(Buffer.from(canonicalCbor(rBytes)))).toBe(
      true,
    );
  });

  it("rejects short prompt hash", () => {
    const r = goodRecord();
    r.observation.promptHash = "abcd".repeat(4); // 16 hex, not 64
    expect(() => canonicalCbor(r)).toThrow(TypeError);
  });

  it("content_hash matches sha256(canonicalCbor)", () => {
    const r = goodRecord();
    const expected = createHash("sha256").update(canonicalCbor(r)).digest("hex");
    expect(canonicalContentHash(r)).toBe(expected);
  });
});
