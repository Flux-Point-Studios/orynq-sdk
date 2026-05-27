/**
 * Cross-language byte-pin test.
 *
 * Spawns the Python encoder as a subprocess (orynq-observe must be
 * pip-installed in the same workspace via the sibling Python package's
 * venv) and asserts that for the same record, the canonical CBOR bytes
 * and content_hash are byte-equal across the two implementations.
 *
 * Skipped when the Python encoder is unreachable — CI sets PY_OBSERVE_BIN
 * to the venv python so this always runs there.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  canonicalCbor,
  canonicalContentHash,
  type AiCapabilityObservationRecord,
} from "../canonical";

const PY_BIN =
  process.env.PY_OBSERVE_BIN ??
  "/home/deci/work/orynq-sdk-observe/packages/orynq-observe/.venv/bin/python3";

function pyAvailable(): boolean {
  if (!existsSync(PY_BIN)) return false;
  const r = spawnSync(PY_BIN, ["-c", "import orynq_observe"], {
    encoding: "utf-8",
  });
  return r.status === 0;
}

function pyEncode(record: AiCapabilityObservationRecord): {
  cborHex: string;
  contentHash: string;
} {
  const script =
    "import sys, json, binascii\n" +
    "from orynq_observe.canonical import canonical_cbor, canonical_content_hash\n" +
    "rec = json.load(sys.stdin)\n" +
    "b = canonical_cbor(rec)\n" +
    "sys.stdout.write(binascii.hexlify(b).decode() + '\\n')\n" +
    "sys.stdout.write(canonical_content_hash(rec) + '\\n')\n";
  const r = spawnSync(PY_BIN, ["-c", script], {
    input: JSON.stringify(record),
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`python encoder failed: ${r.stderr}`);
  const [cborHex, contentHash] = r.stdout.trim().split("\n");
  return { cborHex, contentHash };
}

function goodRecord(): AiCapabilityObservationRecord {
  const promptHash = createHash("sha256").update("prompt-bytes").digest("hex");
  const responseHash = createHash("sha256").update("response-bytes").digest("hex");
  const modelHash = createHash("sha256").update("model-bytes").digest("hex");
  return {
    schemaVersion: "ai_capability_observation_v1",
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

describe.skipIf(!pyAvailable())("cross-language byte-pin", () => {
  it("encodes identical bytes for a plain record", () => {
    const record = goodRecord();
    const tsBytes = canonicalCbor(record);
    const tsHex = Buffer.from(tsBytes).toString("hex");
    const tsHash = canonicalContentHash(record);
    const py = pyEncode(record);
    expect(tsHex).toBe(py.cborHex);
    expect(tsHash).toBe(py.contentHash);
  });

  it("encodes identical bytes with artifactRef set", () => {
    const record = goodRecord();
    record.observation.artifactRef = "blob:" + "a".repeat(64);
    const tsHex = Buffer.from(canonicalCbor(record)).toString("hex");
    const py = pyEncode(record);
    expect(tsHex).toBe(py.cborHex);
    expect(canonicalContentHash(record)).toBe(py.contentHash);
  });

  it("encodes identical bytes with TEE attestation", () => {
    const record = goodRecord();
    const teeHex = "deadbeefcafe0011";
    // Python encoder accepts hex string or bytes for evidence; we use hex
    // here because the JSON serialization can't carry Uint8Array directly.
    record.observer.teeAttestation = {
      tier: "Acurast",
      evidence: teeHex,
    };
    const tsHex = Buffer.from(canonicalCbor(record)).toString("hex");
    const py = pyEncode(record);
    expect(tsHex).toBe(py.cborHex);
    expect(canonicalContentHash(record)).toBe(py.contentHash);
  });

  it("encodes identical bytes with null model.hash", () => {
    const record = goodRecord();
    record.model.hash = null;
    const tsHex = Buffer.from(canonicalCbor(record)).toString("hex");
    const py = pyEncode(record);
    expect(tsHex).toBe(py.cborHex);
  });

  it("encodes identical bytes across all severity values", () => {
    for (const sev of ["low", "medium", "high", "critical"] as const) {
      const record = goodRecord();
      record.capability.severity = sev;
      const tsHex = Buffer.from(canonicalCbor(record)).toString("hex");
      const py = pyEncode(record);
      expect(tsHex).toBe(py.cborHex);
    }
  });
});
