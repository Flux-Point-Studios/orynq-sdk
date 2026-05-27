import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  SCHEMA_VERSION,
  SCHEMA_HASH_HEX,
  TEE_TIERS,
  SEVERITIES,
  canonicalCborPreImage,
  canonicalContentHash,
  validateAiCapabilityObservationV1,
  type AiCapabilityObservationV1,
} from "../schemas/ai_capability_observation_v1.js";

const PUBKEY = "11".repeat(32); // 32 zero-ish bytes for prompt hash
const PROMPT_HASH = "a".repeat(64);
const RESPONSE_HASH = "b".repeat(64);
const MODEL_HASH = "c".repeat(64);
const TEE_EVIDENCE_HEX = "de".repeat(48); // 96 bytes of evidence
const OBSERVER_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

const BASELINE: AiCapabilityObservationV1 = {
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
    ss58: OBSERVER_SS58,
    context: "scripted regression run",
    teeAttestation: {
      tier: "Acurast",
      evidence: TEE_EVIDENCE_HEX,
    },
  },
};

const NULL_FIELDS: AiCapabilityObservationV1 = {
  schemaVersion: "ai_capability_observation_v1",
  model: {
    name: "anon-model",
    version: "v0",
    hash: null,
  },
  capability: {
    taxonomyId: "TEST-001",
    severity: "low",
  },
  observation: {
    promptHash: PROMPT_HASH,
    responseHash: RESPONSE_HASH,
    artifactRef: null,
    occurredAt: "2026-05-27T00:00:00Z",
  },
  observer: {
    ss58: OBSERVER_SS58,
    context: "no tee, no artifact, no model hash",
    teeAttestation: null,
  },
};

describe("ai_capability_observation_v1 schema constants", () => {
  it("schema version is the pinned literal", () => {
    expect(SCHEMA_VERSION).toBe("ai_capability_observation_v1");
  });

  it("schema hash is sha256 of the version string", () => {
    const expected = createHash("sha256")
      .update("ai_capability_observation_v1", "utf-8")
      .digest("hex");
    expect(SCHEMA_HASH_HEX).toBe(expected);
  });

  it("enumerates the four TEE tiers in pinned order", () => {
    expect([...TEE_TIERS]).toEqual(["ARM-TZ", "Acurast", "SEV-SNP", "build"]);
  });

  it("enumerates the four severity levels in pinned order", () => {
    expect([...SEVERITIES]).toEqual(["low", "medium", "high", "critical"]);
  });
});

describe("canonical CBOR pre-image", () => {
  it("is deterministic across repeated encoding", () => {
    const a = canonicalCborPreImage(BASELINE);
    const b = canonicalCborPreImage(BASELINE);
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
  });

  it("is deterministic when input dict key order is shuffled", () => {
    const a = canonicalCborPreImage(BASELINE);
    const reordered: AiCapabilityObservationV1 = {
      // top-level fields in reverse order — pre-image MUST not care
      observer: BASELINE.observer,
      observation: BASELINE.observation,
      capability: BASELINE.capability,
      model: BASELINE.model,
      schemaVersion: BASELINE.schemaVersion,
    };
    const b = canonicalCborPreImage(reordered);
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
  });

  it("differs when any single field changes", () => {
    const a = canonicalCborPreImage(BASELINE);
    const mutated: AiCapabilityObservationV1 = {
      ...BASELINE,
      capability: { ...BASELINE.capability, severity: "critical" },
    };
    const b = canonicalCborPreImage(mutated);
    expect(Buffer.from(a).toString("hex")).not.toBe(
      Buffer.from(b).toString("hex"),
    );
  });

  it("handles all-null optional fields and differs from the non-null record", () => {
    const nullPre = canonicalCborPreImage(NULL_FIELDS);
    expect(nullPre.length).toBeGreaterThan(0);
    // The non-null record differs from the null-field record in three places
    // (model.hash, observation.artifactRef, observer.teeAttestation) so the
    // encoded bytes must differ end-to-end.
    const fullPre = canonicalCborPreImage(BASELINE);
    expect(Buffer.from(nullPre).toString("hex")).not.toBe(
      Buffer.from(fullPre).toString("hex"),
    );
  });

  it("null teeAttestation encodes as the CBOR null primitive (0xf6)", () => {
    // Smallest, surgical test: in NULL_FIELDS the only sub-tree directly
    // beneath an `teeAttestation` key is `null`, so the byte that immediately
    // follows the text-encoded key "teeAttestation" (major 3 + len 14 head
    // = 0x6e) MUST be 0xf6. The key is unique in the document.
    const pre = canonicalCborPreImage(NULL_FIELDS);
    const hex = Buffer.from(pre).toString("hex");
    const keyText = Buffer.from("teeAttestation", "utf-8").toString("hex");
    const keyHead = "6e" + keyText; // major-3 + length 14
    const idx = hex.indexOf(keyHead);
    expect(idx).toBeGreaterThanOrEqual(0);
    const valueByte = hex.slice(idx + keyHead.length, idx + keyHead.length + 2);
    expect(valueByte).toBe("f6");
  });

  it("encodes the schema version literal as the first array element", () => {
    const pre = canonicalCborPreImage(BASELINE);
    // CBOR array head major-4 with 5 elements: 0x85. Then text-string major-3
    // length-28 (the schema-version literal is 28 bytes): 0x78 0x1c, followed
    // by the UTF-8 bytes of "ai_capability_observation_v1".
    expect(pre[0]).toBe(0x85);
    const literalBytes = Buffer.from(SCHEMA_VERSION, "utf-8");
    expect(literalBytes.length).toBe(28);
    expect(pre[1]).toBe(0x78); // major 3 + additional 24
    expect(pre[2]).toBe(0x1c); // length 28
    expect(Buffer.from(pre.subarray(3, 3 + 28)).toString("utf-8")).toBe(SCHEMA_VERSION);
  });
});

describe("content_hash", () => {
  it("equals sha256 of the canonical CBOR pre-image", () => {
    const pre = canonicalCborPreImage(BASELINE);
    const expected = createHash("sha256").update(pre).digest("hex");
    expect(canonicalContentHash(BASELINE)).toBe(expected);
  });

  it("is stable across re-encoding of the same input", () => {
    const a = canonicalContentHash(BASELINE);
    const b = canonicalContentHash(BASELINE);
    expect(a).toBe(b);
  });

  it("changes when capability.severity changes", () => {
    const a = canonicalContentHash(BASELINE);
    const b = canonicalContentHash({
      ...BASELINE,
      capability: { ...BASELINE.capability, severity: "critical" },
    });
    expect(a).not.toBe(b);
  });
});

describe("validateAiCapabilityObservationV1", () => {
  it("accepts a fully-populated baseline record", () => {
    const r = validateAiCapabilityObservationV1(BASELINE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.schemaVersion).toBe(SCHEMA_VERSION);
      expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.schemaHash).toBe(SCHEMA_HASH_HEX);
    }
  });

  it("accepts a record with all optional fields null", () => {
    const r = validateAiCapabilityObservationV1(NULL_FIELDS);
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown schemaVersion", () => {
    const r = validateAiCapabilityObservationV1({
      ...BASELINE,
      schemaVersion: "ai_capability_observation_v2",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WRONG_SCHEMA_VERSION");
  });

  it("rejects an invalid TEE tier", () => {
    const r = validateAiCapabilityObservationV1({
      ...BASELINE,
      observer: {
        ...BASELINE.observer,
        teeAttestation: { tier: "TPM" as never, evidence: TEE_EVIDENCE_HEX },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TEE_TIER_INVALID");
  });

  it("rejects an invalid severity", () => {
    const r = validateAiCapabilityObservationV1({
      ...BASELINE,
      capability: {
        ...BASELINE.capability,
        severity: "extreme" as never,
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SEVERITY_INVALID");
  });

  it("rejects observer.context longer than 280 chars", () => {
    const r = validateAiCapabilityObservationV1({
      ...BASELINE,
      observer: { ...BASELINE.observer, context: "x".repeat(281) },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CONTEXT_TOO_LONG");
  });

  it("rejects a non-hex promptHash", () => {
    const r = validateAiCapabilityObservationV1({
      ...BASELINE,
      observation: { ...BASELINE.observation, promptHash: "not-hex" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("HEX_FORMAT");
  });

  it("rejects a non-ISO8601 occurredAt", () => {
    const r = validateAiCapabilityObservationV1({
      ...BASELINE,
      observation: { ...BASELINE.observation, occurredAt: "2026/01/15 12:34" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("OCCURRED_AT_INVALID");
  });

  it("rejects a missing model.name", () => {
    const broken = JSON.parse(JSON.stringify(BASELINE));
    delete broken.model.name;
    const r = validateAiCapabilityObservationV1(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MISSING_FIELD");
  });
});
