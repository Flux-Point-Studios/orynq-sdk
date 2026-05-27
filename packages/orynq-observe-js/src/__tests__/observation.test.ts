/**
 * Tests for the Observation fluent builder.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  Observation,
  ObservationError,
  ObserverKeypair,
  canonicalContentHash,
  SCHEMA_VERSION,
} from "../index";

async function fixtureKp(): Promise<ObserverKeypair> {
  return ObserverKeypair.fromSeedHex("0x" + "a1".repeat(32));
}

function makeObs(): Observation {
  return new Observation({
    modelName: "claude-opus-4-7",
    modelVersion: "20260201",
    taxonomyId: "AUTO-MONEY-001",
    severity: "high",
    observerContext: "test",
    occurredAt: "2026-11-14T22:13:20Z",
  });
}

describe("Observation builder", () => {
  it("rejects empty modelName", () => {
    expect(
      () =>
        new Observation({
          modelName: "",
          modelVersion: "v",
          taxonomyId: "t",
          severity: "high",
          observerContext: "x",
        }),
    ).toThrow(ObservationError);
  });

  it("rejects unknown severity", () => {
    expect(
      () =>
        new Observation({
          modelName: "m",
          modelVersion: "v",
          taxonomyId: "t",
          // @ts-expect-error — intentional bad input
          severity: "catastrophic",
          observerContext: "x",
        }),
    ).toThrow(ObservationError);
  });

  it("rejects non-string occurredAt", () => {
    expect(
      () =>
        new Observation({
          modelName: "m",
          modelVersion: "v",
          taxonomyId: "t",
          severity: "high",
          observerContext: "x",
          // @ts-expect-error — intentional bad input
          occurredAt: 1_700_000_000_000,
        }),
    ).toThrow(ObservationError);
  });

  it("toRecord requires evidence", async () => {
    const kp = await fixtureKp();
    const obs = makeObs();
    expect(() => obs.toRecord(kp.ss58Address)).toThrow(ObservationError);
  });

  it("addEvidence hashes string inputs as utf-8", async () => {
    const kp = await fixtureKp();
    const obs = makeObs().addEvidence({ prompt: "prompt-bytes", response: "response-bytes" });
    const record = obs.toRecord(kp.ss58Address);
    expect(record.observation.promptHash).toBe(
      createHash("sha256").update("prompt-bytes").digest("hex"),
    );
    expect(record.observation.responseHash).toBe(
      createHash("sha256").update("response-bytes").digest("hex"),
    );
  });

  it("addEvidence accepts Uint8Array", async () => {
    const kp = await fixtureKp();
    const obs = makeObs().addEvidence({
      prompt: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      response: new Uint8Array([0x01, 0x02, 0x03]),
    });
    const record = obs.toRecord(kp.ss58Address);
    expect(record.observation.promptHash).toBe(
      createHash("sha256").update(Buffer.from([0xde, 0xad, 0xbe, 0xef])).digest("hex"),
    );
  });

  it("toRecord carries schemaVersion + observer ss58", async () => {
    const kp = await fixtureKp();
    const obs = makeObs().addEvidence({ prompt: "p", response: "r" });
    const record = obs.toRecord(kp.ss58Address);
    expect(record.schemaVersion).toBe(SCHEMA_VERSION);
    expect(record.observer.ss58).toBe(kp.ss58Address);
  });

  it("attestTee adds the envelope", async () => {
    const kp = await fixtureKp();
    const obs = makeObs()
      .addEvidence({ prompt: "p", response: "r" })
      .attestTee({ tier: "Acurast", evidence: "deadbeef" });
    const record = obs.toRecord(kp.ss58Address);
    expect(record.observer.teeAttestation?.tier).toBe("Acurast");
    expect(record.observer.teeAttestation?.evidence).toBe("deadbeef");
  });

  it("addArtifact with opaque ref stores verbatim", async () => {
    const kp = await fixtureKp();
    const obs = makeObs().addEvidence({ prompt: "p", response: "r" });
    await obs.addArtifact("ipfs://Qmabc");
    const record = obs.toRecord(kp.ss58Address);
    expect(record.observation.artifactRef).toBe("ipfs://Qmabc");
  });

  it("contentHash matches the canonical content hash", async () => {
    const kp = await fixtureKp();
    const obs = makeObs().addEvidence({ prompt: "p", response: "r" });
    const record = obs.toRecord(kp.ss58Address);
    expect(obs.contentHash(kp.ss58Address)).toBe(canonicalContentHash(record));
  });

  it("supports fluent chaining", async () => {
    const kp = await fixtureKp();
    const h = makeObs()
      .addEvidence({ prompt: "p", response: "r" })
      .attestTee({ tier: "Acurast", evidence: "00" })
      .contentHash(kp.ss58Address);
    expect(h.length).toBe(64);
  });
});
