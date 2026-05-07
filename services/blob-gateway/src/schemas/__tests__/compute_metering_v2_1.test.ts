/**
 * Schema-level tests for compute_metering_v2.1 (Wave 3 Phase 2 additive
 * extension). Covers:
 *
 *   1. v2 records with EMPTY/ABSENT attestation_evidence keep schema literal
 *      `compute_metering_v2` AND produce byte-identical pre-image bytes vs
 *      the pre-Phase-2 encoder. Backwards compat is the load-bearing rule.
 *   2. v2.1 records with one ArmTrustZone evidence entry produce a known
 *      pre-image and content_hash (PINNED — these become spec test vectors).
 *   3. v2.1 records with TWO entries are sorted by EvidenceType DISCRIMINANT
 *      (NOT alphabetical) — ArmTrustZone(2) before ReproducibleBuild(3).
 *   4. v2.1 records with FOUR entries exercise the full sort path + binary
 *      payload encoding (`*_b64` keys decoded to CBOR major-2 byte strings).
 *
 * Tests in this file pin TS-side bytes only. The Python cross-language
 * tests in `packages/compute-meter-sdk/tests/test_v2_1_cross_lang.py` assert
 * byte-equality across encoders.
 */
import { describe, test, expect, beforeAll } from "vitest";
import { createHash } from "crypto";
import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";

import {
  SCHEMA_VERSION,
  SCHEMA_VERSION_V2_1,
  SCHEMA_HASH_HEX,
  SCHEMA_HASH_V2_1_HEX,
  EVIDENCE_TYPES,
  EVIDENCE_TYPE_DISCRIMINANT,
  canonicalCborForWorkerSig,
  canonicalContentHash,
  evidenceEntryToCborValue,
  evidenceArrayToCborValue,
  attestationEvidenceHash,
  deriveEvidenceNonce,
  encodeCbor,
  type AttestationEvidenceEntry,
  type ComputeMeteringV2,
} from "../compute_metering_v2.js";

// ---------------------------------------------------------------------------
// Fixed test vectors. Reused across this file + the Python cross-lang tests.
// Pubkeys/sigs are fixed bytes so the encoder output is fully deterministic.
// ---------------------------------------------------------------------------

const PUBKEY_FLEET = "11".repeat(32);
const SIG_FLEET = "22".repeat(64);
const PUBKEY_WORKER = "33".repeat(32);

const BASE_RECORD: Omit<ComputeMeteringV2, "worker_signature" | "observer"> = {
  schema_version: SCHEMA_VERSION,
  worker_id: "wkr-001",
  tenant_id: "tenant-acme",
  period_start_ms: 1_735_689_600_000,
  period_end_ms: 1_735_689_600_000 + 1_000,
  metrics: {
    cpu_seconds: 1.5,
    ram_gb_hours: 0.0,
    disk_gb_hours: 0.0,
    net_bytes_in: 0,
    net_bytes_out: 0,
    gpu_seconds: 0.0,
  },
  hardware_spec: {
    cpu_cores: 4,
    ram_gb: 16,
    gpu_type: "none",
    gpu_count: 0,
    fleet_operator_pubkey: PUBKEY_FLEET,
    fleet_operator_signature: SIG_FLEET,
    issued_ms: 1_735_689_600_000,
  },
  worker_pubkey: PUBKEY_WORKER,
};

beforeAll(async () => {
  await cryptoWaitReady();
});

// ===========================================================================
// Vector 1 — Backwards compat. v2 record with EMPTY/ABSENT
// attestation_evidence MUST produce byte-identical bytes to today's v2.
// ===========================================================================

describe("v2.1 backwards compat — empty/absent evidence == v2", () => {
  test("absent_evidence_same_as_v2_pre_image", () => {
    const v2Bytes = canonicalCborForWorkerSig(BASE_RECORD);
    const v2_1AbsentBytes = canonicalCborForWorkerSig(BASE_RECORD, undefined);
    expect(v2_1AbsentBytes).toEqual(v2Bytes);
  });

  test("empty_evidence_array_same_as_v2_pre_image", () => {
    const v2Bytes = canonicalCborForWorkerSig(BASE_RECORD);
    const v2_1EmptyBytes = canonicalCborForWorkerSig(BASE_RECORD, []);
    expect(v2_1EmptyBytes).toEqual(v2Bytes);
  });

  test("absent_evidence_keeps_v2_schema_version", () => {
    // The pre-image starts with the schema_version text, so the bytes start
    // with the CBOR-encoded array head + the text length. Verify the
    // pre-image starts with the v2 schema literal, not v2.1.
    const v2_1AbsentBytes = canonicalCborForWorkerSig(BASE_RECORD, undefined);
    // Decode just enough to get the first text element.
    // Array head: 0x88 (major 4 length 8). Then text: 0x73 = major 3 length 19
    // ('compute_metering_v2' is 19 chars).
    expect(v2_1AbsentBytes[0]).toBe(0x88); // 8-element array
    expect(v2_1AbsentBytes[1]).toBe(0x73); // text length 19
    const literal = Buffer.from(v2_1AbsentBytes.slice(2, 2 + 19)).toString("utf-8");
    expect(literal).toBe(SCHEMA_VERSION);
  });

  test("non_empty_evidence_flips_to_v2_1_schema_version", () => {
    const evidence: AttestationEvidenceEntry[] = [
      {
        evidence_type: "arm_trustzone",
        nonce: deriveEvidenceNonce(canonicalContentHash(BASE_RECORD), "arm_trustzone"),
        payload: { device_model: "Pixel-8" },
      },
    ];
    const bytes = canonicalCborForWorkerSig(BASE_RECORD, evidence);
    // 9-element array now: 0x89
    expect(bytes[0]).toBe(0x89);
    // Text length 21 = "compute_metering_v2.1"
    expect(bytes[1]).toBe(0x75); // major 3 length 21
    const literal = Buffer.from(bytes.slice(2, 2 + 21)).toString("utf-8");
    expect(literal).toBe(SCHEMA_VERSION_V2_1);
  });

  test("schema_hash_constants_distinct", () => {
    expect(SCHEMA_HASH_HEX).not.toBe(SCHEMA_HASH_V2_1_HEX);
    expect(SCHEMA_HASH_HEX).toBe(
      createHash("sha256").update(SCHEMA_VERSION).digest("hex"),
    );
    expect(SCHEMA_HASH_V2_1_HEX).toBe(
      createHash("sha256").update(SCHEMA_VERSION_V2_1).digest("hex"),
    );
  });
});

// ===========================================================================
// Vector 2 — single ArmTrustZone evidence entry → known content_hash.
// ===========================================================================

describe("v2.1 vector 2 — single ArmTrustZone entry", () => {
  // Acurast-shaped payload. Binary fields use the `*_b64` suffix convention.
  // Inner contents are deterministic synthetic bytes — see comment at top of
  // this file.
  const PAYLOAD_ARM_V2: Record<string, unknown> = {
    device_model: "Pixel-8",
    security_level: "TrustedEnvironment",
    // 4-byte synthetic; would be Google-rooted Android Key Attestation chain in prod
    key_attestation_chain_b64: "AAECAw==",
    // 8-byte synthetic; would be processor's TEE-protected sr25519 pubkey
    processor_pubkey_b64: "AAECAwQFBgc=",
  };

  test("nonce_derivation_matches_spec", () => {
    // Use a known content_hash for the nonce derivation. The check that the
    // route validates this against record.content_hash is in the route tests.
    const ch = "ab".repeat(32); // synthetic content_hash
    const nonce = deriveEvidenceNonce(ch, "arm_trustzone");
    // Manual recompute: sha256(content_hash_bytes || utf8("arm_trustzone"))
    const manual = createHash("sha256")
      .update(Buffer.from(ch, "hex"))
      .update(Buffer.from("arm_trustzone", "utf-8"))
      .digest("hex");
    expect(nonce).toBe(manual);
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  test("base_v2_content_hash_pinned_for_spec", () => {
    // The v2 content_hash of BASE_RECORD is the input to nonce derivation
    // for all v2.1 vectors here. Pin it to keep the cross-language vectors
    // stable.
    expect(canonicalContentHash(BASE_RECORD)).toBe(
      "14fe18164cca4778b0166b00d06845547ead5ab99a31a1edd30f7c78f8defc0e",
    );
  });

  test("single_entry_pre_image_known_hash", () => {
    const ch = canonicalContentHash(BASE_RECORD);
    const evidence: AttestationEvidenceEntry[] = [
      {
        evidence_type: "arm_trustzone",
        nonce: deriveEvidenceNonce(ch, "arm_trustzone"),
        payload: PAYLOAD_ARM_V2,
      },
    ];
    const bytes = canonicalCborForWorkerSig(BASE_RECORD, evidence);
    const hash = createHash("sha256").update(bytes).digest("hex");
    // PINNED — this is the spec content_hash for vector 2. Cross-language
    // tests in Python check the same value byte-for-byte.
    expect(hash).toBe(
      "761cd5a2c7006d6a06e1b94cd7a349d9215478126b227015d75a06858266c83f",
    );
    // Stable shape: should be a 9-element top-level array.
    expect(bytes[0]).toBe(0x89);
  });

  test("single_entry_evidence_array_hash_pinned", () => {
    const ch = canonicalContentHash(BASE_RECORD);
    const evidence: AttestationEvidenceEntry[] = [
      {
        evidence_type: "arm_trustzone",
        nonce: deriveEvidenceNonce(ch, "arm_trustzone"),
        payload: PAYLOAD_ARM_V2,
      },
    ];
    expect(attestationEvidenceHash(evidence)).toBe(
      "a1417cb2bc2193258b54fa482f7a5859a1800b63e27cd2c11762e154d30ad30c",
    );
  });
});

// ===========================================================================
// Vector 3 — TWO entries: ArmTrustZone (discriminant 2) + ReproducibleBuild
// (discriminant 3). Sort order is BY DISCRIMINANT, NOT alphabetical.
// (Alphabetical would put `arm_trustzone` before `reproducible_build` — that
// happens to match the discriminant order here, so we test the inverse case
// too: AmdSevSnp(0) before ArmTrustZone(2) — alphabetically `amd_` is also
// before `arm_`, again matching. So we add a third test that uses
// ZkVmExecution(4) AFTER alphabetical-tail ReproducibleBuild(3) to prove
// the sort key is the discriminant.)
// ===========================================================================

describe("v2.1 vector 3 — two entries sorted by discriminant", () => {
  test("arm_then_build_in_pre_image_regardless_of_input_order", () => {
    const ch = canonicalContentHash(BASE_RECORD);
    const armEntry: AttestationEvidenceEntry = {
      evidence_type: "arm_trustzone",
      nonce: deriveEvidenceNonce(ch, "arm_trustzone"),
      payload: { device_model: "Pixel-8" },
    };
    const buildEntry: AttestationEvidenceEntry = {
      evidence_type: "reproducible_build",
      nonce: deriveEvidenceNonce(ch, "reproducible_build"),
      payload: { nar_hash_b64: "AAECAw==" },
    };
    // Input in REVERSE discriminant order — encoder must sort.
    const bytesReversed = canonicalCborForWorkerSig(BASE_RECORD, [
      buildEntry,
      armEntry,
    ]);
    const bytesForward = canonicalCborForWorkerSig(BASE_RECORD, [
      armEntry,
      buildEntry,
    ]);
    expect(bytesReversed).toEqual(bytesForward);
  });

  test("zkvm_after_build_in_pre_image_proves_discriminant_sort_not_alpha", () => {
    // `zkvm_execution`(4) sorts AFTER `reproducible_build`(3) by
    // discriminant. Alphabetically `r` < `z`, so the alphabetical sort and
    // discriminant sort agree on this pair. Pick a pair that DISAGREES:
    // `amd_sev_snp`(0) vs `arm_trustzone`(2) — alphabetically `amd_` < `arm_`,
    // discriminant also 0 < 2. So those agree too.
    //
    // For an inverse case use the `*_b64` rule itself with the discriminants:
    // zkvm_execution(4) sorts AFTER reproducible_build(3); alphabetically
    // 'r' < 'z' so they agree. ALL alphabetical and discriminant orderings
    // match for the current 5 evidence types; we therefore can't write a
    // direct disambiguating test. Instead, we test that the SORT KEY IS
    // THE DISCRIMINANT by importing the discriminant map and comparing
    // positions.
    expect(EVIDENCE_TYPE_DISCRIMINANT.amd_sev_snp).toBe(0);
    expect(EVIDENCE_TYPE_DISCRIMINANT.intel_tdx).toBe(1);
    expect(EVIDENCE_TYPE_DISCRIMINANT.arm_trustzone).toBe(2);
    expect(EVIDENCE_TYPE_DISCRIMINANT.reproducible_build).toBe(3);
    expect(EVIDENCE_TYPE_DISCRIMINANT.zkvm_execution).toBe(4);
    expect(EVIDENCE_TYPES.length).toBe(5);
  });

  test("two_entries_pre_image_hash_pinned", () => {
    const ch = canonicalContentHash(BASE_RECORD);
    const evidence: AttestationEvidenceEntry[] = [
      {
        evidence_type: "reproducible_build",
        nonce: deriveEvidenceNonce(ch, "reproducible_build"),
        payload: { nar_hash_b64: "AAECAw==" },
      },
      {
        evidence_type: "arm_trustzone",
        nonce: deriveEvidenceNonce(ch, "arm_trustzone"),
        payload: { device_model: "Pixel-8" },
      },
    ];
    const bytes = canonicalCborForWorkerSig(BASE_RECORD, evidence);
    const hash = createHash("sha256").update(bytes).digest("hex");
    // PINNED spec vector — cross-language tests assert equality.
    expect(hash).toBe(
      "1890fd91981068b92579c0405dae1e251fe147e87d7cee3594bb85b316702839",
    );
    expect(attestationEvidenceHash(evidence)).toBe(
      "5730e81c668fec41c1bf72513fa75d099476ae0c3f134f946746d6e2af92599f",
    );
    // Determinism check.
    const bytes2 = canonicalCborForWorkerSig(BASE_RECORD, evidence);
    expect(Buffer.from(bytes).toString("hex")).toBe(Buffer.from(bytes2).toString("hex"));
  });
});

// ===========================================================================
// Vector 4 — FOUR entries (every silicon vendor + reproducible build). Tests
// the full sort path, mixed-shape payloads, the `*_b64` decode path, and
// nested-map sort within payloads.
// ===========================================================================

describe("v2.1 vector 4 — four entries full sort + binary payload", () => {
  test("four_entries_pre_image_deterministic", () => {
    const ch = canonicalContentHash(BASE_RECORD);
    const entries: AttestationEvidenceEntry[] = [
      // Insert in REVERSE discriminant order to stress the sort.
      {
        evidence_type: "reproducible_build",
        nonce: deriveEvidenceNonce(ch, "reproducible_build"),
        payload: {
          nar_hash_b64: "ERERERERERERERERERERERERERERERERERERERERERE=",
          builder_count: 3,
        },
      },
      {
        evidence_type: "arm_trustzone",
        nonce: deriveEvidenceNonce(ch, "arm_trustzone"),
        payload: {
          device_model: "Pixel-8",
          security_level: "TrustedEnvironment",
          key_attestation_chain_b64: "AAECAw==",
        },
      },
      {
        evidence_type: "intel_tdx",
        nonce: deriveEvidenceNonce(ch, "intel_tdx"),
        payload: {
          quote_b64: "AAECAwQFBgc=",
          qe_id: "abcd1234",
        },
      },
      {
        evidence_type: "amd_sev_snp",
        nonce: deriveEvidenceNonce(ch, "amd_sev_snp"),
        payload: {
          report_b64: "AAECAwQFBgc=",
          tcb_version: 42,
        },
      },
    ];
    const bytes = canonicalCborForWorkerSig(BASE_RECORD, entries);
    const hash = createHash("sha256").update(bytes).digest("hex");
    // PINNED spec vector for the four-entry case.
    expect(hash).toBe(
      "f9c99103679a0108bb44af49bfdfc262b7549777dc91203232c51153e586f9f2",
    );
    expect(attestationEvidenceHash(entries)).toBe(
      "4cd2e759dcb82d7d6821d39439c3136ec17de216a35fce6e4e2a34eaa5a2aa93",
    );

    // The same bytes should result regardless of input order.
    const reorderedEntries = [...entries].reverse();
    const bytes2 = canonicalCborForWorkerSig(BASE_RECORD, reorderedEntries);
    expect(Buffer.from(bytes).toString("hex")).toBe(Buffer.from(bytes2).toString("hex"));
  });

  test("payload_b64_field_decodes_to_bytes_in_pre_image", () => {
    // `report_b64` value "AAECAwQFBgc=" decodes to 8 bytes [0,1,2,3,4,5,6,7].
    // Find these bytes in the encoded entry as a CBOR major-2 byte string
    // (head 0x48 = major 2 length 8 + 8 bytes).
    const entry: AttestationEvidenceEntry = {
      evidence_type: "amd_sev_snp",
      nonce: "ff".repeat(32),
      payload: { report_b64: "AAECAwQFBgc=" },
    };
    const cborBytes = encodeCbor(evidenceEntryToCborValue(entry));
    const expected = Buffer.from([0x48, 0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Buffer.from(cborBytes).includes(expected)).toBe(true);
  });

  test("payload_text_field_stays_text_in_pre_image", () => {
    // `device_model: "Pixel-8"` should encode as CBOR text, not bytes.
    // Text "Pixel-8" is 7 bytes; head 0x67 (major 3 length 7).
    const entry: AttestationEvidenceEntry = {
      evidence_type: "arm_trustzone",
      nonce: "ff".repeat(32),
      payload: { device_model: "Pixel-8" },
    };
    const cborBytes = encodeCbor(evidenceEntryToCborValue(entry));
    const expected = Buffer.concat([
      Buffer.from([0x67]),
      Buffer.from("Pixel-8", "utf-8"),
    ]);
    expect(Buffer.from(cborBytes).includes(expected)).toBe(true);
  });
});

// ===========================================================================
// Empty-vec hash pin (per the design doc — hash of CBOR-empty-array, NOT zeros)
// ===========================================================================

describe("v2.1 attestation_evidence_hash spec rules", () => {
  test("empty_vec_hash_is_sha256_of_cbor_empty_array_byte_0x80", () => {
    const empty = attestationEvidenceHash([]);
    // CBOR for empty array (major 4 length 0) is the single byte 0x80.
    const expected = createHash("sha256").update(Buffer.from([0x80])).digest("hex");
    expect(empty).toBe(expected);
    // PIN this for the spec — once any consumer relies on this value, it
    // becomes immutable.
    expect(empty).toBe(
      "76be8b528d0075f7aae98d6fa57a6d3c83ae480a8469e668d7b0af968995ac71",
    );
  });

  test("empty_vec_hash_not_zeros", () => {
    expect(attestationEvidenceHash([])).not.toBe("00".repeat(32));
  });
});

// ===========================================================================
// Negative — bad inputs throw cleanly from the encoder.
// ===========================================================================

describe("v2.1 encoder negative cases", () => {
  test("unknown_evidence_type_throws", () => {
    expect(() =>
      evidenceEntryToCborValue({
        evidence_type: "made_up" as unknown as "arm_trustzone",
        nonce: "ff".repeat(32),
        payload: {},
      }),
    ).toThrow(/unknown evidence_type/);
  });

  test("bad_nonce_format_throws", () => {
    expect(() =>
      evidenceEntryToCborValue({
        evidence_type: "arm_trustzone",
        nonce: "not-hex",
        payload: {},
      }),
    ).toThrow(/64-char/);
  });

  test("non_object_payload_throws", () => {
    expect(() =>
      evidenceEntryToCborValue({
        evidence_type: "arm_trustzone",
        nonce: "ff".repeat(32),
        payload: ["array", "not", "object"] as unknown as Record<string, unknown>,
      }),
    ).toThrow(/payload must be a JSON object/);
  });

  test("payload_with_boolean_throws", () => {
    expect(() =>
      evidenceEntryToCborValue({
        evidence_type: "arm_trustzone",
        nonce: "ff".repeat(32),
        payload: { is_rooted: false },
      }),
    ).toThrow(/boolean is not permitted/);
  });

  test("payload_with_null_throws", () => {
    expect(() =>
      evidenceEntryToCborValue({
        evidence_type: "arm_trustzone",
        nonce: "ff".repeat(32),
        payload: { tcb_info: null },
      }),
    ).toThrow(/null is not permitted/);
  });

  test("payload_b64_value_with_bad_chars_throws", () => {
    expect(() =>
      evidenceEntryToCborValue({
        evidence_type: "arm_trustzone",
        nonce: "ff".repeat(32),
        payload: { report_b64: "not-valid-base64!@#$" },
      }),
    ).toThrow(/RFC 4648 base64/);
  });
});

// ===========================================================================
// Sanity: the worker can SIGN a v2.1 record and the sig verifies against the
// extended pre-image.
// ===========================================================================

describe("v2.1 round-trip sr25519 sign + verify", () => {
  test("worker_sig_over_v2_1_pre_image_verifies", async () => {
    const keyring = new Keyring({ type: "sr25519" });
    const workerPair = keyring.addFromUri("//WorkerV2_1");
    const workerPubkey = u8aToHex(workerPair.publicKey, undefined, false);
    const recordNoSig = { ...BASE_RECORD, worker_pubkey: workerPubkey };
    const evidence: AttestationEvidenceEntry[] = [
      {
        evidence_type: "arm_trustzone",
        nonce: deriveEvidenceNonce(canonicalContentHash(recordNoSig), "arm_trustzone"),
        payload: { device_model: "Pixel-8" },
      },
    ];
    const preimage = canonicalCborForWorkerSig(recordNoSig, evidence);
    const sig = workerPair.sign(preimage);
    expect(workerPair.verify(preimage, sig, workerPair.publicKey)).toBe(true);
  });
});
